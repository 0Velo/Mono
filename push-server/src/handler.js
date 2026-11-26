import { base64urlDecode, sha256hex, verifyWalletProof } from "./crypto.js";
import { createOutboundBudget, scheduledScan } from "./monitor.js";
import { syncHeliusWebhooks } from "./helius.js";
import { parseWatchEntries, watchRecord } from "./watch.js";

const MAX_BODY = 8192;
const MAX_SUBSCRIPTIONS = 6;
const MAX_DAILY_API_OPERATIONS = 250;
const NETWORKS = new Set(["mainnet-beta", "devnet"]);
const ALLOWED_PUSH_HOSTS = ["fcm.googleapis.com", "webpush.googleapis.com", "web.push.apple.com"];
const ALLOWED_PUSH_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com"];

function response(status, body, origin, env, extra = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'",
    ...extra
  });
  if (origin && origin === env?.APP_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.APP_ORIGIN);
    headers.set("Vary", "Origin");
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function exactKeys(value, keys) {  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) throw new Error("invalid content type");
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) throw new Error("body too large");
  if (!request.body) throw new Error("missing body");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error("body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)); }
  catch { throw new Error("invalid JSON"); }
  return parsed;
}

export function validPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length < 16 || endpoint.length > 2048 || endpoint.includes("#")) return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.hash || !url.hostname) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.includes(host) || ALLOWED_PUSH_SUFFIXES.some(suffix => host.endsWith(suffix) && host.length > suffix.length);
}

function validSubscription(value) {
  if (!exactKeys(value, ["endpoint", "keys"]) || !validPushEndpoint(value.endpoint) || !exactKeys(value.keys, ["p256dh", "auth"])) return false;
  try {
    const p256dh = base64urlDecode(value.keys.p256dh);
    const auth = base64urlDecode(value.keys.auth);
    return p256dh.length === 65 && p256dh[0] === 4 && auth.length >= 16 && auth.length <= 64;
  } catch { return false; }
}

function tokenDigest(token) {
  try {
    const bytes = base64urlDecode(token);
    return bytes.length >= 32 && bytes.length <= 64 ? sha256hex(token) : Promise.resolve(null);
  } catch { return Promise.resolve(null); }
}

export async function reserveDailyOperation(kv, now) {
  const day = now.toISOString().slice(0, 10);
  const key = `control/daily-${day}`;
  const current = Number(await kv.get(key));
  if (!Number.isInteger(current) || current < 0 || current >= MAX_DAILY_API_OPERATIONS) return false;
  // The store has no compare-and-swap. This is a soft per-day guard, not an atomic quota.
  await kv.put(key, String(current + 1));
  return true;
}

/** The deployment's own origin, used to build the webhook URL Helius calls back. */
function deploymentOrigin(request) {
  try { return new URL(request.url).origin; } catch { return ""; }
}

/**
 * Mirror the active subscriptions into the Helius webhooks after a change.
 * Never throws: the webhook only makes delivery faster, and the 15-minute scan is
 * the backstop, so a Helius outage must not fail a subscribe or revoke request.
 *
 * `origin` must be the deployment's own origin (`new URL(request.url).origin`),
 * never the browser's `Origin` header — that is the app host and would point the
 * webhook at GitHub Pages.
 */
async function syncHeliusQuietly(env, kv, origin, now) {
  if (!env.HELIUS_API_KEY) return;
  try { await syncHeliusWebhooks(env, kv, { origin, now }); } catch { /* best effort */ }
}

