/**
 * Helius real-time webhook bridge (입금 즉시 푸시).
 *
 * Two Helius webhooks — one per network (`enhanced` for mainnet-beta,
 * `enhancedDevnet` for devnet) — POST parsed transactions to
 * `/api/webhooks/helius?network=<network>`. This module authenticates that
 * request with the shared `HELIUS_WEBHOOK_AUTH` value, matches each event against
 * the active subscriptions in the KV store, and sends the same Web Push the
 * 15-minute scan would send, but immediately. A signature that was already
 * notified on one path is never notified again on the other (`seen/{id}`).
 *
 * The active address list is written back into Helius (`PUT /v0/webhooks/{id}`)
 * whenever a subscription is added or removed and by the scheduled scan, so the
 * dashboard webhook always mirrors the store. Helius charges 100 credits for a
 * webhook edit, so the call is skipped when the sorted address list is unchanged.
 *
 * No push endpoint, signature, address, or token is ever logged. The Helius API
 * key is read from the deployment environment only.
 */
import { sha256hex, sendWebPush } from "./crypto.js";
import {
  createOutboundBudget,
  depositPushPayload,
  loadSeenSignatures,
  rememberSeenSignatures
} from "./monitor.js";

const API_BASE = "https://api.helius.xyz";
const MAX_BODY = 512 * 1024;
const MAX_EVENTS = 50;
const MAX_SUBSCRIPTIONS = 6;
const MAX_TRACKED_SOURCES = 3;
const API_TIMEOUT_MS = 8000;
const NETWORKS = Object.freeze(["mainnet-beta", "devnet"]);
const WEBHOOK_TYPES = Object.freeze({ "mainnet-beta": "enhanced", devnet: "enhancedDevnet" });
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/;

function jsonResponse(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'",
      ...extra
    }
  });
}

export function isValidAddress(value) {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/** Constant-time comparison over SHA-256 digests, so a wrong secret leaks no prefix. */
export async function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const [left, right] = await Promise.all([sha256hex(provided), sha256hex(expected)]);
  let diff = provided.length === expected.length ? 0 : 1;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function readBoundedJson(request, maxBytes) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType && !/^application\/json/i.test(contentType)) throw new Error("invalid content type");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("body too large");
  if (!request.body) throw new Error("missing body");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid JSON"); }
  return parsed;
}

/** `?network=devnet` (or `mainnet`) — the hint each webhook URL carries. */
export function parseNetworkHint(url) {
  const value = url.searchParams.get("network");
  if (!value) return null;
  const normalized = value === "mainnet" ? "mainnet-beta" : value;
  return NETWORKS.includes(normalized) ? normalized : null;
}

/**
 * Reduce one Helius enhanced (or raw) transaction to the fields the matcher
 * needs. Failed transactions never move balances, so they are dropped.
 */
export function normalizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const signature = typeof value.signature === "string" ? value.signature : "";
  if (!SIGNATURE_PATTERN.test(signature)) return null;
  if (value.transactionError) return null;
  const objects = (list) => (Array.isArray(list) ? list.filter(item => item && typeof item === "object") : []);
  return {
    signature,
    type: typeof value.type === "string" ? value.type : "",
    nativeTransfers: objects(value.nativeTransfers),
    tokenTransfers: objects(value.tokenTransfers),
    accountData: objects(value.accountData)
  };
}

function positiveDelta(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value) > 0n;
  return false;
}

/**
 * Direction of one event for one tracked wallet. `incoming` is what the app
 * notifies (a deposit, including the receiving leg of a swap); a pure outflow is
 * recognised so the caller can keep it out of the notification path.
 */
