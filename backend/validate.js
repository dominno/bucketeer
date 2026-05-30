// Input validation + path-traversal guards. Run these before building any S3
// command so malformed bucket names / keys never reach the provider and so a
// crafted key can't escape its intended prefix.
import { httpError } from './errors.js';
import { PRESIGN_DEFAULT, PRESIGN_MAX } from './config.js';

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const MAX_KEY_LEN = 1024;

export function assertBucket(bucket) {
  if (typeof bucket !== 'string' || !BUCKET_RE.test(bucket)) {
    throw httpError(400, 'INVALID_BUCKET', `Invalid bucket name: ${JSON.stringify(bucket)}`);
  }
  return bucket;
}

// Shared key/prefix sanity. `allowEmpty` is for prefixes (bucket root === '').
function checkKeyish(value, { allowEmpty, label }) {
  if (value === '' && allowEmpty) return value;
  if (typeof value !== 'string' || value.length === 0) {
    throw httpError(400, 'INVALID_KEY', `${label} must be a non-empty string.`);
  }
  if (value.length > MAX_KEY_LEN) {
    throw httpError(400, 'INVALID_KEY', `${label} exceeds ${MAX_KEY_LEN} characters.`);
  }
  if (value.startsWith('/')) {
    throw httpError(400, 'INVALID_KEY', `${label} must not start with "/".`);
  }
  if (value.includes('\0')) {
    throw httpError(400, 'INVALID_KEY', `${label} must not contain null bytes.`);
  }
  if (value.includes('\\')) {
    throw httpError(400, 'INVALID_KEY', `${label} must not contain backslashes.`);
  }
  if (value.split('/').includes('..')) {
    throw httpError(400, 'INVALID_KEY', `${label} must not contain ".." path segments.`);
  }
  return value;
}

export function assertKey(key) {
  return checkKeyish(key, { allowEmpty: false, label: 'Object key' });
}

export function assertPrefix(prefix) {
  return checkKeyish(prefix ?? '', { allowEmpty: true, label: 'Prefix' });
}

// A single path component (folder or file name typed by the user). No slashes,
// no traversal, no control chars.
export function assertSegment(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw httpError(400, 'INVALID_NAME', 'Name must be a non-empty string.');
  }
  if (name === '.' || name === '..') {
    throw httpError(400, 'INVALID_NAME', 'Name must not be "." or "..".');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\/\\\0\r\n]/.test(name)) {
    throw httpError(400, 'INVALID_NAME', 'Name must not contain slashes, backslashes or control characters.');
  }
  return name;
}

export function ensureTrailingSlash(s) {
  return s.endsWith('/') ? s : `${s}/`;
}

export function clampExpires(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return PRESIGN_DEFAULT;
  return Math.min(Math.max(Math.trunc(num), 1), PRESIGN_MAX);
}
