import test from "node:test";
import assert from "node:assert/strict";
import worker, { fetchHandler, reserveDailyOperation, validPushEndpoint } from "../src/worker.js";
import { TOKEN_PROGRAMS, createOutboundBudget, detectDeposits, scheduledScan } from "../src/monitor.js";
import { base58Decode, base64urlDecode, base64urlEncode, encryptWebPush, sha256hex, verifyWalletProof, createVapidAuthorization } from "../src/crypto.js";

const enc = new TextEncoder();

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
  constructor(entries = []) { this.data = new Map(entries); this.puts = 0; this.deletes = 0; this.lists = 0; }
  async get(key) { return this.data.get(key) ?? null; }
  async put(key, value) { this.puts++; this.data.set(key, String(value)); }
  async delete(key) { this.deletes++; this.data.delete(key); }
  async list({ prefix = "", limit = 1000 } = {}) {
    this.lists++;
    const keys = [...this.data.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name }));
    return { keys, list_complete: this.data.size <= limit };
  }
}

async function makeWallet() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, address: base58Encode(raw) };
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

function mockEnv(kv, extra = {}) {
  return { SUBSCRIPTIONS: kv, APP_ORIGIN: "https://app.example.test", ...extra };
}

async function signedBody(wallet, subscription, network, token, issuedAt = String(Math.floor(Date.now() / 1000))) {
  const digest = await sha256hex(token);
  const endpointHash = await sha256hex(subscription.endpoint);
  const message = `MONO-PUSH-V1\n${wallet.address}\n${network}\n${issuedAt}\n${endpointHash}\n${digest}`;
  const signature = base64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", wallet.pair.privateKey, enc.encode(message))));
  return { subscription, address: wallet.address, network, managementToken: token, issuedAt, signature };
}

function postRequest(body, origin = "https://app.example.test") {
  return new Request("https://worker.example/v1/subscriptions", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body)
  });
}

