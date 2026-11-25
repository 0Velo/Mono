import { base64urlDecode, sha256hex, verifyWalletProof } from "./crypto.js";
import { createOutboundBudget, scheduledScan } from "./monitor.js";

const MAX_BODY = 8192;
const MAX_SUBSCRIPTIONS = 6;
const MAX_DAILY_API_OPERATIONS = 250;
const NETWORKS = new Set(["mainnet-beta", "devnet"]);
const ALLOWED_PUSH_HOSTS = ["fcm.googleapis.com", "webpush.googleapis.com", "web.push.apple.com"];
const ALLOWED_PUSH_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com"];
const encoder = new TextEncoder();

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

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
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

function validPushEndpoint(endpoint) {
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

async function reserveDailyOperation(kv, now) {
  const day = now.toISOString().slice(0, 10);
  const key = `control/daily-${day}`;
  const current = Number(await kv.get(key));
  if (!Number.isInteger(current) || current < 0 || current >= MAX_DAILY_API_OPERATIONS) return false;
  // KV is eventually consistent and has no compare-and-swap. This is a soft per-day guard,
  // not an atomic quota or abuse-prevention boundary.
  await kv.put(key, String(current + 1), { expirationTtl: 172800 });
  return true;
}

async function handleSubscribe(request, env, origin, now) {
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
  const oldRaw = await env.SUBSCRIPTIONS.get(key);
  let previous = null;
  if (oldRaw) {
    try { previous = JSON.parse(oldRaw); } catch { return response(409, { error: "subscription conflict" }, origin, env); }
    if (previous?.tokenDigest !== managementDigest) return response(409, { error: "subscription conflict" }, origin, env);
  }
  if (!await reserveDailyOperation(env.SUBSCRIPTIONS, now)) return response(429, { error: "temporary capacity reached" }, origin, env);
  if (!previous) {
    let list;
    try { list = await env.SUBSCRIPTIONS.list({ prefix: "sub/", limit: MAX_SUBSCRIPTIONS + 1 }); }
    catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
    if (list.keys.length >= MAX_SUBSCRIPTIONS || list.list_complete === false) return response(429, { error: "pilot capacity reached" }, origin, env);
  }
  const record = {
    version: 1, id, endpoint: body.subscription.endpoint,
    keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth },
    address: body.address, network: body.network, tokenDigest: managementDigest
  };
  try { await env.SUBSCRIPTIONS.put(key, JSON.stringify(record)); }
  catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
  return response(previous ? 200 : 201, { id }, origin, env);
}

async function handleDelete(request, id, env, origin, now) {
  if (!/^[a-f0-9]{64}$/.test(id)) return response(404, { error: "not found" }, origin, env);
  let body;
  try { body = await readJson(request); } catch { return response(400, { error: "invalid request" }, origin, env); }
  if (!exactKeys(body, ["managementToken"])) return response(400, { error: "invalid request" }, origin, env);
  const digest = await tokenDigest(body.managementToken);
  if (!digest) return response(400, { error: "invalid request" }, origin, env);
  const key = `sub/${id}`;
  const raw = await env.SUBSCRIPTIONS.get(key);
  if (!raw) return response(404, { error: "not found" }, origin, env);
  let record;
  try { record = JSON.parse(raw); } catch { return response(404, { error: "not found" }, origin, env); }
  if (record?.tokenDigest !== digest) return response(403, { error: "forbidden" }, origin, env);
  if (!await reserveDailyOperation(env.SUBSCRIPTIONS, now)) return response(429, { error: "temporary capacity reached" }, origin, env);
  try {
    await env.SUBSCRIPTIONS.delete(key);
    await env.SUBSCRIPTIONS.delete(`state/${id}`);
  } catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
  return response(200, { disabled: true }, origin, env);
}

async function fetchHandler(request, env, ctx) {
  const origin = request.headers.get("Origin");
  const now = new Date();
  if (!env.SUBSCRIPTIONS || !env.APP_ORIGIN) return response(503, { error: "temporarily unavailable" }, origin, env);
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
  if (request.method === "GET" && url.pathname === "/v1/config") {
    if (typeof env.VAPID_PUBLIC_KEY !== "string" || !env.VAPID_PUBLIC_KEY) return response(503, { error: "temporarily unavailable" }, origin, env);
    try {
      const key = base64urlDecode(env.VAPID_PUBLIC_KEY);
      if (key.length !== 65 || key[0] !== 4) throw new Error("bad key");
    } catch { return response(503, { error: "temporarily unavailable" }, origin, env); }
    return response(200, { vapidPublicKey: env.VAPID_PUBLIC_KEY }, origin, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/subscriptions") return handleSubscribe(request, env, origin, now);
  const match = request.method === "DELETE" && url.pathname.match(/^\/v1\/subscriptions\/([a-f0-9]{64})$/);
  if (match) return handleDelete(request, match[1], env, origin, now);
  return response(404, { error: "not found" }, origin, env);
}

export default {
  fetch(request, env, ctx) {
    return fetchHandler(request, env, ctx).catch(() => response(503, { error: "temporarily unavailable" }, request.headers.get("Origin"), env || {}));
  },
  scheduled(_event, env, ctx) {
    const run = scheduledScan(env, createOutboundBudget(50));
    if (ctx?.waitUntil) ctx.waitUntil(run);
    return run;
  }
};

export { fetchHandler, validPushEndpoint, reserveDailyOperation };
