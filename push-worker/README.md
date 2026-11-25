# Mono Solana Deposit Web Push — Worker Prototype

Standalone, dependency-free Cloudflare Worker prototype for a deliberately tiny Solana Web Push pilot. This project has not been deployed, connected to a Cloudflare account, supplied with real VAPID keys, or sent real push notifications. Only synthetic fixtures are used by the tests. Keep it undelivered until the separate explicit approval described below.

## Frontend contract

All responses use `Cache-Control: no-store`; endpoints, subscription keys, signatures, and management tokens are never included in responses or logged. Browser CORS is restricted to the exact `APP_ORIGIN` value. The Worker does not accept wallet private keys or seeds.

The client needs WebCrypto Ed25519 support to sign the wallet association. Apple added Ed25519 support in Safari 17; iOS/iPadOS Home Screen Web Push itself starts at 16.4, but this prototype therefore requires iOS/iPadOS 17 or later. On iPhone/iPad, users must add the app to the Home Screen and grant notification permission from the app. The client preloads server configuration and the service-worker subscription before the opt-in gesture so permission is requested without a preceding network wait.

### Read public VAPID key

`GET /v1/config`

```json
{ "vapidPublicKey": "<base64url-uncompressed-P-256-public-key>" }
```

The value is `env.VAPID_PUBLIC_KEY`. It is returned only when configured and valid. It is public key material, not the private VAPID key.

### Register or update a subscription

`POST /v1/subscriptions` with `Content-Type: application/json`:

```json
{
  "subscription": {
    "endpoint": "https://<approved-push-vendor-host>/<opaque-path>",
    "keys": { "p256dh": "<base64url-P-256-public-key>", "auth": "<base64url-auth-secret>" }
  },
  "address": "<base58-Solana-public-key>",
  "network": "mainnet-beta",
  "managementToken": "<at-least-32-random-bytes-as-canonical-base64url>",
  "issuedAt": "<10-digit-Unix-seconds>",
  "signature": "<64-byte-Ed25519-signature-as-base64url>"
}
```

`network` is exactly `mainnet-beta` or `devnet`. `issuedAt` is decimal Unix seconds and must be within five minutes of Worker time. The wallet must sign the UTF-8 bytes of this exact canonical message (LF separators, no trailing newline):

```text
MONO-PUSH-V1
${address}
${network}
${issuedAt}
${sha256hex(subscription.endpoint)}
${sha256hex(managementToken)}
```

Both hashes are lowercase hexadecimal SHA-256 of the UTF-8 input strings. The proof binds the exact endpoint and management token without sending private wallet material. Generate `managementToken` from a cryptographically secure random source with at least 256 bits of entropy and retain it only on the client; the Worker stores its SHA-256 digest. The endpoint hash is the subscription ID. First registration returns `201 {"id":"<64-lowercase-hex>"}`; an authorized update of that endpoint returns `200` with the same shape. Updating the address/network requires a fresh signature; that change causes a new quiet monitoring baseline.

For an endpoint already registered, a valid signed request is accepted only when the management-token digest matches the existing record. The user should keep a stable management token for the endpoint.

### Disable

`DELETE /v1/subscriptions/{id}` with a JSON body:

```json
{ "managementToken": "<the-original-management-token>" }
```

The ID is the 64-character lowercase endpoint SHA-256 hex. A matching token digest is required. Success returns `200 {"disabled":true}`. The Worker deletes the subscription and its cursor state; deletion is not an atomic transaction in KV.

### Validation and errors

The request body is limited to 8 KiB and parsed as strict JSON with exact field sets. Subscription endpoints must use HTTPS on port 443/default and pass the hard-coded push-vendor host allowlist: `fcm.googleapis.com`, `webpush.googleapis.com`, `web.push.apple.com`, `*.push.services.mozilla.com`, or `*.notify.windows.com`. Credentials, fragments, non-HTTPS URLs, arbitrary ports, IP literals, and lookalike domains are rejected. Push requests use `redirect: "manual"`; redirects are not followed. This is a deliberately narrow vendor allowlist, not a generic endpoint feature.

## Local tests

Requires Node.js 22+ for WebCrypto Ed25519 and the built-in test runner. No package install is required:

```sh
cd /workspace/mono/push-worker
npm test
# or syntax checks plus tests
npm run check
```

Tests create ephemeral keys in memory and use fake KV plus mocked RPC/push fetches. They do not contact Solana, push vendors, or Cloudflare. Wrangler configuration contains a placeholder KV namespace ID and no VAPID secrets; it is not directly deployable as-is.

For the local Worker emulator, install package dependencies and run `npm run dev` (Wrangler local mode). It does not deploy, but the sample has no VAPID values, so `GET /v1/config` intentionally returns a generic 503 until a developer supplies ephemeral synthetic values in the ignored `.dev.vars` file. Never put real keys in that file for this prototype. Local emulator use was not required for the automated tests and was not run here.

## Future setup/deployment — not performed