export function classifyEvent(event, address, tokenAccounts = []) {
  const trackedTokens = new Set(tokenAccounts.filter(isValidAddress));
  const toTracked = (transfer) => transfer.toUserAccount === address || trackedTokens.has(transfer.toTokenAccount);
  const fromTracked = (transfer) => transfer.fromUserAccount === address || trackedTokens.has(transfer.fromTokenAccount);

  let incomingSol = false;
  let outgoingSol = false;
  for (const transfer of event.nativeTransfers) {
    if (toTracked(transfer) && !fromTracked(transfer)) incomingSol = true;
    else if (fromTracked(transfer) && !toTracked(transfer)) outgoingSol = true;
  }

  const incomingMints = new Set();
  const outgoingMints = new Set();
  for (const transfer of event.tokenTransfers) {
    if (typeof transfer.mint !== "string" || !transfer.mint) continue;
    const incoming = toTracked(transfer);
    const outgoing = fromTracked(transfer);
    if (incoming && !outgoing) incomingMints.add(transfer.mint);
    else if (outgoing && !incoming) outgoingMints.add(transfer.mint);
  }

  // Raw webhooks carry balance deltas instead of named transfers.
  for (const entry of event.accountData) {
    if (entry.account === address && positiveDelta(entry.nativeBalanceChange)) incomingSol = true;
    if (!Array.isArray(entry.tokenBalanceChanges)) continue;
    for (const change of entry.tokenBalanceChanges) {
      if (!change || typeof change.mint !== "string") continue;
      const ownsAccount = change.userAccount === address || trackedTokens.has(change.tokenAccount);
      if (!ownsAccount) continue;
      const raw = change.rawTokenAmount?.tokenAmount;
      if (typeof raw === "string" && /^-?\d+$/.test(raw) && BigInt(raw) > 0n) incomingMints.add(change.mint);
    }
  }

  const assets = [];
  if (incomingSol) assets.push("SOL");
  for (const mint of incomingMints) assets.push(`token ${mint.slice(0, 6)}…`);

  const swap = /SWAP/i.test(event.type);
  if (!assets.length) return { assets: [], incoming: false, outgoing: outgoingSol || outgoingMints.size > 0, swap };
  return { assets: assets.slice(0, 4), incoming: true, outgoing: outgoingSol || outgoingMints.size > 0, swap };
}

async function readJsonKey(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Token accounts the scan already tracks for this subscription (bounded, validated). */
export async function subscriptionTokenAccounts(kv, record) {
  const state = await readJsonKey(kv, `state/${record.id}`);
  if (!state || !Array.isArray(state.sources)) return [];
  return state.sources
    .map(source => source?.address)
    .filter(address => isValidAddress(address) && address !== record.address)
    .slice(0, MAX_TRACKED_SOURCES - 1);
}

async function loadSubscriptions(kv, hint) {
  let listing;
  try { listing = await kv.list({ prefix: "sub/", limit: MAX_SUBSCRIPTIONS + 1 }); }
  catch { return []; }
  if (listing.keys.length > MAX_SUBSCRIPTIONS || listing.list_complete === false) return [];
  const subscriptions = [];
  for (const { name } of listing.keys) {
    const raw = await kv.get(name).catch(() => null);
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    if (record?.version !== 1 || name !== `sub/${record.id}`) continue;
    if (!NETWORKS.includes(record.network) || !isValidAddress(record.address)) continue;
    if (hint && record.network !== hint) continue;
    const tokenAccounts = await subscriptionTokenAccounts(kv, record);
    subscriptions.push({ record, id: record.id, address: record.address, network: record.network, tokenAccounts });
  }
  return subscriptions;
}

/**
 * Everything the two webhooks should watch: each subscription's wallet plus the
 * token accounts the scan learned for it (incoming SPL transfers name the token
 * account, not the owner, so the owner alone would miss them).
 */
export async function desiredWebhookAddresses(kv) {
  const desired = new Map(NETWORKS.map(network => [network, new Set()]));
  let listing;
  try { listing = await kv.list({ prefix: "sub/", limit: MAX_SUBSCRIPTIONS + 1 }); }
  catch { return desired; }
  if (listing.keys.length > MAX_SUBSCRIPTIONS || listing.list_complete === false) return desired;
  for (const { name } of listing.keys) {
    const raw = await kv.get(name).catch(() => null);
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    if (record?.version !== 1 || name !== `sub/${record.id}`) continue;
    if (!NETWORKS.includes(record.network) || !isValidAddress(record.address)) continue;
    const bucket = desired.get(record.network);
    bucket.add(record.address);
    for (const tokenAccount of await subscriptionTokenAccounts(kv, record)) bucket.add(tokenAccount);
  }
  return desired;
}

function sameAddresses(cached, next) {
  if (!Array.isArray(cached) || cached.length !== next.length) return false;
  const left = [...cached].sort();
  const right = [...next].sort();
  return left.every((value, index) => value === right[index]);
}

function plainWebhookUrl(env, origin, network) {
  const configured = typeof env.HELIUS_WEBHOOK_URL === "string" && env.HELIUS_WEBHOOK_URL
    ? env.HELIUS_WEBHOOK_URL
    : (origin ? `${origin}/api/webhooks/helius` : "");
  if (!configured) return "";
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return "";
    url.searchParams.set("network", network);
    return url.toString();
  } catch { return ""; }
}

