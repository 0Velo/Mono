import test from "node:test";
import assert from "node:assert/strict";
import { base64urlEncode, sha256hex } from "../src/crypto.js";
import {
  classifyEvent,
  desiredWebhookAddresses,
  heliusWebhookHandler,
  normalizeEvent,
  parseNetworkHint,
  secretMatches,
  syncHeliusWebhooks
} from "../src/helius.js";
import { createOutboundBudget, loadSeenSignatures, rememberSeenSignatures, scheduledScan } from "../src/monitor.js";

const enc = new TextEncoder();
const WEBHOOK_SECRET = "test-webhook-secret-0f9c8b7a6d5e4c3b2a19";
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const TOKEN_ACCOUNT = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";
const SIGNATURE = "3".repeat(80);

function base58Encode(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let s = "";
  while (n > 0n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + (s || (zeros ? "" : "1"));
}

class FakeKV {
  constructor(entries = []) { this.data = new Map(entries); this.puts = 0; }
  async get(key) { return this.data.get(key) ?? null; }
  async put(key, value) { this.puts++; this.data.set(key, String(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name }));
    return { keys, list_complete: this.data.size <= limit };
  }
}

async function makeWallet() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return { pair, address: base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}

async function makePushKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    pair,
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

async function makeSubscription(overrides = {}) {
  const push = await makePushKeys();
  const id = "c".repeat(64);
  return {
    version: 1,
    id,
    endpoint: "https://fcm.googleapis.com/fcm/send/synthetic",
    keys: { p256dh: push.p256dh, auth: push.auth },
    address: WALLET,
    network: "mainnet-beta",
    tokenDigest: "digest",
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    signature: SIGNATURE,
    type: "TRANSFER",
    nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, amount: 1_000_000 }],
    tokenTransfers: [],
    accountData: [],
    ...overrides
  };
}

function webhookRequest(body, { authorization = WEBHOOK_SECRET, network = "mainnet-beta", method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;
  const url = `https://push.example/api/webhooks/helius${network ? `?network=${network}` : ""}`;
  return new Request(url, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined });
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

test("webhook secret comparison accepts only the exact value", async () => {
  assert.equal(await secretMatches(WEBHOOK_SECRET, WEBHOOK_SECRET), true);
  assert.equal(await secretMatches(`${WEBHOOK_SECRET}x`, WEBHOOK_SECRET), false);
  assert.equal(await secretMatches(WEBHOOK_SECRET.slice(0, -1), WEBHOOK_SECRET), false);
  assert.equal(await secretMatches("", WEBHOOK_SECRET), false);
  assert.equal(await secretMatches(WEBHOOK_SECRET, ""), false);
});

test("network hint and event normalization reject what cannot be attributed", () => {
  assert.equal(parseNetworkHint(new URL("https://x/api/webhooks/helius?network=devnet")), "devnet");
  assert.equal(parseNetworkHint(new URL("https://x/api/webhooks/helius?network=mainnet")), "mainnet-beta");
  assert.equal(parseNetworkHint(new URL("https://x/api/webhooks/helius?network=testnet")), null);
  assert.equal(parseNetworkHint(new URL("https://x/api/webhooks/helius")), null);
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({ signature: "short" }), null);
  assert.equal(normalizeEvent({ signature: SIGNATURE, transactionError: { InstructionError: [] } }), null);
  const normalized = normalizeEvent(event());
  assert.equal(normalized.signature, SIGNATURE);
  assert.equal(normalized.nativeTransfers.length, 1);
});

