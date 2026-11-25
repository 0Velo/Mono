import { fetchHandler } from "../../src/handler.js";
import { getKv, runtimeEnv } from "../../src/runtime.js";

export const config = { runtime: "edge" };

/**
 * One catch-all function serves the whole `/v1` contract. A per-route dynamic
 * function (`[id].js`) does not receive the requested path, which left the
 * `DELETE /v1/subscriptions/{id}` route unreachable; the catch-all keeps the
 * original URL intact so the handler can match it.
 */
export default function handler(request) {
  return fetchHandler(request, runtimeEnv(), getKv());
}
