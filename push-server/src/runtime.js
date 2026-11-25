import { neon } from "@neondatabase/serverless";
import { createSqlKv } from "./store.js";

/**
 * Deployment settings come only from Vercel environment variables. The VAPID
 * private key, the scan secret, and the database URL never reach the browser
 * bundle: this directory is deployed on its own, not as part of the app.
 */
export function runtimeEnv() {
  return {
    APP_ORIGIN: process.env.APP_ORIGIN || "",
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || "",
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || "",
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || "",
    CRON_SECRET: process.env.CRON_SECRET || ""
  };
}

let kv = null;

/** Returns the store, or null when the deployment has no database configured (fail closed). */
export function getKv() {
  if (kv) return kv;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  const sql = neon(url);
  kv = createSqlKv((text, params) => sql.query(text, params));
  return kv;
}