test("event classification separates incoming, swap and pure outflow", () => {
  const incoming = classifyEvent(normalizeEvent(event()), WALLET);
  assert.deepEqual(incoming.assets, ["SOL"]);
  assert.equal(incoming.incoming, true);

  const outflow = classifyEvent(normalizeEvent(event({
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 5 }]
  })), WALLET);
  assert.deepEqual(outflow.assets, []);
  assert.equal(outflow.incoming, false);
  assert.equal(outflow.outgoing, true);

  const swap = classifyEvent(normalizeEvent(event({
    type: "SWAP",
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 5 }],
    tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, fromTokenAccount: OTHER, toTokenAccount: TOKEN_ACCOUNT, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 10 }]
  })), WALLET);
  assert.equal(swap.incoming, true);
  assert.equal(swap.outgoing, true);
  assert.equal(swap.assets.length, 1);
  assert.match(swap.assets[0], /^token EPjFWd…$/);

  // Incoming SPL names the owner, or the token account when only that is tracked.
  const tokenByOwner = classifyEvent(normalizeEvent(event({
    nativeTransfers: [],
    tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, fromTokenAccount: OTHER, toTokenAccount: TOKEN_ACCOUNT, mint: "mint", tokenAmount: 1 }]
  })), WALLET);
  assert.equal(tokenByOwner.incoming, true);
  const tokenByAccount = classifyEvent(normalizeEvent(event({
    nativeTransfers: [],
    tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: "someone", fromTokenAccount: OTHER, toTokenAccount: TOKEN_ACCOUNT, mint: "mint", tokenAmount: 1 }]
  })), WALLET, [TOKEN_ACCOUNT]);
  assert.equal(tokenByAccount.incoming, true);

  // Raw payload shape: balance deltas only.
  const raw = classifyEvent(normalizeEvent(event({
    nativeTransfers: [],
    accountData: [
      { account: WALLET, nativeBalanceChange: 12, tokenBalanceChanges: [] },
      { account: TOKEN_ACCOUNT, nativeBalanceChange: 0, tokenBalanceChanges: [{ mint: "mint", tokenAccount: TOKEN_ACCOUNT, userAccount: WALLET, rawTokenAmount: { decimals: 6, tokenAmount: "25" } }] }
    ]
  })), WALLET);
  assert.equal(raw.incoming, true);
  assert.equal(raw.assets.length, 2);
});

test("webhook endpoint fails closed without its secret and refuses wrong authorization", async () => {
  const kv = new FakeKV();
  const record = await makeSubscription();
  kv.data.set(`sub/${record.id}`, JSON.stringify(record));
  const env = { SUBSCRIPTIONS: kv };

  const unconfigured = await heliusWebhookHandler(webhookRequest([event()]), env, kv);
  assert.equal(unconfigured.status, 503);

  const configured = { ...env, HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET };
  assert.equal((await heliusWebhookHandler(webhookRequest([event()], { authorization: "" }), configured, kv)).status, 401);
  assert.equal((await heliusWebhookHandler(webhookRequest([event()], { authorization: "nope" }), configured, kv)).status, 401);
  assert.equal((await heliusWebhookHandler(webhookRequest([event()], { method: "GET", authorization: WEBHOOK_SECRET }), configured, kv)).status, 405);
  assert.equal((await heliusWebhookHandler(webhookRequest([event()], { authorization: WEBHOOK_SECRET }), { ...configured, SUBSCRIPTIONS: null }, null)).status, 503);
});

test("authorized delivery pushes once, dedupes a retry, and ignores unrelated or outgoing events", async () => {
  const record = await makeSubscription();
  const vapid = await makeVapid();
  const kv = new FakeKV([[`sub/${record.id}`, JSON.stringify(record)]]);
  const recorder = pushRecorder();
  const env = { SUBSCRIPTIONS: kv, HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET, FETCH: recorder.fetcher, ...vapid };

  const delivered = await heliusWebhookHandler(webhookRequest([event()]), env, kv);
  assert.equal(delivered.status, 200);
  assert.deepEqual(await delivered.json(), { ok: true, received: 1, matched: 1, pushed: 1, watchPushed: 0, duplicates: 0 });
  assert.equal(recorder.pushes().length, 1);
  assert.equal(recorder.pushes()[0].init.headers["Content-Encoding"], "aes128gcm");
  assert.ok((await loadSeenSignatures(kv, record.id)).has(SIGNATURE));

  const retried = await heliusWebhookHandler(webhookRequest([event()]), env, kv);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 0, duplicates: 1 });
  assert.equal(recorder.pushes().length, 1);

  const unrelated = await heliusWebhookHandler(webhookRequest([event({
    signature: "4".repeat(80),
    nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: OTHER, amount: 1 }]
  })]), env, kv);
  assert.deepEqual(await unrelated.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 0, duplicates: 0 });

  const outgoing = await heliusWebhookHandler(webhookRequest([event({
    signature: "5".repeat(80),
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 1 }]
  })]), env, kv);
  assert.deepEqual(await outgoing.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 0, duplicates: 0 });
  assert.equal(recorder.pushes().length, 1);

  const devnetOnly = await heliusWebhookHandler(webhookRequest([event({ signature: "6".repeat(80) })], { network: "devnet" }), env, kv);
  assert.deepEqual(await devnetOnly.json(), { ok: true, received: 1, matched: 0, pushed: 0, watchPushed: 0, duplicates: 0 });
  assert.equal(recorder.pushes().length, 1);
});

