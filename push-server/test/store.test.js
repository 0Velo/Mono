import test from "node:test";
import assert from "node:assert/strict";
import { createSqlKv } from "../src/store.js";

/**
 * Emulates the three statements `createSqlKv` issues against the `mono_push_kv`
 * table so the adapter's key/value contract can be tested without a database.
 */
function fakeDatabase() {
  const rows = new Map();
  const statements = [];
  async function query(text, params = []) {
    statements.push({ text: text.replace(/\s+/g, " ").trim(), params });
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return [];
    if (sql.startsWith("SELECT value FROM mono_push_kv WHERE key = $1")) {
      return rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [];
    }
    if (sql.startsWith("INSERT INTO mono_push_kv")) {
      rows.set(params[0], params[1]);
      return [];
    }
    if (sql.startsWith("DELETE FROM mono_push_kv")) {
      rows.delete(params[0]);
      return [];
    }
    if (sql.startsWith("SELECT key FROM mono_push_kv WHERE key LIKE $1")) {
      const prefix = String(params[1 - 1]).replace(/\\%$/, "").replace(/%$/, "").replace(/\\(.)/g, "$1");
      const limit = params[1];
      return [...rows.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((key) => ({ key }));
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
  return { rows, statements, query };
}

test("sql store keeps the get/put/delete contract and creates its schema once", async () => {
  const db = fakeDatabase();
  const kv = createSqlKv(db.query);
  assert.equal(await kv.get("sub/abc"), null);
  await kv.put("sub/abc", "{\"a\":1}");
  assert.equal(await kv.get("sub/abc"), "{\"a\":1}");
  await kv.put("sub/abc", "{\"a\":2}");
  assert.equal(await kv.get("sub/abc"), "{\"a\":2}");
  await kv.put("state/abc", "s");
  assert.deepEqual(await kv.list({ prefix: "sub/", limit: 10 }), { keys: [{ name: "sub/abc" }], list_complete: true });
  await kv.delete("sub/abc");
  assert.equal(await kv.get("sub/abc"), null);
  assert.equal(db.rows.has("state/abc"), true);
  const schemaStatements = db.statements.filter((item) => item.text.startsWith("CREATE"));
  assert.equal(schemaStatements.length, 2, "schema is created once per instance, not per call");
});

test("list reports an incomplete page when the limit is reached", async () => {
  const db = fakeDatabase();
  const kv = createSqlKv(db.query);
  for (const index of [1, 2, 3]) await kv.put(`sub/${index}`, "x");
  assert.deepEqual((await kv.list({ prefix: "sub/", limit: 2 })).keys.length, 2);
  assert.equal((await kv.list({ prefix: "sub/", limit: 2 })).list_complete, false);
  assert.equal((await kv.list({ prefix: "sub/", limit: 7 })).list_complete, true);
  assert.equal((await kv.list({ prefix: "state/", limit: 7 })).keys.length, 0);
});

test("list bounds an untrusted limit and escapes LIKE metacharacters in the prefix", async () => {
  const db = fakeDatabase();
  const kv = createSqlKv(db.query);
  await kv.put("control/daily-2026-11-25", "1");
  const listed = await kv.list({ prefix: "control/", limit: 100000 });
  assert.deepEqual(listed.keys, [{ name: "control/daily-2026-11-25" }]);
  const select = db.statements.filter((item) => item.text.startsWith("SELECT key")).at(-1);
  assert.equal(select.params[1], 1000);
  await kv.list({ prefix: "sub_%", limit: 5 });
  const escaped = db.statements.filter((item) => item.text.startsWith("SELECT key")).at(-1);
  assert.equal(escaped.params[0], "sub\\_\\%%");
});
