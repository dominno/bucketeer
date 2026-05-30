// Central paths and tunable constants. No side effects on import.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backend/ lives one level under the project root.
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
// Overridable so tests can point at a throwaway file instead of the real store.
export const PROFILES_PATH = process.env.PROFILES_PATH || path.join(CONFIG_DIR, 'profiles.json');
export const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');

export const DEFAULT_PORT = Number(process.env.PORT) || 5173;
export const BIND_HOST = '127.0.0.1';

// Upload tuning for @aws-sdk/lib-storage Upload (multipart kicks in past one part).
export const PART_SIZE = 8 * 1024 * 1024; // 8 MiB
export const QUEUE_SIZE = 4; // concurrent multipart parts

// ListObjectsV2 page size for the folder view.
export const MAX_LIST_KEYS = 200;

// Presigned URL bounds (seconds). SigV4 hard-caps at 7 days.
export const PRESIGN_DEFAULT = 600;
export const PRESIGN_MAX = 7 * 24 * 60 * 60; // 604800

// DeleteObjects API limit per request.
export const DELETE_CHUNK = 1000;

// Host-header allowlist (DNS-rebinding guard). Port is stripped before checking.
export const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