async function heliusRequest(env, path, init = {}) {
  const fetcher = env.FETCH || fetch;
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("api-key", env.HELIUS_API_KEY || "");
  const response = await fetcher(url.toString(), {
    method: init.method || "GET",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  if (response.status === 404) return { status: 404, data: null };
  if (!response.ok) return { status: response.status, data: null };
  if (init.method === "PUT" || init.method === "POST") {
    return { status: response.status, data: null };
  }
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data };
}

async function listWebhooks(env) {
  const result = await heliusRequest(env, "/v0/webhooks");
  if (result.status !== 200 || !Array.isArray(result.data)) return null;
  return result.data;
}

function webhookMatches(item, url, network) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.webhookURL !== "string" || item.webhookURL !== url) return false;
  const type = typeof item.webhookType === "string" ? item.webhookType : "";
  return type === WEBHOOK_TYPES[network];
}

/**
 * Keep the Helius webhook's `accountAddresses` list equal to the active
 * subscriptions. Best effort by design: the 15-minute scan remains the backstop,
 * so a Helius outage must never fail a subscribe/revoke request.
 */
export async function syncHeliusWebhooks(env, kv, { origin = "", now = new Date() } = {}) {
  if (!env.HELIUS_API_KEY || !env.HELIUS_WEBHOOK_AUTH) return { synced: [], reason: "not configured" };
  const desired = await desiredWebhookAddresses(kv);
  const synced = [];
  for (const network of NETWORKS) {
    const addresses = [...desired.get(network)].sort();
    if (!addresses.length) { synced.push({ network, status: "no-subscriptions" }); continue; }
    const webhookURL = plainWebhookUrl(env, origin, network);
    if (!webhookURL) { synced.push({ network, status: "no-url" }); continue; }
    const cacheKey = `control/helius-${network}`;
    const cached = await readJsonKey(kv, cacheKey);
    const envId = (network === "mainnet-beta" ? env.HELIUS_WEBHOOK_ID : env.HELIUS_WEBHOOK_ID_DEVNET) || "";
    let webhookId = envId || (typeof cached?.webhookId === "string" ? cached.webhookId : "");
    try {
      if (!webhookId) {
        const found = await listWebhooks(env);
        if (!found) { synced.push({ network, status: "list-failed" }); continue; }
        const match = found.find(item => webhookMatches(item, webhookURL, network));
        webhookId = typeof match?.webhookID === "string" ? match.webhookID : "";
        if (!webhookId) {
          const created = await heliusRequest(env, "/v0/webhooks", {
            method: "POST",
            body: {
              webhookURL,
              transactionTypes: ["ANY"],
              accountAddresses: addresses,
              webhookType: WEBHOOK_TYPES[network],
              authHeader: env.HELIUS_WEBHOOK_AUTH
            }
          });
          if (created.status !== 200 || typeof created.data?.webhookID !== "string") {
            synced.push({ network, status: `create-failed:${created.status}` });
            continue;
          }
          webhookId = created.data.webhookID;
          await kv.put(cacheKey, JSON.stringify({ version: 1, webhookId, addresses, syncedAt: now.toISOString() }));
          synced.push({ network, status: "created" });
          continue;
        }
      }
      if (cached?.webhookId === webhookId && sameAddresses(cached.addresses, addresses)) {
        synced.push({ network, status: "unchanged" });
        continue;
      }
      const body = {
        webhookURL,
        transactionTypes: ["ANY"],
        accountAddresses: addresses,
        webhookType: WEBHOOK_TYPES[network],
        authHeader: env.HELIUS_WEBHOOK_AUTH
      };
      let updated = await heliusRequest(env, `/v0/webhooks/${encodeURIComponent(webhookId)}`, { method: "PUT", body });
      if (updated.status === 404 && !envId) {
        // A stale cached id: rediscover through the list and try once more.
        const found = await listWebhooks(env);
        const match = found?.find(item => webhookMatches(item, webhookURL, network));
        if (typeof match?.webhookID === "string" && match.webhookID !== webhookId) {
          webhookId = match.webhookID;
          updated = await heliusRequest(env, `/v0/webhooks/${encodeURIComponent(webhookId)}`, { method: "PUT", body });
        }
      }
      if (updated.status !== 200) { synced.push({ network, status: `update-failed:${updated.status}` }); continue; }
      await kv.put(cacheKey, JSON.stringify({ version: 1, webhookId, addresses, syncedAt: now.toISOString() }));
      synced.push({ network, status: "updated" });
    } catch {
      synced.push({ network, status: "error" });
    }
  }
  return { synced };
}

