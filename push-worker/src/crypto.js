const encoder = new TextEncoder();

function allowedPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048 || endpoint.includes("#")) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && !url.hash &&
      (["fcm.googleapis.com", "webpush.googleapis.com", "web.push.apple.com"].includes(host) ||
       [".push.services.mozilla.com", ".notify.windows.com"].some(suffix => host.endsWith(suffix) && host.length > suffix.length));
  } catch { return false; }
}

export function base64urlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try { binary = atob(padded); } catch { throw new Error("invalid base64url"); }
  const out = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (base64urlEncode(out) !== value) throw new Error("non-canonical base64url");
  return out;
}

export function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function base58Decode(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error("invalid base58");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of value) n = n * 58n + BigInt(alphabet.indexOf(ch));
  const body = [];
  while (n > 0n) { body.push(Number(n & 255n)); n >>= 8n; }
  body.reverse();
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros++;
  const decoded = new Uint8Array(zeros + body.length);
  decoded.set(body, zeros);
  if (decoded.length !== 32) throw new Error("invalid public key length");
  return decoded;
}

export function hex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256hex(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value)));
}

export async function verifyWalletProof(address, signature, message) {
  try {
    const publicKey = await crypto.subtle.importKey("raw", base58Decode(address), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", publicKey, base64urlDecode(signature), encoder.encode(message));
  } catch { return false; }
}

async function hkdf(ikmBytes, saltBytes, info, length) {
  const key = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? encoder.encode(info) : info;
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes }, key, length * 8));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function uint32be(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }

export async function encryptWebPush(subscription, payload) {
  const receiverPublic = base64urlDecode(subscription.keys.p256dh);
  const authSecret = base64urlDecode(subscription.keys.auth);
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4 || authSecret.length < 16 || authSecret.length > 64) throw new Error("invalid push key material");
  const receiver = await crypto.subtle.importKey("raw", receiverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, ephemeral.privateKey, 256));
  const ikmInfo = concat(encoder.encode("WebPush: info\0"), receiverPublic, ephemeralPublic);
  const ikm = await hkdf(shared, authSecret, ikmInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
  const plain = concat(encoder.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plain));
  // RFC 8188 aes128gcm record: salt(16), rs(4), idlen(1), keyid(65), ciphertext.
  return concat(salt, uint32be(4096), new Uint8Array([ephemeralPublic.length]), ephemeralPublic, ciphertext);
}

export async function createVapidAuthorization(endpoint, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const privateDer = base64urlDecode(env.VAPID_PRIVATE_KEY || "");
  const publicKey = env.VAPID_PUBLIC_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !subject || privateDer.length < 32 || !/^(mailto:|https:\/\/)/.test(subject)) throw new Error("VAPID is not configured");
  const audience = new URL(endpoint).origin;
  const header = base64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64urlEncode(encoder.encode(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", privateDer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${base64urlEncode(signature)}, k=${publicKey}`;
}

export async function sendWebPush(subscription, payload, env, fetcher = fetch, budget = null) {
  if (!allowedPushEndpoint(subscription.endpoint)) throw new Error("push endpoint rejected");
  const url = new URL(subscription.endpoint);
  const body = await encryptWebPush(subscription, JSON.stringify(payload));
  const authorization = await createVapidAuthorization(subscription.endpoint, env);
  if (budget && !budget.take()) throw new Error("outbound request budget exhausted");
  return fetcher(url.href, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Authorization": authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "3600",
      "Urgency": "normal"
    },
    body
  });
}
