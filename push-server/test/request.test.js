import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, withCanonicalPath } from "../src/request.js";

const ID = "a".repeat(64);

test("the platform's /api prefix is removed from the public URL", () => {
  assert.equal(canonicalUrl(new Request("https://push.example/api/v1/config")), "https://push.example/v1/config");
  assert.equal(canonicalUrl(new Request("https://push.example/v1/config")), "https://push.example/v1/config");
  assert.equal(canonicalUrl(new Request("https://push.example/api")), "https://push.example/");
});

test("an id the platform passes as a query parameter becomes a path segment", () => {
  assert.equal(
    canonicalUrl(new Request(`https://push.example/api/v1/subscriptions?id=${ID}`), { allowIdParam: true }),
    `https://push.example/v1/subscriptions/${ID}`,
  );
  assert.equal(
    canonicalUrl(new Request(`https://push.example/v1/subscriptions?id=${ID}`), { allowIdParam: true }),
    `https://push.example/v1/subscriptions/${ID}`,
  );
  assert.equal(
    canonicalUrl(new Request(`https://push.example/api/v1/subscriptions/${ID}`), { allowIdParam: true }),
    `https://push.example/v1/subscriptions/${ID}`,
  );
});

test("a malformed or extra query parameter is left for the handler to reject", () => {
  for (const query of ["id=not-hex", `id=${ID}&extra=1`, "next=/admin", "id=", `id=${ID.toUpperCase()}`]) {
    const url = `https://push.example/api/v1/subscriptions?${query}`;
    assert.equal(canonicalUrl(new Request(url), { allowIdParam: true }), url.replace("/api/v1", "/v1"));
  }
  assert.equal(
    canonicalUrl(new Request("https://push.example/v1/config?x=1")),
    "https://push.example/v1/config?x=1",
  );
});

test("the rebuilt request keeps its method, headers and body", async () => {
  const original = new Request(`https://push.example/api/v1/subscriptions?id=${ID}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body: JSON.stringify({ managementToken: "x" }),
  });
  const rebuilt = withCanonicalPath(original, { allowIdParam: true });
  assert.equal(rebuilt.method, "DELETE");
  assert.equal(new URL(rebuilt.url).pathname, `/v1/subscriptions/${ID}`);
  assert.equal(rebuilt.headers.get("origin"), "https://app.example");
  assert.equal(rebuilt.headers.get("content-type"), "application/json");
  assert.deepEqual(await rebuilt.json(), { managementToken: "x" });
});