async function handleSubscribe(request, env, kv, origin, now) {
  let body;
  try { body = await readJson(request); } catch { return response(400, { error: "invalid request" }, origin, env); }
  if (!exactKeys(body, ["subscription", "address", "network", "managementToken", "issuedAt", "signature"]) ||
      !validSubscription(body.subscription) || typeof body.address !== "string" || !NETWORKS.has(body.network) ||
      typeof body.issuedAt !== "string" || !/^\d{10}$/.test(body.issuedAt) || typeof body.signature !== "string") {
    return response(400, { error: "invalid request" }, origin, env);
  }
  const issued = Number(body.issuedAt);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issued) || Math.abs(nowSeconds - issued) > 300) return response(401, { error: "proof rejected" }, origin, env);
  const managementDigest = await tokenDigest(body.managementToken);
  if (!managementDigest) return response(400, { error: "invalid request" }, origin, env);
  if (!/^[A-Za-z0-9_-]{86}$/.test(body.signature)) return response(401, { error: "proof rejected" }, origin, env);

  let endpointHash;
  try { endpointHash = await sha256hex(body.subscription.endpoint); } catch { return response(400, { error: "invalid request" }, origin, env); }
  const canonical = `MONO-PUSH-V1\n${body.address}\n${body.network}\n${body.issuedAt}\n${endpointHash}\n${managementDigest}`;
  if (!await verifyWalletProof(body.address, body.signature, canonical)) return response(401, { error: "proof rejected" }, origin, env);

  const id = endpointHash;
  const key = `sub/${id}`;
  const oldRaw = await kv.get(key);
  let previous = null;
  if (oldRaw) {
    try { previous = JSON.parse(oldRaw); } catch { return response(409, { error: "subscription conflict" }, origin, env); }
    if (previous?.tokenDigest !== managementDigest) return response(409, { error: "subscription conflict" }, origin, env);
  }
  if (!await reserveDailyOperation(kv, now)) return response(429, { error: "temporary capacity reached" }, origin, env);
  if (!previous) {
    let list;
    try { list = await kv.list({ prefix: "sub/", limit: MAX_SUBSCRIPTIONS + 1 }); }
    catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
    if (list.keys.length >= MAX_SUBSCRIPTIONS || list.list_complete === false) return response(429, { error: "pilot capacity reached" }, origin, env);
  }
  const record = {
    version: 1, id, endpoint: body.subscription.endpoint,
    keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth },
    address: body.address, network: body.network, tokenDigest: managementDigest
  };
  try { await kv.put(key, JSON.stringify(record)); }
  catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
  // A new wallet or network on the same browser endpoint must not inherit the
  // signature window of the previous association: a transfer between two of the
  // owner's wallets would otherwise be suppressed as already notified.
  if (previous && (previous.address !== body.address || previous.network !== body.network)) {
    try { await kv.delete(`seen/${id}`); } catch { /* the store trims it by count */ }
  }
  await syncHeliusQuietly(env, kv, deploymentOrigin(request), now);
  return response(previous ? 200 : 201, { id }, origin, env);
}

async function handleDelete(request, id, env, kv, origin, now) {
  if (!/^[a-f0-9]{64}$/.test(id)) return response(404, { error: "not found" }, origin, env);
  let body;
  try { body = await readJson(request); } catch { return response(400, { error: "invalid request" }, origin, env); }
  if (!exactKeys(body, ["managementToken"])) return response(400, { error: "invalid request" }, origin, env);
  const digest = await tokenDigest(body.managementToken);
  if (!digest) return response(400, { error: "invalid request" }, origin, env);
  const key = `sub/${id}`;
  const raw = await kv.get(key);
  if (!raw) return response(404, { error: "not found" }, origin, env);
  let record;
  try { record = JSON.parse(raw); } catch { return response(404, { error: "not found" }, origin, env); }
  if (record?.tokenDigest !== digest) return response(403, { error: "forbidden" }, origin, env);
  if (!await reserveDailyOperation(kv, now)) return response(429, { error: "temporary capacity reached" }, origin, env);
  try {
    await kv.delete(key);
    await kv.delete(`state/${id}`);
    await kv.delete(`seen/${id}`);
    await kv.delete(`seen/${id}:watch`);
    await kv.delete(`watch/${id}`);
  } catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
  await syncHeliusQuietly(env, kv, deploymentOrigin(request), now);
  return response(200, { disabled: true }, origin, env);
}

/**
 * POST /v1/watch — replace this subscription's whale wallet list.
 *
 * Only public addresses and labels travel here. The management token (never
 * the wallet signature) authenticates the write, so a read-only auto-login
 * session can keep the list current without unlocking the wallet. An empty list
 * removes the record, which is also how a switch to devnet stops the mainnet
 * webhook from watching anything.
 */