/**
 * POST /api/webhooks/helius?network=… — authenticated Helius delivery.
 *
 * One push per affected subscription per delivery: a batch that touches the same
 * wallet twice must not buzz the phone twice.
 */
export async function heliusWebhookHandler(request, env, kv, now = new Date()) {
  if (!env.HELIUS_WEBHOOK_AUTH) return jsonResponse(503, { error: "temporarily unavailable" });
  if (!kv) return jsonResponse(503, { error: "temporarily unavailable" });
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" }, { Allow: "POST" });
  }
  const authorization = request.headers.get("authorization") || "";
  if (!await secretMatches(authorization, env.HELIUS_WEBHOOK_AUTH)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  let payload;
  try { payload = await readBoundedJson(request, MAX_BODY); }
  catch { return jsonResponse(400, { error: "invalid request" }); }

  const hint = parseNetworkHint(new URL(request.url));
  const rawEvents = Array.isArray(payload) ? payload : [payload];
  const events = rawEvents.slice(0, MAX_EVENTS).map(normalizeEvent).filter(Boolean);
  if (!events.length) return jsonResponse(200, { ok: true, received: 0, pushed: 0, duplicates: 0 });

  let subscriptions;
  try { subscriptions = await loadSubscriptions(kv, hint); }
  catch { return jsonResponse(503, { error: "temporarily unavailable" }); }

  const budget = createOutboundBudget(MAX_SUBSCRIPTIONS + 1);
  let pushed = 0;
  let duplicates = 0;
  let matched = 0;
  for (const subscription of subscriptions) {
    let seen;
    try { seen = await loadSeenSignatures(kv, subscription.id); }
    catch { continue; }
    const fresh = new Set();
    const assets = new Set();
    let latest = null;
    for (const event of events) {
      const match = classifyEvent(event, subscription.address, subscription.tokenAccounts);
      if (!match.incoming) continue;
      if (seen.has(event.signature)) { duplicates += 1; continue; }
      fresh.add(event.signature);
      latest = event.signature;
      for (const asset of match.assets) assets.add(asset);
    }
    if (!fresh.size) continue;
    matched += 1;
    // Mark first: a Helius retry of the same delivery must not notify twice.
    try { await rememberSeenSignatures(kv, subscription.id, [...fresh]); } catch { /* scan backstop re-checks */ }
    try {
      const response = await sendWebPush(
        subscription.record,
        depositPushPayload(subscription.record, [...assets], latest),
        env,
        env.FETCH || fetch,
        budget
      );
      if (response.ok || response.status < 300) pushed += 1;
    } catch { /* delivery is best effort; the scan remains the backstop */ }
  }
  return jsonResponse(200, { ok: true, received: events.length, matched, pushed, duplicates });
}
