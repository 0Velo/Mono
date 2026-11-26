import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every Vercel entry point is deployed on its own, so a relative import that
 * resolves outside the project (or to a file that does not exist) is only
 * caught by `vercel build` — after the merge, on the platform. This walks the
 * `api/` tree and checks each relative specifier against the file system; a
 * wrong depth here is exactly what broke the first /v1/watch deployment.
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function apiFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) apiFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("every api entry point only imports files inside push-server", () => {
  const files = apiFiles(path.join(ROOT, "api"));
  assert.ok(files.length >= 5, `found ${files.length} api entry points`);
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.startsWith(`${ROOT}${path.sep}`)) {
        problems.push(`${path.relative(ROOT, file)} -> ${match[1]} escapes push-server`);
      } else if (!fs.existsSync(target)) {
        problems.push(`${path.relative(ROOT, file)} -> ${match[1]} does not exist`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the watch entry point answers the canonical path the rewrite sends", async () => {
  const { default: watchHandler } = await import("../api/v1/watch.js");
  const response = await watchHandler(new Request("https://push.example/api/v1/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example.test" },
    body: JSON.stringify({})
  }));
  // No database in this environment: the handler fails closed rather than 404,
  // which proves the rewrite target reaches the shared contract.
  assert.equal(response.status, 503);
});