async function handleWatch(request, env, kv, origin, now) {
  let body;
  try { body = await readJson(request); } catch { return response(400, { error: "invalid request" }, origin, env); }
  if (!exactKeys(body, ["id", "managementToken", "network", "entries"]) ||
      typeof body.id !== "string" || !/^[a-f0-9]{64}$/.test(body.id) ||
      typeof body.network !== "string" || !NETWORKS.has(body.network) || !Array.isArray(body.entries)) {
    return response(400, { error: "invalid request" }, origin, env);
  }
  const digest = await tokenDigest(body.managementToken);
  if (!digest) return response(400, { error: "invalid request" }, origin, env);
  const key = `sub/${body.id}`;
  const raw = await kv.get(key);
  if (!raw) return response(404, { error: "not found" }, origin, env);
  let record;
  try { record = JSON.parse(raw); } catch { return response(404, { error: "not found" }, origin, env); }
  if (record?.tokenDigest !== digest) return response(403, { error: "forbidden" }, origin, env);
  // Whale alerts live on the mainnet webhook; devnet only accepts an empty list (clearing).
  if (body.network !== record.network) return response(409, { error: "subscription conflict" }, origin, env);
  if (body.entries.length && body.network !== "mainnet-beta") return response(400, { error: "invalid request" }, origin, env);
  const entries = parseWatchEntries(body.entries, record.address);
  if (!entries) return response(400, { error: "invalid request" }, origin, env);
  if (!await reserveDailyOperation(kv, now)) return response(429, { error: "temporary capacity reached" }, origin, env);
  const watchKey = `watch/${body.id}`;
  try {
    if (entries.length) await kv.put(watchKey, watchRecord(entries, now));
    else {
      await kv.delete(watchKey);
      await kv.delete(`seen/${body.id}:watch`);
    }
  } catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
  await syncHeliusQuietly(env, kv, deploymentOrigin(request), now);
  return response(200, { watchCount: entries.filter(entry => entry.enabled).length }, origin, env);
}

/** HTTP contract shared by every deployment target: the browser-facing API. */
export async function fetchHandler(request, env, kv, now = new Date()) {
  const origin = request.headers.get("Origin");
  if (!kv || !env.APP_ORIGIN) return response(503, { error: "temporarily unavailable" }, origin, env);
  if (origin && origin !== env.APP_ORIGIN) return response(403, { error: "origin not allowed" }, origin, env);
  if (request.method === "OPTIONS") {
    if (!origin || origin !== env.APP_ORIGIN) return response(403, { error: "origin not allowed" }, origin, env);
    return response(204, null, origin, env, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600"
    });
  }
  const url = new URL(request.url);
  if (url.search || url.hash) return response(404, { error: "not found" }, origin, env);
  // `/v1/...` is the public contract; the platform routes it to `/api/v1/...`.
  const path = url.pathname === "/api" || url.pathname.startsWith("/api/")
    ? (url.pathname.slice(4) || "/")
    : url.pathname;
  if (request.method === "GET" && path === "/v1/config") {
    if (typeof env.VAPID_PUBLIC_KEY !== "string" || !env.VAPID_PUBLIC_KEY) return response(503, { error: "temporarily unavailable" }, origin, env);
    try {
      const key = base64urlDecode(env.VAPID_PUBLIC_KEY);
      if (key.length !== 65 || key[0] !== 4) throw new Error("bad key");
    } catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
    return response(200, { vapidPublicKey: env.VAPID_PUBLIC_KEY }, origin, env);
  }
  if (request.method === "POST" && path === "/v1/subscriptions") return handleSubscribe(request, env, kv, origin, now);
  if (request.method === "POST" && path === "/v1/watch") return handleWatch(request, env, kv, origin, now);
  const match = request.method === "DELETE" && path.match(/^\/v1\/subscriptions\/([a-f0-9]{64})$/);
  if (match) return handleDelete(request, match[1], env, kv, origin, now);
  return response(404, { error: "not found" }, origin, env);
}

/** Cron entry point: authenticated with the deployment secret, never reachable from the browser. */
export async function scanHandler(request, env, kv, now = new Date()) {
  const authorization = request.headers.get("authorization") || "";
  if (!env.CRON_SECRET || authorization !== `Bearer ${env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  if (!kv) {
    return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  const result = await scheduledScan({ ...env, SUBSCRIPTIONS: kv }, createOutboundBudget(50), now.toISOString());
  // The scheduled scan also re-syncs the webhook address list, so a change missed
  // by an earlier best-effort sync is corrected within 15 minutes.
  await syncHeliusQuietly(env, kv, deploymentOrigin(request), now);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
  });
}
