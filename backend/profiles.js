// Server-side credential profile store. The secret access key is ENCRYPTED AT
// REST (Electron safeStorage / OS keychain in the desktop app, else a local
// AES-256-GCM key file — see secretBox.js). The in-memory cache holds the
// decrypted secret (middleware needs it to build the S3 client); only the on-disk
// form is encrypted. Secrets are never returned to the browser (see redact),
// never logged, and never written to the append-only audit log.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROFILES_PATH } from './config.js';
import { httpError } from './errors.js';
import { seal, open, UndecryptableError, providerName } from './secretBox.js';
import * as audit from './audit.js';

let cache = null; // lazily loaded array of full profiles (with DECRYPTED secrets)
let lockedIds = new Set(); // profiles whose stored secret couldn't be decrypted here

function load() {
  if (cache) return cache;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = [];
      return cache;
    }
    throw err;
  }
  lockedIds = new Set();
  if (Array.isArray(parsed)) {
    // Legacy plaintext store (pre-encryption). Adopt as-is, then re-encrypt at
    // rest immediately so the plaintext window is as short as possible.
    cache = parsed;
    try {
      persist();
    } catch {
      /* read-only fs: keep working from memory, still never weaker than before */
    }
    return cache;
  }
  const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  cache = list.map((p) => {
    try {
      return { ...p, secretAccessKey: open(p.secretAccessKey) };
    } catch (e) {
      if (e instanceof UndecryptableError) {
        // Can't decrypt here (e.g. copied from another machine). Keep the profile
        // visible but locked; preserve the original ciphertext so a later persist
        // does NOT clobber a still-recoverable secret with an encrypted empty string.
        lockedIds.add(p.id);
        return { ...p, secretAccessKey: '', _sealed: p.secretAccessKey };
      }
      throw e;
    }
  });
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(PROFILES_PATH), 0o700);
  } catch {
    /* best effort */
  }
  const onDisk = {
    version: 1,
    profiles: (cache || []).map((p) => {
      const base = { id: p.id, name: p.name, endpoint: p.endpoint, region: p.region, accessKeyId: p.accessKeyId };
      // Locked + not re-entered -> keep the original ciphertext verbatim.
      const sealedSecret = lockedIds.has(p.id) && !p.secretAccessKey && p._sealed ? p._sealed : seal(p.secretAccessKey);
      return { ...base, secretAccessKey: sealedSecret };
    }),
  };
  // Atomic write: this file is now the ONLY copy of the encrypted secrets, so a
  // crash mid-write must never truncate/corrupt it. Write a sibling temp, then rename.
  const tmp = `${PROFILES_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, PROFILES_PATH); // atomic on the same filesystem
}

// Encryption status + locked-profile count for the Settings security panel.
export function securitySummary() {
  load();
  return { encryption: providerName(), profiles: cache.length, locked: lockedIds.size };
}

// Strip any scheme and trailing slash so we always store a bare host.
function normalizeEndpoint(endpoint) {
  return String(endpoint || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

// Public, secret-free view of a profile for API responses. `locked` true means the
// stored secret couldn't be decrypted on this machine — the UI prompts a re-entry.
export function redact(p) {
  const secret = p.secretAccessKey || '';
  return {
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    region: p.region,
    accessKeyId: p.accessKeyId,
    secretPreview: secret ? `••••••••${secret.slice(-4)}` : '',
    locked: lockedIds.has(p.id),
  };
}

export function listProfiles() {
  return load().map(redact);
}

// Internal: full profile incl. secret (used by middleware to build a client).
export function getProfile(id) {
  return load().find((p) => p.id === id) || null;
}

export function getRedacted(id) {
  const p = getProfile(id);
  return p ? redact(p) : null;
}

function assertCredFields({ endpoint, region, accessKeyId, secretAccessKey }) {
  const missing = [];
  if (!endpoint) missing.push('endpoint');
  if (!region) missing.push('region');
  if (!accessKeyId) missing.push('accessKeyId');
  if (!secretAccessKey) missing.push('secretAccessKey');
  if (missing.length) {
    throw httpError(400, 'INVALID_PROFILE', `Missing required field(s): ${missing.join(', ')}`);
  }
}

export function addProfile(input) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const profile = {
    id: randomUUID(),
    name: (input.name && String(input.name).trim()) || endpoint || input.accessKeyId,
    endpoint,
    region: String(input.region || '').trim(),
    accessKeyId: String(input.accessKeyId || '').trim(),
    secretAccessKey: String(input.secretAccessKey || '').trim(),
  };
  assertCredFields(profile);
  load().push(profile);
  persist();
  audit.record({ action: 'profile.add', profileId: profile.id, detail: profile.name });
  return profile;
}

export function updateProfile(id, patch) {
  const list = load();
  const p = list.find((x) => x.id === id);
  if (!p) throw httpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');

  if (patch.name !== undefined) p.name = String(patch.name).trim();
  if (patch.endpoint !== undefined) p.endpoint = normalizeEndpoint(patch.endpoint);
  if (patch.region !== undefined) p.region = String(patch.region).trim();
  if (patch.accessKeyId !== undefined) p.accessKeyId = String(patch.accessKeyId).trim();
  // Only replace the secret if a non-empty one was supplied (blank = keep). A new
  // secret also unlocks a previously-undecryptable profile.
  if (patch.secretAccessKey) {
    p.secretAccessKey = String(patch.secretAccessKey).trim();
    lockedIds.delete(id);
    delete p._sealed;
  }

  assertCredFields(p);
  persist();
  audit.record({ action: 'profile.update', profileId: id });
  return p;
}

export function deleteProfile(id) {
  const list = load();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) throw httpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
  list.splice(idx, 1);
  lockedIds.delete(id);
  persist();
  audit.record({ action: 'profile.delete', profileId: id });
}

// Parse a raw iDrive E2 "Access-Keys (N).txt" paste. Each meaningful line is
// "Label: value"; split on the FIRST colon only (values never contain a colon
// here, but be defensive). Labels seen in the wild:
//   Endpoint / Region Code / Access key ID / Secret Access Key
export function parseIdriveCreds(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw httpError(400, 'PARSE_FAILED', 'No text to parse.');
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const label = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (label === 'endpoint') out.endpoint = normalizeEndpoint(value);
    else if (label === 'region code' || label === 'region') out.region = value;
    else if (label === 'access key id') out.accessKeyId = value;
    else if (label === 'secret access key') out.secretAccessKey = value;
  }
  const missing = ['endpoint', 'region', 'accessKeyId', 'secretAccessKey'].filter((k) => !out[k]);
  if (missing.length) {
    throw httpError(
      400,
      'PARSE_FAILED',
      `Could not find ${missing.join(', ')} in the pasted text. Expected an iDrive E2 Access-Keys file.`,
    );
  }
  // Suggest a friendly default name from the endpoint host.
  out.name = out.endpoint;
  return out;
}

// Test/maintenance hook: drop the in-memory cache so the next call re-reads disk.
export function _resetCache() {
  cache = null;
  lockedIds = new Set();
}