test("a batch touching one wallet twice sends a single push", async () => {
  const record = await makeSubscription();
  const vapid = await makeVapid();
  const kv = new FakeKV([[`sub/${record.id}`, JSON.stringify(record)]]);
  const recorder = pushRecorder();
  const env = { SUBSCRIPTIONS: kv, HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET, FETCH: recorder.fetcher, ...vapid };
  const response = await heliusWebhookHandler(webhookRequest([
    event({ signature: "7".repeat(80) }),
    event({ signature: "8".repeat(80) })
  ]), env, kv);
  assert.deepEqual(await response.json(), { ok: true, received: 2, matched: 1, pushed: 1, watchPushed: 0, duplicates: 0 });
  assert.equal(recorder.pushes().length, 1);
  const seen = await loadSeenSignatures(kv, record.id);
  assert.equal(seen.size, 2);
});

test("the seen window is bounded and keeps the newest signatures", async () => {
  const kv = new FakeKV();
  const id = "d".repeat(64);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const signatures = Array.from({ length: 45 }, (_, index) => alphabet[index].repeat(80));
  await rememberSeenSignatures(kv, id, signatures);
  const seen = await loadSeenSignatures(kv, id);
  assert.equal(seen.size, 40);
  assert.equal(seen.has(signatures[0]), false);
  assert.equal(seen.has(signatures[44]), true);
});

test("the scheduled scan stays quiet for a signature the webhook already notified", async () => {
  const record = await makeSubscription();
  const vapid = await makeVapid();
  const tokenAccount = TOKEN_ACCOUNT;
  const prior = {
    version: 1, address: record.address, network: "mainnet-beta", initializedAt: "2026-11-25",
    sources: [{ address: record.address, cursor: "old" }, { address: tokenAccount, cursor: "old-token" }]
  };
  const kv = new FakeKV([
    [`sub/${record.id}`, JSON.stringify(record)],
    [`state/${record.id}`, JSON.stringify(prior)],
    [`seen/${record.id}`, JSON.stringify({ version: 1, signatures: [SIGNATURE] })]
  ]);
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    const payload = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, payload });
    if (url.includes("api.mainnet-beta.solana.com")) {
      let result;
      if (payload.method === "getTokenAccountsByOwner") result = { value: [] };
      else if (payload.method === "getSignaturesForAddress") {
        const address = payload.params[0];
        result = address === record.address ? [{ signature: SIGNATURE }, { signature: "old" }] : [{ signature: "old-token" }];
      } else if (payload.method === "getTransaction") {
        result = { transaction: { message: { accountKeys: [record.address] } }, meta: { preBalances: [1], postBalances: [9], preTokenBalances: [], postTokenBalances: [] } };
      } else throw new Error("unexpected RPC method");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }
    if (url.startsWith("https://fcm.googleapis.com/")) return new Response(null, { status: 201 });
    throw new Error("unexpected outbound URL");
  };
  const result = await scheduledScan({ SUBSCRIPTIONS: kv, FETCH: fetcher, ...vapid }, createOutboundBudget(50), "2026-11-25T02:00:00.000Z");
  assert.equal(result.scanned, 1);
  assert.equal(calls.filter(call => call.url.startsWith("https://fcm.googleapis.com/")).length, 0);
});

