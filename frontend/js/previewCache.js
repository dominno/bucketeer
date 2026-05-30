// In-memory LRU cache of already-fetched preview bytes (text & 3D models) so
// re-opening a file is instant. Bounded so it can't grow without limit. Lives
// only for the session; the Settings dialog shows its size and can clear it.
// (Images / video / PDF are additionally cached by the browser via the /view
// endpoint's Cache-Control header — that cache is managed by the browser.)
const CAP = 200 * 1024 * 1024; // 200 MiB
const map = new Map(); // key -> ArrayBuffer
let bytes = 0;

export function cacheGet(key) {
  const v = map.get(key);
  if (v) {
    map.delete(key);
    map.set(key, v); // LRU touch
  }
  return v;
}

export function cacheSet(key, buf) {
  if (buf.byteLength > CAP) return; // never cache a single item bigger than the cap
  if (map.has(key)) bytes -= map.get(key).byteLength;
  map.set(key, buf);
  bytes += buf.byteLength;
  while (bytes > CAP && map.size > 1) {
    const oldest = map.keys().next().value;
    bytes -= map.get(oldest).byteLength;
    map.delete(oldest);
  }
}

export function cacheStats() {
  return { bytes, count: map.size };
}

export function cacheClear() {
  map.clear();
  bytes = 0;
}
