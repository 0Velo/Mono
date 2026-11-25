import { sendWebPush } from "./crypto.js";

export const RPC = Object.freeze({
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com"
});
export const TOKEN_PROGRAMS = Object.freeze([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const MAX_SOURCES = 3; // wallet plus at most two token accounts (one per token program).
const SIGNATURE_PAGE = 5;
const MAX_NEW_SIGNATURES_PER_SOURCE = 2;
const RESPONSE_LIMIT = 1_000_000;

async function readBoundedText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("RPC response exceeded limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createOutboundBudget(max = 50) {
  let used = 0;
  return {
    take() { if (used >= max) return false; used++; return true; },
    get used() { return used; },
    get remaining() { return max - used; }
  };
}

async function rpc(env, network, budget, method, params) {
  const endpoint = RPC[network];
  if (!endpoint) throw new Error("unsupported network");
  if (!budget.take()) throw new Error("outbound request budget exhausted");
  const fetcher = env.FETCH || fetch;
  const response = await fetcher(endpoint, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || response.status >= 300) throw new Error("RPC request failed");
  const text = await readBoundedText(response, RESPONSE_LIMIT);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("invalid RPC response"); }
  if (data.error || !Object.hasOwn(data, "result")) throw new Error("RPC returned an error");
  return data.result;
}

async function callRpc(env, network, budget, method, params) {
  // Keep RPC destinations in this module; neither request data nor stored state supplies a URL.
  return rpc(env, network, budget, method, params);
}

async function discoverTokenSources(env, network, address, budget) {
  const selected = [];
  for (const programId of TOKEN_PROGRAMS) {
    const result = await callRpc(env, network, budget, "getTokenAccountsByOwner", [
      address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }
    ]);
    if (!result || !Array.isArray(result.value)) throw new Error("invalid token account discovery response");
    const first = result.value.find(entry => typeof entry?.pubkey === "string");
    if (first) selected.push(first.pubkey);
  }
  return selected;
}

async function signaturesFor(env, network, source, budget) {
  const result = await callRpc(env, network, budget, "getSignaturesForAddress", [
    source, { limit: SIGNATURE_PAGE, commitment: "confirmed" }
  ]);
  if (!Array.isArray(result) || result.some(row => typeof row?.signature !== "string")) throw new Error("invalid signature response");
  return result;
}

async function transactionFor(env, network, signature, budget) {
  const tx = await callRpc(env, network, budget, "getTransaction", [
    signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  ]);
  if (!tx || !tx.meta || !tx.transaction?.message) throw new Error("transaction metadata unavailable");
  return tx;
}

function keyString(key) { return typeof key === "string" ? key : key?.pubkey; }

export function detectDeposits(tx, owner, tokenAccountAddresses = []) {
  const deposits = [];
  const keys = (tx.transaction.message.accountKeys || []).map(keyString);
  const trackedAccounts = new Set(tokenAccountAddresses);
  const index = keys.indexOf(owner);
  if (index >= 0 && Array.isArray(tx.meta.preBalances) && Array.isArray(tx.meta.postBalances)) {
    const delta = BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0);
    if (delta > 0n) deposits.push({ asset: "SOL", rawAmount: delta.toString() });
  }
  const before = new Map();
  for (const item of tx.meta.preTokenBalances || []) {
    const account = Number.isInteger(item.accountIndex) ? keys[item.accountIndex] : null;
    if ((item.owner === owner || trackedAccounts.has(account)) && item.mint) before.set(item.mint, (before.get(item.mint) || 0n) + BigInt(item.uiTokenAmount?.amount || "0"));
  }
  const after = new Map();
  for (const item of tx.meta.postTokenBalances || []) {
    const account = Number.isInteger(item.accountIndex) ? keys[item.accountIndex] : null;
    if ((item.owner === owner || trackedAccounts.has(account)) && item.mint) after.set(item.mint, (after.get(item.mint) || 0n) + BigInt(item.uiTokenAmount?.amount || "0"));
  }
  for (const [mint, amount] of after) {
    const delta = amount - (before.get(mint) || 0n);
    if (delta > 0n) deposits.push({ asset: "SPL", mint, rawAmount: delta.toString() });
  }
  return deposits;
}

function decodeState(raw) {
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !Array.isArray(state.sources) || state.sources.length < 1 || state.sources.length > MAX_SOURCES ||
        state.sources.some(source => !source || typeof source.address !== "string" ||
          !(source.cursor === null || typeof source.cursor === "string") ||
          (source.baselinePending !== undefined && typeof source.baselinePending !== "boolean"))) return null;
    return state;
  } catch { return null; }
}

