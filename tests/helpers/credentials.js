// Locate and parse the iDrive E2 Access-Keys .txt that ships in the project root
// so tests can authenticate against the real bucket without hardcoded secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function findCredsFile() {
  const override = process.env.E2_CREDS_FILE;
  if (override && fs.existsSync(override)) return override;
  const match = fs
    .readdirSync(PROJECT_ROOT)
    .filter((f) => /^e2-.*access-keys.*\.txt$/i.test(f))
    .sort();
  if (!match.length) {
    throw new Error(
      `No iDrive E2 Access-Keys .txt found in ${PROJECT_ROOT}. ` +
        'Place the credentials file there or set E2_CREDS_FILE.',
    );
  }
  return path.join(PROJECT_ROOT, match[0]);
}

export function parseCreds(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const label = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (label === 'endpoint') out.endpoint = value.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    else if (label === 'region code' || label === 'region') out.region = value;
    else if (label === 'access key id') out.accessKeyId = value;
    else if (label === 'secret access key') out.secretAccessKey = value;
  }
  for (const k of ['endpoint', 'region', 'accessKeyId', 'secretAccessKey']) {
    if (!out[k]) throw new Error(`Credentials file missing "${k}".`);
  }
  return out;
}

export function loadCreds() {
  return parseCreds(fs.readFileSync(findCredsFile(), 'utf8'));
}

export const TEST_BUCKET = process.env.TEST_BUCKET || 'browser-app-test';
