/**
 * Store contract used by the HTTP handler: a tiny namespaced key/value table.
 *
 * The Cloudflare Worker prototype used KV; this deployment keeps the same
 * get/put/delete/list shape and backs it with Postgres (Neon, provisioned
 * through the Vercel dashboard). Every value is a JSON or decimal string, and
 * no key material, push endpoint, or management token is ever logged.
 */

const TABLE = "mono_push_kv";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_key_prefix ON ${TABLE} (key text_pattern_ops)`,
];

function escapeLike(prefix) {
  return prefix.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * @param {(text: string, params: unknown[]) => Promise<Record<string, unknown>[]>} query
 *   A parameterised query function (the Neon serverless driver's tagged
 *   template wraps one). Rows come back as plain objects.
 */
export function createSqlKv(query) {
  let schemaReady = null;

  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        for (const statement of SCHEMA) await query(statement, []);
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  }

  return {
    async get(key) {
      await ensureSchema();
      const rows = await query(`SELECT value FROM ${TABLE} WHERE key = $1`, [String(key)]);
      const value = rows?.[0]?.value;
      return typeof value === "string" ? value : null;
    },
    async put(key, value) {
      await ensureSchema();
      await query(
        `INSERT INTO ${TABLE} (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [String(key), String(value)],
      );
    },
    async delete(key) {
      await ensureSchema();
      await query(`DELETE FROM ${TABLE} WHERE key = $1`, [String(key)]);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      await ensureSchema();
      const bounded = Math.max(1, Math.min(1000, Number(limit) || 1000));
      const rows = await query(
        `SELECT key FROM ${TABLE} WHERE key LIKE $1 ORDER BY key ASC LIMIT $2`,
        [`${escapeLike(String(prefix))}%`, bounded],
      );
      const keys = (rows ?? []).map((row) => ({ name: String(row.key) }));
      return { keys, list_complete: keys.length < bounded };
    },
  };
}
