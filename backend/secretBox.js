// At-rest encryption for the one secret we store: the S3 secretAccessKey.
//
// Provider, chosen at call time:
//   1. Electron safeStorage (OS keychain on macOS, DPAPI on Windows, libsecret on
//      Linux) when running inside the desktop app — strong, key never on disk.
//   2. A local AES-256-GCM key file (.secret-key, 0600) otherwise (dev / `node
//      backend/server.js` / tests). Pure Node crypto, no native deps.
//
// seal()/open() are synchronous (persist/load are sync). Sealed values are tagged
// so open() knows which provider produced them; an untagged string is treated as
// LEGACY PLAINTEXT and returned as-is so the store can transparently re-encrypt it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PROFILES_PATH } from './config.js';

const STORE_DIR = path.dirname(PROFILES_PATH);
const KEY_FILE = path.join(STORE_DIR, '.secret-key');

const ES = 'bktenc:es:'; // Electron safeStorage (base64)
const AES = 'bktenc:aes:'; // local AES-256-GCM (iv:tag:ct, all base64)

// Thrown when sealed data cannot be decrypted on this machine (e.g. safeStorage
// ciphertext copied from another OS account, a wiped keychain, or a missing/rotated
// key file). The store turns this into a "re-enter your secret" state, never a crash.
export class UndecryptableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'UndecryptableError';
  }
}

let _safeStorage; // memoized electron.safeStorage ref (or null)
function safeStorage() {
  if (_safeStorage !== undefined) return _safeStorage;
  try {
    // `electron` resolves only inside the Electron main process; in plain Node this
    // throws synchronously and we fall back. createRequire keeps seal/open sync.
    const require = createRequire(import.meta.url);
    const electron = require('electron');
    _safeStorage = electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    _safeStorage = null;
  }
  return _safeStorage;
}

function electronUsable() {
  const ss = safeStorage();
  try {
    return !!ss && ss.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadOrCreateKey() {
  let present;
  try {
    present = fs.readFileSync(KEY_FILE);
  } catch {
    present = null; // missing — create a fresh key below
  }
  if (present && present.length === 32) return present;
  // A present-but-wrong-length key (truncated/partial write/corrupt copy) must NOT
  // be overwritten in place — that would destroy any chance of restoring the real
  // key from a backup. Quarantine it aside, then mint a fresh key.
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(STORE_DIR, 0o700); // lock down even if the dir pre-existed
  } catch {
    /* best effort */
  }
  if (present) {
    try {
      fs.renameSync(KEY_FILE, `${KEY_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* best effort — fall through to overwrite only if we cannot quarantine */
    }
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    /* best effort */
  }
  return key;
}

// Which provider WOULD be used for a new seal — surfaced in the Settings security
// panel. Never reveals key material.
export function providerName() {
  return electronUsable() ? 'keychain' : 'localkey';
}

export function seal(plaintext) {
  const s = String(plaintext == null ? '' : plaintext);
  if (electronUsable()) {
    return ES + safeStorage().encryptString(s).toString('base64');
  }
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${AES}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function open(sealed) {
  if (typeof sealed !== 'string') return '';
  // Legacy plaintext (pre-encryption store): return as-is so it migrates on persist.
  if (!sealed.startsWith(ES) && !sealed.startsWith(AES)) return sealed;

  if (sealed.startsWith(ES)) {
    if (!electronUsable()) throw new UndecryptableError('safeStorage unavailable for this profile.');
    try {
      return safeStorage().decryptString(Buffer.from(sealed.slice(ES.length), 'base64'));
    } catch {
      throw new UndecryptableError('Could not decrypt secret (different machine/account or reset keychain).');
    }
  }
  // AES
  try {
    const [ivB64, tagB64, ctB64] = sealed.slice(AES.length).split(':');
    const key = loadOrCreateKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new UndecryptableError('Could not decrypt secret (missing or rotated local key).');
  }
}

// Is a stored value already in an encrypted (tagged) form?
export function isSealed(value) {
  return typeof value === 'string' && (value.startsWith(ES) || value.startsWith(AES));
}
