// Append-only local audit log of mutating + egress actions (delete, move, rename,
// upload, download, folder-download, zip, presigned-share, profile changes). One
// JSON object per line. It NEVER records secrets or presigned signatures, and a
// failed write NEVER breaks the underlying operation — auditing is best-effort.
import fs from 'node:fs';
import path from 'node:path';
import { PROFILES_PATH } from './config.js';

const STORE_DIR = path.dirname(PROFILES_PATH);
const LOG_FILE = path.join(STORE_DIR, 'audit.log');
const ROTATE_BYTES = 5 * 1024 * 1024; // keep the live log small; one .1 backup
const MAX_KEY_LEN = 400;

function clip(s) {
  const str = String(s == null ? '' : s);
  return str.length > MAX_KEY_LEN ? `${str.slice(0, MAX_KEY_LEN)}…` : str;
}

function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(LOG_FILE);
    if (size >= ROTATE_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); // overwrites prior backup
  } catch {
    /* no file yet, or stat/rename failed — ignore */
  }
}

// record({ action, profileId, bucket, key|keys, count, outcome, detail }). `keys`
// is summarized to the first key + a count so a 100k-file op stays one short line.
// Synchronous appendFileSync means each line is written atomically within one tick
// (no interleaving from concurrent async handlers in this single process).
export function record(entry) {
  try {
    const e = entry || {};
    let key;
    let count = e.count;
    if (Array.isArray(e.keys)) {
      key = e.keys.length ? clip(e.keys[0]) : undefined;
      if (count == null) count = e.keys.length;
    } else if (e.key != null) {
      key = clip(e.key);
    }
    const line = {
      ts: new Date().toISOString(),
      action: String(e.action || 'unknown'),
      outcome: e.outcome || 'ok',
      profileId: e.profileId || undefined,
      bucket: e.bucket || undefined,
      key,
      count: count != null ? count : undefined,
      detail: e.detail != null ? clip(e.detail) : undefined,
    };
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    // Auditing must never break the real operation; surface nothing sensitive.
    // eslint-disable-next-line no-console
    console.warn(`[audit] write failed: ${err && err.code ? err.code : 'error'}`);
  }
}

// Most-recent-first parsed entries (capped) + total stats, for the Settings panel.
export function readRecent(limit = 500) {
  let raw = '';
  try {
    raw = fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    return { entries: [], total: 0, bytes: 0 };
  }
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i -= 1) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      /* skip a torn line */
    }
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(LOG_FILE).size;
  } catch {
    /* ignore */
  }
  return { entries, total: lines.length, bytes };
}

// Raw text for export (download). Returns '' if there is no log.
export function readRaw() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function clear() {
  for (const f of [LOG_FILE, `${LOG_FILE}.1`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
}
