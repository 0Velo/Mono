/**
 * Whale / external wallet watch list (`고래 지갑 알림`).
 *
 * Only public Solana addresses and a label are stored — no key, seed, or
 * signature ever reaches this file. The list belongs to one browser
 * subscription (`sub/{id}`), so revoking the subscription also ends every
 * whale alert it created. A wallet that is the subscription's own address is
 * rejected here: the deposit path already covers it, and two alerts for one
 * transfer would be noise.
 */
export const MAX_WATCH_WALLETS = 8;
export const MAX_WATCH_LABEL = 24;

const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Control characters would break the one-line notification text.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const ENTRY_KEYS = ["address", "label", "enabled"];

export function normalizeWatchLabel(value) {
  if (typeof value !== "string") return "";
  // A newline or tab would break the single-line notification text, so the raw
  // value is rejected before whitespace is collapsed into plain spaces.
  if (CONTROL_PATTERN.test(value)) return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed || collapsed.length > MAX_WATCH_LABEL) return "";
  return collapsed;
}

export function validWatchAddress(value, owner = "") {
  return typeof value === "string" && ADDRESS_PATTERN.test(value) && value !== owner;
}

/**
 * Validate a full replacement list. Returns the cleaned entries, or null when
 * anything about the list is outside the contract (so the caller can answer
 * 400 instead of storing a half-validated list).
 */
export function parseWatchEntries(value, owner = "") {
  if (!Array.isArray(value) || value.length > MAX_WATCH_WALLETS) return null;
  const seen = new Set();
  const entries = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (Object.keys(item).length !== ENTRY_KEYS.length || !ENTRY_KEYS.every(key => Object.hasOwn(item, key))) return null;
    if (typeof item.enabled !== "boolean" || !validWatchAddress(item.address, owner)) return null;
    const label = normalizeWatchLabel(item.label);
    if (!label || seen.has(item.address)) return null;
    seen.add(item.address);
    entries.push({ address: item.address, label, enabled: item.enabled });
  }
  return entries;
}

/** Enabled watch entries for one subscription; an absent or broken record watches nothing. */
export async function loadWatchEntries(kv, record) {
  if (!record || record.network !== "mainnet-beta") return [];
  let raw;
  try { raw = await kv.get(`watch/${record.id}`); } catch { return []; }
  if (!raw) return [];
  let value;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!value || value.version !== 1 || value.network !== "mainnet-beta") return [];
  const entries = parseWatchEntries(value.entries, record.address);
  if (!entries) return [];
  return entries.filter(entry => entry.enabled);
}

export function watchRecord(entries, now = new Date()) {
  return JSON.stringify({
    version: 1,
    network: "mainnet-beta",
    entries,
    updatedAt: now.toISOString()
  });
}