Do not perform these steps without separate explicit approval. No Cloudflare login, account creation, namespace creation, secret generation, deployment, or delivery has been carried out for this prototype.

After approval, an operator should first review the source, current Cloudflare Free-plan quotas, privacy/security posture, vendor allowlist, and applicable local law. Create a KV namespace in the intended account and replace the placeholder namespace IDs in `wrangler.toml`. Configure the exact production frontend origin. Generate a new P-256 VAPID keypair in a controlled environment; store only its public key in `VAPID_PUBLIC_KEY`, and set `VAPID_PRIVATE_KEY` (base64url PKCS#8 DER) and a valid `VAPID_SUBJECT` (`mailto:` or HTTPS) using Wrangler secrets, never source control, browser code, local committed files, or logs. Verify the private/public key pair matches. Then run the approved local checks, inspect the diff restricted to this project, and only then use the account owner's approved deployment procedure. Complete deployment and public delivery require a distinct approval; this README does not authorize them.

## Resource and abuse safeguards

- Intended pilot ceiling: six subscription records. New registration does a KV list check; the check is subject to eventual consistency and concurrent races and is **not an atomic/enforced global cap**.
- Cron is configured for twice hourly. Each scheduled invocation lists at most seven `sub/` keys and processes at most three of six subscriptions using a best-effort rotation key. Rotation and KV reads are eventually consistent; duplicates/starvation can occur under races or partial failures.
- Every scheduled invocation shares an explicit hard-coded maximum of 50 outbound HTTP requests across both RPC and push calls. A scan of each subscription has at most two token-account discovery calls, three signature-address calls (wallet plus at most two token accounts), two new signatures per source, at most six transaction lookups, and one coalesced push. The current upper bound is 36 outbound calls for three subscriptions, below the 50-call guard. RPC responses are capped at 1 MB and each RPC fetch times out.
- A serial best-effort daily API-operation counter permits at most 250 authenticated register/update/disable operations. Normal upper-bound KV writes are 750 from API operations (disable uses three writes/deletes including the counter) plus at most 192 scheduled writes (48 rotation updates + 144 scan-state puts), or 942/day. Cron performs at most 48 KV lists/day; authenticated new registrations add at most 250 KV lists/day under the serial counter. These are design estimates, **not guaranteed quotas**: KV has no compare-and-swap/transactional locking, counters and lists are eventually consistent, and concurrent requests, retries, account changes, or platform behavior can exceed them. The global list of six and the daily cap are not production-grade rate limiting. Check actual plan quotas before any approved use.
- There are no paid RPC providers or integrations. RPC URLs are hardwired read-only Solana mainnet-beta/devnet endpoints; clients cannot supply an RPC URL. The Worker makes JSON-RPC POST requests only to read methods and never submits transactions.

## Monitoring behavior and limitations

The first successful scan creates a quiet signature baseline and sends no historical notification. If the first signature query returns no rows, the first signature discovered later also becomes a quiet baseline and can be missed as a notification. Later scans inspect recent `getSignaturesForAddress` results, fetch transaction metadata, and report positive wallet SOL balance deltas and positive owner token balance deltas from pre/post metadata. SPL Token and Token-2022 account discovery is attempted on each scan. Notification text is coalesced and intentionally omits precise amounts and transaction details.

To remain bounded, this prototype tracks only the wallet plus at most one discovered account per token program (three sources total) and examines at most two newer signatures per source per scan. It retains already tracked account cursors, including closed accounts, only within those slots. Additional token accounts are not monitored; a wallet with multiple token accounts, accounts appearing after the two slots fill, and source-history gaps can therefore be missed. If a cursor falls outside the bounded recent page, more than two new signatures accumulate, or RPC/transaction metadata is unavailable, that subscription scan fails without advancing its cursor. There is no automatic unbounded backlog catch-up. Closed accounts that were never discovered cannot be recovered. Provider history pruning, throttling, outages, or response shape changes also prevent monitoring.

This is best-effort, not a reliability guarantee: notifications can be late, duplicated, or missed. Push accepted by a provider followed by a failed response/state write can be retried and duplicated. KV is eventually consistent and is not a lock; overlapping cron runs, update/delete races, counter races, and rotation races are possible. A positive balance delta is not a full semantic proof of an external deposit (rent refunds, account closure, or other balance-changing transaction effects can look incoming). This prototype does not handle token metadata/decimals, reorg finality, rich transaction attribution, fiat values, retries with durable queues, delivery receipts, or user-facing history.

## Files

- `src/worker.js` — HTTP contract, validation, CORS, KV registration/disable.
- `src/crypto.js` — Ed25519 proof verification, VAPID JWT, RFC 8291 Web Push encryption and dispatch.
- `src/monitor.js` — hardwired read-only Solana RPC, bounded cursor scanning and deposit detection.
- `test/worker.test.js` — synthetic crypto, security, quota, baseline and mock-RPC/push coverage.
- `wrangler.toml` — unconfigured KV placeholder and Cron schedule.