async function rpcMockForScan({ wallet, tokenA, tokenB, phase = "baseline", failTransaction = false }) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    const payload = url.includes("api.mainnet-beta.solana.com") && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, payload, init });
    if (url.includes("api.mainnet-beta.solana.com")) {
      let result;
      if (payload.method === "getTokenAccountsByOwner") {
        const program = payload.params[1].programId;
        result = { value: [{ pubkey: program === TOKEN_PROGRAMS[0] ? tokenA : tokenB }] };
      } else if (payload.method === "getSignaturesForAddress") {
        const address = payload.params[0];
        if (phase === "baseline") result = [{ signature: `old:${address}` }];
        else if (address === wallet.address) result = [{ signature: "new-wallet-signature" }, { signature: `old:${address}` }];
        else result = [{ signature: `old:${address}` }];
      } else if (payload.method === "getTransaction") {
        result = failTransaction ? null : {
          transaction: { message: { accountKeys: [wallet.address] } },
          meta: { preBalances: [1000], postBalances: [3500], preTokenBalances: [], postTokenBalances: [] }
        };
      } else throw new Error(`unexpected RPC method ${payload.method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }
    if (url.startsWith("https://fcm.googleapis.com/")) return new Response(null, { status: 201 });
    throw new Error("unexpected outbound URL");
  };
  return { fetcher, calls };
}

// Runtime smoke tests use WebCrypto as available in Workers and Node 22.
test("base58 public keys, canonical base64url, SHA-256 and Ed25519 proof verification", async () => {
  const wallet = await makeWallet();
  assert.equal(base58Decode(wallet.address).length, 32);
  assert.deepEqual(base64urlDecode(base64urlEncode(new Uint8Array([0, 1, 255]))), new Uint8Array([0, 1, 255]));
  assert.equal(await sha256hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const message = "MONO-PUSH-V1\ntest";
  const signature = base64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", wallet.pair.privateKey, enc.encode(message))));
  assert.equal(await verifyWalletProof(wallet.address, signature, message), true);
  assert.equal(await verifyWalletProof(wallet.address, signature, `${message}!`), false);
  await assert.rejects(async () => base64urlDecode("ab="));
});

test("RFC 8291 aes128gcm payload can be decrypted by receiver key", async () => {
  const receiver = await makePushKeys();
  const subscription = { keys: { p256dh: receiver.p256dh, auth: receiver.auth } };
  const payload = JSON.stringify({ title: "Deposit detected" });
  const record = await encryptWebPush(subscription, payload);
  assert.equal(record[20], 65);
  const ephemeralPublic = record.slice(21, 86);
  const salt = record.slice(0, 16);
  const receiverRaw = base64urlDecode(receiver.p256dh);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await crypto.subtle.importKey("raw", ephemeralPublic, { name: "ECDH", namedCurve: "P-256" }, false, []) }, receiver.pair.privateKey, 256));
  const auth = base64urlDecode(receiver.auth);
  const info = new Uint8Array(enc.encode("WebPush: info\0").length + receiverRaw.length + ephemeralPublic.length);
  info.set(enc.encode("WebPush: info\0")); info.set(receiverRaw, enc.encode("WebPush: info\0").length); info.set(ephemeralPublic, enc.encode("WebPush: info\0").length + receiverRaw.length);
  async function derive(ikmBytes, saltBytes, infoBytes, length) {
    const key = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes }, key, length * 8));
  }
  const ikm = await derive(shared, auth, info, 32);
  const contentKey = await derive(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await derive(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record.slice(86)));
  assert.equal(new TextDecoder().decode(clear.slice(0, -1)), payload);
  assert.equal(clear.at(-1), 2);
});

test("VAPID JWT carries audience and expiry and is ES256-verifiable", async () => {
  const vapid = await makeVapid();
  const authorization = await createVapidAuthorization("https://fcm.googleapis.com/fcm/send/demo", vapid, 1_800_000_000);
  const match = authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(match);
  const [head, claims, sig] = match[1].split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(base64urlDecode(head))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(base64urlDecode(claims))), { aud: "https://fcm.googleapis.com", exp: 1_800_043_200, sub: vapid.VAPID_SUBJECT });
  const pub = await crypto.subtle.importKey("raw", base64urlDecode(vapid.VAPID_PUBLIC_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, base64urlDecode(sig), enc.encode(`${head}.${claims}`)), true);
});

test("strict route validation, exact-origin CORS, no-store, subscription register and token-gated delete", async () => {
  const wallet = await makeWallet();
  const push = await makePushKeys();
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: push.p256dh, auth: push.auth } };
  const kv = new FakeKV();
  const env = mockEnv(kv, { VAPID_PUBLIC_KEY: base64urlEncode(new Uint8Array([4, ...new Uint8Array(64)])) });
  const configResponse = await fetchHandler(new Request("https://worker.example/v1/config", { headers: { Origin: env.APP_ORIGIN } }), env, {});
  assert.equal(configResponse.status, 200);
  assert.deepEqual(await configResponse.json(), { vapidPublicKey: env.VAPID_PUBLIC_KEY });
  const body = await signedBody(wallet, subscription, "mainnet-beta", token);
  const response = await fetchHandler(postRequest(body), env, {});
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("access-control-allow-origin"), env.APP_ORIGIN);
  const result = await response.json();
  const id = await sha256hex(subscription.endpoint);
  assert.equal(result.id, id);
  assert.equal(JSON.stringify(result).includes(subscription.endpoint), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(validPushEndpoint(subscription.endpoint), true);
  assert.equal(validPushEndpoint("http://fcm.googleapis.com/fcm/send/no"), false);
  assert.equal(validPushEndpoint("https://127.0.0.1/x"), false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com.attacker.test/x"), false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com:444/x"), false);

  const newWallet = await makeWallet();
  const wrongToken = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const wrongUpdate = await signedBody(newWallet, subscription, "devnet", wrongToken);
  assert.equal((await fetchHandler(postRequest(wrongUpdate), env, {})).status, 409);
  const validUpdate = await signedBody(newWallet, subscription, "devnet", token);
  assert.equal((await fetchHandler(postRequest(validUpdate), env, {})).status, 200);

  const badDelete = await fetchHandler(new Request(`https://worker.example/v1/subscriptions/${id}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ managementToken: wrongToken })
  }), env, {});
  assert.equal(badDelete.status, 403);
  const goodDelete = await fetchHandler(new Request(`https://worker.example/v1/subscriptions/${id}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ managementToken: token })
  }), env, {});
  assert.equal(goodDelete.status, 200);
  assert.equal(kv.data.has(`sub/${id}`), false);
});

test("subscription rejects stale proofs, unapproved origins, oversized bodies and invalid signed endpoints", async () => {
  const wallet = await makeWallet();
  const push = await makePushKeys();
  const token = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const kv = new FakeKV();
  const env = mockEnv(kv);
  const good = await signedBody(wallet, { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: push.p256dh, auth: push.auth } }, "devnet", token, "1000000000");
  assert.equal((await fetchHandler(postRequest(good), env, {})).status, 401);
  assert.equal((await fetchHandler(postRequest(good, "https://evil.example"), env, {})).status, 403);
  const oversized = new Request("https://worker.example/v1/subscriptions", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "9000" }, body: "{}" });
  assert.equal((await fetchHandler(oversized, env, {})).status, 400);
  const smuggled = { ...good, subscription: { ...good.subscription, endpoint: "https://127.0.0.1/admin" } };
  assert.equal((await fetchHandler(postRequest(smuggled), env, {})).status, 400);
  const foreign = await fetchHandler(new Request("https://worker.example/v1/config", { headers: { Origin: "https://evil.example" } }), env, {});
  assert.equal(foreign.status, 403);
  assert.equal(kv.data.size, 0);
});

test("daily KV safeguard allows 250 serial operations then refuses further writes", async () => {
  const kv = new FakeKV();
  const now = new Date("2026-11-25T00:00:00.000Z");
  for (let i = 0; i < 250; i++) assert.equal(await reserveDailyOperation(kv, now), true);
  assert.equal(await reserveDailyOperation(kv, now), false);
  assert.equal(kv.puts, 250);
});

test("incoming SOL and token balance deltas are identified from transaction metadata", () => {
  const tx = {
    transaction: { message: { accountKeys: ["wallet", "other"] } },
    meta: {
      preBalances: [100, 100], postBalances: [200, 0],
      preTokenBalances: [{ owner: "wallet", mint: "mint1", uiTokenAmount: { amount: "10" } }],
      postTokenBalances: [{ owner: "wallet", mint: "mint1", uiTokenAmount: { amount: "25" } }]
    }
  };
  assert.deepEqual(detectDeposits(tx, "wallet"), [
    { asset: "SOL", rawAmount: "100" }, { asset: "SPL", mint: "mint1", rawAmount: "15" }
  ]);
  const tokenAccountTx = {
    transaction: { message: { accountKeys: ["wallet", "owned-token-account"] } },
    meta: {
      preBalances: [100, 1], postBalances: [100, 1],
      preTokenBalances: [{ accountIndex: 1, mint: "mint2", uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 1, mint: "mint2", uiTokenAmount: { amount: "7" } }]
    }
  };
  assert.deepEqual(detectDeposits(tokenAccountTx, "wallet", ["owned-token-account"]), [
    { asset: "SPL", mint: "mint2", rawAmount: "7" }
  ]);
});

test("first scheduled scan establishes a quiet baseline; later mock deposit notifies and advances cursor", async () => {
  const wallet = await makeWallet();
  const push = await makePushKeys();
  const vapid = await makeVapid();
  const id = "a".repeat(64);
  const record = {
    version: 1, id, endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: push.p256dh, auth: push.auth },
    address: wallet.address, network: "mainnet-beta", tokenDigest: "not-used-by-cron"
  };
  const kv = new FakeKV([[`sub/${id}`, JSON.stringify(record)]]);
  const env = mockEnv(kv, vapid);
  const tokenA = "token-account-a";
  const tokenB = "token-account-b";
  let mock = await rpcMockForScan({ wallet, tokenA, tokenB, phase: "baseline" });
  env.FETCH = mock.fetcher;
  const baseline = await scheduledScan(env, createOutboundBudget(50), "2026-11-25T00:00:00.000Z");
  assert.equal(baseline.scanned, 1);
  assert.equal(mock.calls.some(c => c.url.startsWith("https://fcm.googleapis.com/")), false);
  const stored = JSON.parse(kv.data.get(`state/${id}`));
  assert.equal(stored.sources.length, 3);
  assert.equal(stored.sources[0].cursor, `old:${wallet.address}`);

  mock = await rpcMockForScan({ wallet, tokenA, tokenB, phase: "deposit" });
  env.FETCH = mock.fetcher;
  const next = await scheduledScan(env, createOutboundBudget(50), "2026-11-25T00:30:00.000Z");
  assert.equal(next.scanned, 1);
  const pushes = mock.calls.filter(c => c.url.startsWith("https://fcm.googleapis.com/"));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].init.redirect, "manual");
  assert.equal(pushes[0].init.headers["Content-Encoding"], "aes128gcm");
  const advanced = JSON.parse(kv.data.get(`state/${id}`));
  assert.equal(advanced.sources[0].cursor, "new-wallet-signature");
  assert.ok(mock.calls.length <= 50);
});

test("failed RPC transaction does not advance a subscription cursor", async () => {
  const wallet = await makeWallet();
  const push = await makePushKeys();
  const id = "b".repeat(64);
  const record = { version: 1, id, endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: push.p256dh, auth: push.auth }, address: wallet.address, network: "mainnet-beta" };
  const prior = { version: 1, address: wallet.address, network: "mainnet-beta", initializedAt: "2026-11-25", sources: [
    { address: wallet.address, cursor: `old:${wallet.address}` },
    { address: "token-account-a", cursor: "old:token-account-a" },
    { address: "token-account-b", cursor: "old:token-account-b" }
  ] };
  const kv = new FakeKV([[`sub/${id}`, JSON.stringify(record)], [`state/${id}`, JSON.stringify(prior)]]);
  const mock = await rpcMockForScan({ wallet, tokenA: "token-account-a", tokenB: "token-account-b", phase: "deposit", failTransaction: true });
  const result = await scheduledScan(mockEnv(kv, { FETCH: mock.fetcher }), createOutboundBudget(50), "2026-11-25T01:00:00.000Z");
  assert.equal(result.errors, 1);
  assert.deepEqual(JSON.parse(kv.data.get(`state/${id}`)), prior);
});

test("per-invocation outbound budget is an explicit hard cap", () => {
  const budget = createOutboundBudget(50);
  for (let i = 0; i < 50; i++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.used, 50);
  assert.equal(worker.fetch instanceof Function, true);
});