test("revoking a subscription also drops its signature window, and a wallet switch resets it", async () => {
  const wallet = await makeWallet();
  const nextWallet = await makeWallet();
  const pushKeys = await makePushKeys();
  const kv = new FakeKV();
  const fetcher = async () => new Response(null, { status: 200 });
  const env = { SUBSCRIPTIONS: kv, APP_ORIGIN: "https://app.example.test", FETCH: fetcher };
  const { fetchHandler } = await import("../src/handler.js");
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: pushKeys.p256dh, auth: pushKeys.auth } };
  const register = async (walletToUse) => {
    const issuedAt = String(Math.floor(Date.now() / 1000));
    const message = `MONO-PUSH-V1\n${walletToUse.address}\nmainnet-beta\n${issuedAt}\n${await sha256hex(subscription.endpoint)}\n${await sha256hex(token)}`;
    const signature = base64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", walletToUse.pair.privateKey, enc.encode(message))));
    return fetchHandler(new Request("https://push.example/v1/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.APP_ORIGIN },
      body: JSON.stringify({ subscription, address: walletToUse.address, network: "mainnet-beta", managementToken: token, issuedAt, signature })
    }), env, kv);
  };
  const id = await sha256hex(subscription.endpoint);
  assert.equal((await register(wallet)).status, 201);
  await rememberSeenSignatures(kv, id, [SIGNATURE]);
  assert.equal((await register(wallet)).status, 200);
  assert.equal((await loadSeenSignatures(kv, id)).size, 1, "same wallet keeps its window");
  assert.equal((await register(nextWallet)).status, 200);
  assert.equal((await loadSeenSignatures(kv, id)).size, 0, "a new wallet starts clean");

  await rememberSeenSignatures(kv, id, [SIGNATURE]);
  const revoked = await fetchHandler(new Request(`https://push.example/v1/subscriptions/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: env.APP_ORIGIN },
    body: JSON.stringify({ managementToken: token })
  }), env, kv);
  assert.equal(revoked.status, 200);
  assert.equal(kv.data.has(`seen/${id}`), false);
});

test("active wallets and their tracked token accounts are the desired webhook addresses", async () => {
  const mainnet = await makeSubscription();
  const devnet = await makeSubscription({ id: "e".repeat(64), network: "devnet", endpoint: "https://fcm.googleapis.com/fcm/send/devnet" });
  const kv = new FakeKV([
    [`sub/${mainnet.id}`, JSON.stringify(mainnet)],
    [`sub/${devnet.id}`, JSON.stringify(devnet)],
    [`state/${mainnet.id}`, JSON.stringify({ version: 1, address: mainnet.address, network: "mainnet-beta", sources: [
      { address: mainnet.address, cursor: "a" }, { address: TOKEN_ACCOUNT, cursor: "b" }
    ] })]
  ]);
  const desired = await desiredWebhookAddresses(kv);
  assert.deepEqual([...desired.get("mainnet-beta")].sort(), [mainnet.address, TOKEN_ACCOUNT].sort());
  assert.deepEqual([...desired.get("devnet")], [devnet.address]);
});

test("webhook address sync writes once, skips unchanged lists, and never runs without a key", async () => {
  const record = await makeSubscription();
  const kv = new FakeKV([[`sub/${record.id}`, JSON.stringify(record)]]);
  const calls = [];
  const fetcher = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const base = {
    SUBSCRIPTIONS: kv,
    FETCH: fetcher,
    HELIUS_API_KEY: "test-key",
    HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET,
    HELIUS_WEBHOOK_ID: "00000000-0000-0000-0000-000000000001",
    HELIUS_WEBHOOK_ID_DEVNET: "00000000-0000-0000-0000-000000000002"
  };

  assert.deepEqual((await syncHeliusWebhooks({ SUBSCRIPTIONS: kv, FETCH: fetcher }, kv, { origin: "https://push.example" })).reason, "not configured");
  assert.equal(calls.length, 0);

  const first = await syncHeliusWebhooks({ ...base }, kv, { origin: "https://push.example" });
  assert.deepEqual(first.synced, [{ network: "mainnet-beta", status: "updated" }, { network: "devnet", status: "no-subscriptions" }]);
  assert.equal(calls.length, 1);
  const [put] = calls;
  assert.equal(put.init.method, "PUT");
  assert.match(put.url, /\/v0\/webhooks\/00000000-0000-0000-0000-000000000001\?api-key=/);
  const body = JSON.parse(put.init.body);
  assert.deepEqual(body.accountAddresses, [record.address]);
  assert.equal(body.webhookType, "enhanced");
  assert.deepEqual(body.transactionTypes, ["ANY"]);
  assert.equal(body.authHeader, WEBHOOK_SECRET);
  assert.equal(body.webhookURL, "https://push.example/api/webhooks/helius?network=mainnet-beta");

  calls.length = 0;
  const second = await syncHeliusWebhooks({ ...base }, kv, { origin: "https://push.example" });
  assert.deepEqual(second.synced, [{ network: "mainnet-beta", status: "unchanged" }, { network: "devnet", status: "no-subscriptions" }]);
  assert.equal(calls.length, 0);
});

test("webhook address sync discovers an existing webhook before creating one", async () => {
  const record = await makeSubscription();
  const kv = new FakeKV([[`sub/${record.id}`, JSON.stringify(record)]]);
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/v0/webhooks?api-key=")) {
      return new Response(JSON.stringify([{
        webhookID: "11111111-1111-1111-1111-111111111111",
        webhookURL: "https://push.example/api/webhooks/helius?network=mainnet-beta",
        webhookType: "enhanced"
      }]), { status: 200 });
    }
    return new Response(null, { status: 200 });
  };
  const result = await syncHeliusWebhooks({
    SUBSCRIPTIONS: kv, FETCH: fetcher, HELIUS_API_KEY: "test-key", HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET
  }, kv, { origin: "https://push.example" });
  assert.deepEqual(result.synced, [{ network: "mainnet-beta", status: "updated" }, { network: "devnet", status: "no-subscriptions" }]);
  assert.equal(calls[1].init.method, "PUT");
  assert.match(calls[1].url, /11111111-1111-1111-1111-111111111111/);
  assert.equal(calls.some(call => call.init.method === "POST"), false);
  assert.equal(JSON.parse(kv.data.get("control/helius-mainnet-beta")).webhookId, "11111111-1111-1111-1111-111111111111");
});

test("a drifted webhook URL is repaired even when the address list is unchanged", async () => {
  const record = await makeSubscription();
  const kv = new FakeKV([
    [`sub/${record.id}`, JSON.stringify(record)],
    ["control/helius-mainnet-beta", JSON.stringify({
      version: 1,
      webhookId: "00000000-0000-0000-0000-000000000001",
      webhookURL: "https://0velo.github.io/api/webhooks/helius?network=mainnet-beta",
      addresses: [record.address]
    })]
  ]);
  const calls = [];
  const fetcher = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 200 });
  };
  const result = await syncHeliusWebhooks({
    SUBSCRIPTIONS: kv,
    FETCH: fetcher,
    HELIUS_API_KEY: "test-key",
    HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET,
    HELIUS_WEBHOOK_ID: "00000000-0000-0000-0000-000000000001"
  }, kv, { origin: "https://push.example" });
  assert.deepEqual(result.synced, [{ network: "mainnet-beta", status: "updated" }, { network: "devnet", status: "no-subscriptions" }]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).webhookURL, "https://push.example/api/webhooks/helius?network=mainnet-beta");
  assert.equal(JSON.parse(kv.data.get("control/helius-mainnet-beta")).webhookURL, "https://push.example/api/webhooks/helius?network=mainnet-beta");
});

test("subscribe and revoke keep the Helius webhook address list in step", async () => {
  const wallet = await makeWallet();
  const pushKeys = await makePushKeys();
  const kv = new FakeKV();
  const calls = [];
  const fetcher = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 200 });
  };
  const env = {
    SUBSCRIPTIONS: kv,
    APP_ORIGIN: "https://app.example.test",
    FETCH: fetcher,
    HELIUS_API_KEY: "test-key",
    HELIUS_WEBHOOK_AUTH: WEBHOOK_SECRET,
    HELIUS_WEBHOOK_ID: "00000000-0000-0000-0000-000000000001"
  };
  const { fetchHandler } = await import("../src/handler.js");
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: pushKeys.p256dh, auth: pushKeys.auth } };
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const digest = await sha256hex(token);
  const message = `MONO-PUSH-V1\n${wallet.address}\nmainnet-beta\n${issuedAt}\n${await sha256hex(subscription.endpoint)}\n${digest}`;
  const signature = base64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", wallet.pair.privateKey, enc.encode(message))));
  const registered = await fetchHandler(new Request("https://push.example/v1/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: env.APP_ORIGIN },
    body: JSON.stringify({ subscription, address: wallet.address, network: "mainnet-beta", managementToken: token, issuedAt, signature })
  }), env, kv);
  assert.equal(registered.status, 201);
  const puts = calls.filter(call => call.init.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0].init.body).accountAddresses, [wallet.address]);
  // The deployment's own origin is the callback target — never the app's Origin header.
  assert.equal(JSON.parse(puts[0].init.body).webhookURL, "https://push.example/api/webhooks/helius?network=mainnet-beta");
  assert.notEqual(JSON.parse(puts[0].init.body).webhookURL.includes("app.example.test"), true);

  const id = await sha256hex(subscription.endpoint);
  const revoked = await fetchHandler(new Request(`https://push.example/v1/subscriptions/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: env.APP_ORIGIN },
    body: JSON.stringify({ managementToken: token })
  }), env, kv);
  assert.equal(revoked.status, 200);
  // No subscriptions left: nothing to watch, so no webhook edit is charged.
  assert.equal(calls.filter(call => call.init.method === "PUT").length, 1);
});
