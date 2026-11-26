import test from "node:test";
import assert from "node:assert/strict";
import { fetchHandler } from "../src/handler.js";
import { desiredWebhookAddresses, heliusWebhookHandler } from "../src/helius.js";
import { base64urlEncode, sha256hex } from "../src/crypto.js";
import { watchPushPayload } from "../src/monitor.js";
import { MAX_WATCH_WALLETS, loadWatchEntries, parseWatchEntries, watchRecord } from "../src/watch.js";

const APP_ORIGIN = "https://app.example.test";
const WEBHOOK_SECRET = "test-webhook-secret-0f9c8b7a6d5e4c3b2a19";
const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const WHALE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const WHALE_TWO = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";
const OTHER = "3d7MmYtsHyaVZ1pVmFbNpMWpHFPAHTc9JYPW2W4gWn6S";
const SIGNATURE = "4".repeat(80);
const ID = "d".repeat(64);
const TOKEN = base64urlEncode(new Uint8Array(32).fill(7));
const OTHER_TOKEN = base64urlEncode(new Uint8Array(32).fill(9));

class FakeKV {
  constructor(entries = []) { this.data = new Map(entries); this.puts = 0; this.deletes = 0; }
  async get(key) { return this.data.get(key) ?? null; }
  async put(key, value) { this.puts++; this.data.set(key, String(value)); }
  async delete(key) { this.deletes++; this.data.delete(key); }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name }));
    return { keys, list_complete: this.data.size <= limit };
  }
}

async function makePushKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    p256dh: base64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
  };
}

async function makeVapid() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    VAPID_PUBLIC_KEY: base64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    VAPID_PRIVATE_KEY: base64urlEncode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    VAPID_SUBJECT: "mailto:prototype@example.invalid"
  };
}

async function makeRecord(overrides = {}) {
  const push = await makePushKeys();
  return {
    version: 1,
    id: ID,
    endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-watch",
    keys: { p256dh: push.p256dh, auth: push.auth },
    address: OWNER,
    network: "mainnet-beta",
    tokenDigest: await sha256hex(TOKEN),
    ...overrides
  };
}