async function scanSubscription(env, kv, record, budget, now) {
  const network = record.network;
  const currentTokenSources = await discoverTokenSources(env, network, record.address, budget);
  const stateKey = `state/${record.id}`;
  const rawState = await kv.get(stateKey);
  const prior = decodeState(rawState);
  if (rawState && !prior) throw new Error("monitor state is invalid");

  if (!prior || prior.address !== record.address || prior.network !== network) {
    const sources = [record.address, ...currentTokenSources].slice(0, MAX_SOURCES);
    const baselines = [];
    for (const source of sources) {
      const rows = await signaturesFor(env, network, source, budget);
      baselines.push({ address: source, cursor: rows[0]?.signature || null });
    }
    const baseline = { version: 1, address: record.address, network, sources: baselines, initializedAt: now };
    await kv.put(stateKey, JSON.stringify(baseline));
    return;
  }

  const sources = prior.sources.filter(s => s && typeof s.address === "string").slice(0, MAX_SOURCES);
  if (!sources.some(source => source.address === record.address)) throw new Error("wallet cursor missing from monitor state");
  // Add newly observed token accounts only when source slots are available. Old account cursors
  // are retained to keep monitoring accounts that have since closed, up to this strict bound.
  for (const address of currentTokenSources) {
    if (sources.length >= MAX_SOURCES) break;
    if (!sources.some(s => s.address === address)) sources.push({ address, cursor: null, baselinePending: true });
  }
  const cursorUpdates = new Map();
  const discovered = new Map();
  for (const source of sources) {
    const rows = await signaturesFor(env, network, source.address, budget);
    if (source.baselinePending || !source.cursor) {
      cursorUpdates.set(source.address, rows[0]?.signature || null);
      discovered.set(source.address, []);
      continue;
    }
    const cursorIndex = rows.findIndex(row => row.signature === source.cursor);
    if (cursorIndex < 0) {
      if (rows.length === SIGNATURE_PAGE) throw new Error("signature cursor fell outside bounded page");
      // Cursor not present and no full page: provider history may have pruned it; do not silently reset.
      throw new Error("signature cursor unavailable");
    }
    const newer = rows.slice(0, cursorIndex);
    if (newer.length > MAX_NEW_SIGNATURES_PER_SOURCE) throw new Error("signature backlog exceeds per-scan bound");
    discovered.set(source.address, newer.slice().reverse());
    cursorUpdates.set(source.address, newer.length ? newer[0].signature : source.cursor);
  }

  const uniqueSignatures = new Map();
  for (const rows of discovered.values()) for (const row of rows) uniqueSignatures.set(row.signature, row);
  const trackedTokenAccounts = sources.map(source => source.address).filter(address => address !== record.address);
  const deposits = [];
  for (const signature of uniqueSignatures.keys()) {
    const tx = await transactionFor(env, network, signature, budget);
    for (const item of detectDeposits(tx, record.address, trackedTokenAccounts)) deposits.push({ ...item, signature });
  }

  if (deposits.length) {
    const assets = [...new Set(deposits.map(d => d.asset === "SPL" ? `token ${d.mint.slice(0, 6)}…` : "SOL"))];
    const response = await sendWebPush(record, {
      title: "Deposit detected",
      body: `${network}: incoming balance change (${assets.join(", ")}).`,
      tag: `mono-push-${record.id}`
    }, env, env.FETCH || fetch, budget);
    if (!response.ok || response.status >= 300) throw new Error("push delivery failed");
  }

  const next = {
    version: 1, address: record.address, network,
    sources: sources.map(source => ({ address: source.address, cursor: cursorUpdates.get(source.address) ?? source.cursor })),
    initializedAt: prior.initializedAt || now,
    scannedAt: now
  };
  await kv.put(stateKey, JSON.stringify(next));
}

function jsonError(message) { return new Response(JSON.stringify({ error: message }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }

export async function scheduledScan(env, budget = createOutboundBudget(50), now = new Date().toISOString()) {
  const kv = env.SUBSCRIPTIONS;
  const listing = await kv.list({ prefix: "sub/", limit: 7 });
  if (listing.keys.length > 6 || listing.list_complete === false) return { scanned: 0, errors: 1 };
  const keys = listing.keys.map(k => k.name).sort();
  if (!keys.length) return { scanned: 0, errors: 0 };
  const rotationKey = "control/rotation";
  const rotation = Number(await kv.get(rotationKey)) || 0;
  const start = rotation % keys.length;
  const batch = Array.from({ length: Math.min(3, keys.length) }, (_, i) => keys[(start + i) % keys.length]);
  await kv.put(rotationKey, String((start + batch.length) % keys.length));
  let scanned = 0;
  let errors = 0;
  for (const key of batch) {
    if (budget.remaining < 12) { errors++; break; }
    try {
      const raw = await kv.get(key);
      if (!raw) continue;
      const record = JSON.parse(raw);
      if (record?.version !== 1 || key !== `sub/${record.id}`) throw new Error("invalid subscription record");
      await scanSubscription(env, kv, record, budget, now);
      scanned++;
    } catch {
      // Intentionally no endpoint, signature, token, RPC body, or exception detail is logged.
      errors++;
    }
  }
  return { scanned, errors };
}
