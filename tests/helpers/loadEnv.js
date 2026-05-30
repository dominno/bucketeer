// Minimal .env loader for the test runners (Node won't read .env on its own, and
// we avoid a dotenv dependency). Reads PROJECT_ROOT/.env, sets any KEY=VALUE that
// isn't already in process.env, and resolves a relative E2_CREDS_FILE against the
// project root so it works regardless of the runner's CWD. No-op if .env is absent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEnv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
  } catch {
    return; // no .env — nothing to do
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!key || process.env[key] !== undefined) continue;
    if (key === 'E2_CREDS_FILE' && value && !path.isAbsolute(value)) {
      value = path.join(PROJECT_ROOT, value);
    }
    process.env[key] = value;
  }
}

loadEnv();