function watchRequest(body, { origin = APP_ORIGIN, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request("https://worker.example/v1/watch", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
}

function watchBody(entries, overrides = {}) {
  return { id: ID, managementToken: TOKEN, network: "mainnet-beta", entries, ...overrides };
}

function pushRecorder() {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://fcm.googleapis.com/")) return new Response(null, { status: 201 });
    throw new Error(`unexpected outbound URL ${url}`);
  };
  return { calls, fetcher, pushes: () => calls.filter(call => call.url.startsWith("https://fcm.googleapis.com/")) };
}

test("watch entries keep only public addresses with a clean short label", () => {
  assert.deepEqual(parseWatchEntries([{ address: WHALE, label: "  고래   1 ", enabled: true }], OWNER), [
    { address: WHALE, label: "고래 1", enabled: true }
  ]);
  assert.deepEqual(parseWatchEntries([], OWNER), []);
  // Own address, duplicate, blank label, control characters and extra fields are rejected.
  assert.equal(parseWatchEntries([{ address: OWNER, label: "나", enabled: true }], OWNER), null);
  assert.equal(parseWatchEntries([
    { address: WHALE, label: "고래", enabled: true },
    { address: WHALE, label: "고래2", enabled: false }
  ], OWNER), null);
  assert.equal(parseWatchEntries([{ address: WHALE, label: "   ", enabled: true }], OWNER), null);
  assert.equal(parseWatchEntries([{ address: WHALE, label: "고\n래", enabled: true }], OWNER), null);
  assert.equal(parseWatchEntries([{ address: WHALE, label: "고래", enabled: "yes" }], OWNER), null);
  assert.equal(parseWatchEntries([{ address: WHALE, label: "고래", enabled: true, extra: 1 }], OWNER), null);
  assert.equal(parseWatchEntries([{ address: "not-a-wallet", label: "고래", enabled: true }], OWNER), null);
  assert.equal(parseWatchEntries(Array.from({ length: MAX_WATCH_WALLETS + 1 }, () => ({ address: WHALE, label: "고래", enabled: true })), OWNER), null);
});

test("POST /v1/watch stores the list for the matching management token only", async () => {
  const record = await makeRecord();
  const kv = new FakeKV([[`sub/${ID}`, JSON.stringify(record)]]);
  const env = { SUBSCRIPTIONS: kv, APP_ORIGIN };
  const entries = [
    { address: WHALE, label: "고래 1", enabled: true },
    { address: WHALE_TWO, label: "트레이더 A", enabled: false }
  ];

  const response = await fetchHandler(watchRequest(watchBody(entries)), env, kv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { watchCount: 1 });
  const stored = JSON.parse(kv.data.get(`watch/${ID}`));
  assert.equal(stored.version, 1);
  assert.equal(stored.network, "mainnet-beta");
  assert.deepEqual(stored.entries, entries);

  const wrongToken = await fetchHandler(watchRequest({ ...watchBody(entries), managementToken: OTHER_TOKEN }), env, kv);
  assert.equal(wrongToken.status, 403);
  const unknown = await fetchHandler(watchRequest({ ...watchBody(entries), id: "e".repeat(64) }), env, kv);
  assert.equal(unknown.status, 404);
  const wrongOrigin = await fetchHandler(watchRequest(watchBody(entries), { origin: "https://evil.example" }), env, kv);
  assert.equal(wrongOrigin.status, 403);
  const extraKey = await fetchHandler(watchRequest({ ...watchBody(entries), owner: OWNER }), env, kv);
  assert.equal(extraKey.status, 400);
  const ownWallet = await fetchHandler(watchRequest(watchBody([{ address: OWNER, label: "나", enabled: true }])), env, kv);
  assert.equal(ownWallet.status, 400);
  const devnetEntries = await fetchHandler(watchRequest(watchBody(entries, { network: "devnet" })), env, kv);
  assert.equal(devnetEntries.status, 409);
});

test("an empty list clears the watch record and its dedupe window", async () => {
  const record = await makeRecord();
  const kv = new FakeKV([
    [`sub/${ID}`, JSON.stringify(record)],
    [`watch/${ID}`, watchRecord([{ address: WHALE, label: "고래 1", enabled: true }])],
    [`seen/${ID}:watch`, JSON.stringify({ version: 1, signatures: [SIGNATURE] })]
  ]);
  const env = { SUBSCRIPTIONS: kv, APP_ORIGIN };
  const response = await fetchHandler(watchRequest(watchBody([])), env, kv);
  assert.equal(response.status, 200);
  assert.equal(kv.data.has(`watch/${ID}`), false);
  assert.equal(kv.data.has(`seen/${ID}:watch`), false);
  assert.deepEqual(await loadWatchEntries(kv, record), []);
});

test("revoking the subscription removes its whale list", async () => {
  const record = await makeRecord();
  const kv = new FakeKV([
    [`sub/${ID}`, JSON.stringify(record)],
    [`watch/${ID}`, watchRecord([{ address: WHALE, label: "고래 1", enabled: true }])]
  ]);
  const env = { SUBSCRIPTIONS: kv, APP_ORIGIN };
  const response = await fetchHandler(new Request(`https://worker.example/v1/subscriptions/${ID}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify({ managementToken: TOKEN })
  }), env, kv);
  assert.equal(response.status, 200);
  assert.equal(kv.data.has(`watch/${ID}`), false);
});

test("enabled whale addresses join the mainnet webhook address list", async () => {
  const record = await makeRecord();
  const kv = new FakeKV([
    [`sub/${ID}`, JSON.stringify(record)],
    [`watch/${ID}`, watchRecord([
      { address: WHALE, label: "고래 1", enabled: true },
      { address: WHALE_TWO, label: "트레이더 A", enabled: false }
    ])]
  ]);
  const desired = await desiredWebhookAddresses(kv);
  assert.deepEqual([...desired.get("mainnet-beta")].sort(), [OWNER, WHALE].sort());
  assert.deepEqual([...desired.get("devnet")], []);
  assert.deepEqual((await loadWatchEntries(kv, record)).map(entry => entry.address), [WHALE]);
});

test("a swap on a watched wallet sends one labelled push and does not repeat on retry", async () => {
  const record = await makeRecord();
  const vapid = await makeVapid();
  const kv = new FakeKV([
    [`sub/${ID}`, JSON.stringify(record)],
    [`watch/${ID}`, watchRecord([{ address: WHALE, label: "고래 1", enabled: true }])]
  ]);
  const recorder = pushRecorder();
  const env = { SUBSCRIPTIONS: kv, HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET, FETCH: recorder.fetcher, ...vapid };
  const payload = [{
    signature: SIGNATURE,
    type: "SWAP",
    nativeTransfers: [{ fromUserAccount: WHALE, toUserAccount: OTHER, amount: 5 }],
    tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WHALE, fromTokenAccount: OTHER, toTokenAccount: OTHER, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 10 }],
    accountData: []
  }];
  const request = () => new Request("https://push.example/api/webhooks/helius?network=mainnet-beta", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: WEBHOOK_SECRET },
    body: JSON.stringify(payload)
  });

  const first = await heliusWebhookHandler(request(), env, kv);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 1, duplicates: 0 });
  assert.equal(recorder.pushes().length, 1);

  const retry = await heliusWebhookHandler(request(), env, kv);
  assert.deepEqual(await retry.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 0, duplicates: 0 });
  assert.equal(recorder.pushes().length, 1);
});

test("a whale list disabled by the person sends nothing", async () => {
  const record = await makeRecord();
  const vapid = await makeVapid();
  const kv = new FakeKV([
    [`sub/${ID}`, JSON.stringify(record)],
    [`watch/${ID}`, watchRecord([{ address: WHALE, label: "고래 1", enabled: false }])]
  ]);
  const recorder = pushRecorder();
  const env = { SUBSCRIPTIONS: kv, HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET, FETCH: recorder.fetcher, ...vapid };
  const response = await heliusWebhookHandler(new Request("https://push.example/api/webhooks/helius?network=mainnet-beta", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: WEBHOOK_SECRET },
    body: JSON.stringify([{
      signature: SIGNATURE,
      type: "TRANSFER",
      nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WHALE, amount: 1 }],
      tokenTransfers: [],
      accountData: []
    }])
  }), env, kv);
  assert.deepEqual(await response.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 0, duplicates: 0 });
  assert.equal(recorder.pushes().length, 0);
});

test("whale push text names the wallet and never includes an amount", () => {
  const record = { id: ID, network: "mainnet-beta" };
  const swap = watchPushPayload(record, { address: WHALE, label: "고래 1" }, ["SOL", "token EPjFWd…"], SIGNATURE, true);
  assert.equal(swap.title, "[고래 1] 스왑 감지");
  assert.equal(swap.body, "Mainnet · SOL · token EPjFWd…");
  assert.equal(swap.url, `https://solscan.io/tx/${SIGNATURE}`);
  // Amounts stay out of the notification entirely.
  assert.equal(/\d+\.?\d*\s*SOL/.test(swap.body), false);
  const plain = watchPushPayload(record, { address: WHALE_TWO, label: "트레이더 A" }, [], SIGNATURE, false);
  assert.equal(plain.title, "[트레이더 A] 송금 감지");
  assert.equal(plain.body, "Mainnet · SOL·토큰 이동 내역");
  assert.notEqual(plain.tag, swap.tag);
});
