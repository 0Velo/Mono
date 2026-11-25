import { fetchHandler } from "../../../src/handler.js";
import { getKv, runtimeEnv } from "../../../src/runtime.js";
import { withCanonicalPath } from "../../../src/request.js";

export const config = { runtime: "edge" };

/** `DELETE /v1/subscriptions/{id}` — the platform passes the id as a query parameter. */
export default function handler(request) {
  return fetchHandler(withCanonicalPath(request, { allowIdParam: true }), runtimeEnv(), getKv());
}
