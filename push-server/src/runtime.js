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
    CRON_SECRET: process.env.CRON_SECRET || "",
    // Helius real-time webhooks (optional: without these the 15-minute scan is the only path).
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || "",
    HELIUS_WEBHOOK_AUTH: process.env.HELIUS_WEBHOOK_AUTH || "",
    HELIUS_WEBHOOK_ID: process.env.HELIUS_WEBHOOK_ID || "",
    HELIUS_WEBHOOK_ID_DEVNET: process.env.HELIUS_WEBHOOK_ID_DEVNET || "",
    HELIUS_WEBHOOK_URL: process.env.HELIUS_WEBHOOK_URL || ""
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
