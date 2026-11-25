import { heliusWebhookHandler } from "../../src/helius.js";
import { getKv, runtimeEnv } from "../../src/runtime.js";

export const config = { runtime: "edge" };

/**
 * Helius enhanced webhook receiver: `POST /api/webhooks/helius?network=mainnet-beta`.
 * Authenticated by the shared `HELIUS_WEBHOOK_AUTH` value Helius echoes back in
 * the Authorization header; never reachable from the browser.
 */
export default function handler(request) {
  return heliusWebhookHandler(request, runtimeEnv(), getKv());
}
