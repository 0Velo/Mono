import { fetchHandler } from "../../src/handler.js";
import { getKv, runtimeEnv } from "../../src/runtime.js";

export const config = { runtime: "edge" };

export default function handler(request) {
  return fetchHandler(request, runtimeEnv(), getKv());
}
