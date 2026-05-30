// Client-orchestrated resumable multipart upload. The browser slices a large File
// into parts, uploads them (bounded concurrency) through the backend, and persists
// the UploadId + completed part ETags in localStorage keyed by a file signature.
// So a failed-then-retried upload (the engine re-calls this) RESUMES from the last
// completed part — reconciled against S3's actual ListParts — instead of byte 0.
//
// Returns the same { promise, abort } shape as api.uploadFile, so the upload engine
// treats it identically (transient errors -> retry -> resume; cancel -> abort).
import { api } from './api.js';
import { putTransfer, deleteTransfer } from './transferStore.js';

const PART_CONCURRENCY = 4; // parts in flight (each holds only a lazy Blob slice)
const MIN_PART = 8 * 1024 * 1024; // 8 MiB
// Adaptive part size: S3 allows max 10000 parts, so big files need bigger parts.
// Keep margin (÷9500) and never below the 8 MiB floor — covers up to multi-TB.
function partSizeFor(fileSize) {
  return Math.max(MIN_PART, Math.ceil(fileSize / 9500));
}

// State is keyed by the TASK id (not just the file signature) so two concurrent
// tasks for the same file can never share/clobber state. Resume is within-session
// (a retry re-runs the SAME task id); cross-reload upload resume is intentionally
// not supported (a <input> File can't be re-read after reload without a re-pick),
// so stale keys from a prior session are pruned at boot — see pruneMultipartState.
const KEY_PREFIX = 'bkt:mp:';
const sigKey = (taskId, bucket, key, file) => `${KEY_PREFIX}${taskId}:${bucket}:${key}:${file.size}:${file.lastModified}`;
function loadState(k) {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null');
  } catch {
    return null;
  }
}
function saveState(k, s) {
  try {
    localStorage.setItem(k, JSON.stringify(s));
  } catch {
    /* quota/private mode — resume just won't persist across reload */
  }
}
function clearState(k) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
const abortedErr = () => Object.assign(new Error('Upload cancelled'), { code: 'ABORTED' });

export function multipartUpload(bucket, prefix, file, onProgress, uploadName, taskId, resumeUploadId, fileHandle) {
  const key = `${prefix}${uploadName || file.name}`;
  const ptrId = `mpu-${taskId}`; // IndexedDB pointer id (survives reload; localStorage state doesn't)
  // sentBytes = bytes in COMPLETED parts (durable on S3), persisted into the pointer
  // so an interrupted upload restored after a reload can show "X of Y uploaded" and a
  // partially-filled bar WITHOUT needing an active profile / ListParts at boot.
  // handle = the FileSystemFileHandle (if captured at pick/drop) — structured-cloned
  // so Resume can re-read the file silently instead of forcing a disk re-pick.
  const writePtr = (uploadId, sentBytes = 0) => putTransfer({ id: ptrId, kind: 'upload', bucket, key, uploadId, prefix, uploadName: uploadName || file.name, name: uploadName || file.name, fileSize: file.size, lastModified: file.lastModified, sentBytes, handle: fileHandle || undefined }).catch(() => {});
  const clearPtr = () => deleteTransfer(ptrId).catch(() => {});
  const sk = sigKey(taskId, bucket, key, file);
  const PART = partSizeFor(file.size);
  const totalParts = Math.max(1, Math.ceil(file.size / PART));
  const sizeOf = (n) => (n < totalParts ? PART : file.size - (totalParts - 1) * PART);

  let aborted = false;
  const inFlight = new Set(); // active per-part abort fns

  function abort() {
    aborted = true;
    for (const a of inFlight) {
      try {
        a();
      } catch {
        /* ignore */
      }
    }
  }

  const promise = (async () => {
    // 1) Resume or create. S3's ListParts is the source of truth for which parts
    //    are actually stored (a persisted ETag for a part S3 doesn't have is ignored).
    const done = new Map(); // partNumber -> etag
    // resumeUploadId (cross-reload re-pick): the localStorage state is gone after a
    // reload, so resume the EXACT S3 upload by id and reconcile against ListParts.
    let uploadId = resumeUploadId || (loadState(sk) || {}).uploadId;
    if (uploadId) {
      try {
        const { parts } = await api.mpListParts(bucket, key, uploadId);
        for (const p of parts) if (p.size === sizeOf(p.partNumber)) done.set(p.partNumber, p.etag);
      } catch {
        uploadId = null; // upload no longer exists (aborted/expired) -> start fresh
      }
    }
    if (aborted) throw abortedErr();
    if (!uploadId) {
      done.clear();
      const created = await api.mpCreate(bucket, key, file.type || undefined);
      uploadId = created.uploadId;
      saveState(sk, { uploadId, key });
    }
    // Bytes in COMPLETED parts only (durable on S3) — what a reload can resume from.
    const doneBytes = () => { let s = 0; for (const n of done.keys()) s += sizeOf(n); return s; };
    writePtr(uploadId, doneBytes()); // cross-reload pointer (IndexedDB; not boot-pruned); seed with already-stored parts

    // Progress reflects COMPLETED parts only (server-confirmed). XHR upload progress
    // (e.loaded) reports bytes buffered into the socket, NOT bytes the server has
    // stored, so with several parts in flight it jumps to tens of MB instantly — with
    // an inflated rate/ETA — before anything is durable. That made a brand-new upload
    // look like it had "already sent" 25 MB and a resume look wrong. Counting only
    // finished parts is honest; the bar advances one part-batch at a time.
    const report = () => { if (onProgress) onProgress(Math.min(doneBytes(), file.size)); };
    report(); // reflect already-completed / resumed parts immediately

    const persist = () => saveState(sk, { uploadId, key, parts: [...done].map(([partNumber, etag]) => ({ partNumber, etag })) });

    // 2) Upload the missing parts with bounded concurrency.
    const todo = [];
    for (let n = 1; n <= totalParts; n += 1) if (!done.has(n)) todo.push(n);
    let cursor = 0;
    let failure = null;
    async function worker() {
      while (cursor < todo.length && !aborted && !failure) {
        const n = todo[cursor];
        cursor += 1;
        const start = (n - 1) * PART;
        const blob = file.slice(start, start + sizeOf(n));
        try {
          // No per-part progress callback: in-flight (buffered) bytes overstate true
          // progress, so we only count a part once it's confirmed complete (below).
          // eslint-disable-next-line no-await-in-loop
          const { promise: pp, abort: pa } = api.uploadPart(bucket, key, uploadId, n, blob);
          inFlight.add(pa);
          // eslint-disable-next-line no-await-in-loop
          const { etag } = await pp;
          inFlight.delete(pa);
          done.set(n, etag);
          persist(); // so a crash/retry resumes from here
          writePtr(uploadId, doneBytes()); // keep the reload-surviving byte count current
          report();
        } catch (e) {
          if (!failure) failure = e;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, todo.length) || 1 }, () => worker()));

    if (aborted) {
      await api.mpAbort(bucket, key, uploadId).catch(() => {}); // no orphaned parts billed
      clearState(sk);
      clearPtr();
      throw abortedErr();
    }
    if (failure) throw failure; // transient -> the engine retries -> we resume next call

    // 3) Assemble.
    const parts = [...done].map(([partNumber, etag]) => ({ partNumber, etag })).sort((a, b) => a.partNumber - b.partNumber);
    await api.mpComplete(bucket, key, uploadId, parts);
    clearState(sk);
    clearPtr();
    if (onProgress) onProgress(file.size);
    return { key };
  })();

  return { promise, abort };
}

// Size threshold above which an upload uses resumable multipart instead of the
// single-shot streamed POST. Below this, multipart's overhead isn't worth it.
export const MULTIPART_THRESHOLD = 16 * 1024 * 1024; // 16 MiB

// Reclaim a task's in-progress S3 multipart upload (abort it so no parts are
// billed) and drop its persisted state. Best-effort — used when a failed upload
// is dismissed so dismissing never leaves an orphan. Needs the task's file (for
// the signature) and bucket/key.
export async function abandonMultipart(taskId, bucket, prefix, file, uploadName) {
  if (!file || file.size <= MULTIPART_THRESHOLD) return;
  const key = `${prefix}${uploadName || file.name}`;
  const sk = sigKey(taskId, bucket, key, file);
  const st = loadState(sk);
  clearState(sk);
  deleteTransfer(`mpu-${taskId}`).catch(() => {}); // drop the cross-reload pointer too
  if (st && st.uploadId) await api.mpAbort(bucket, key, st.uploadId).catch(() => {});
}

// Clear ALL persisted multipart state at boot. Keys are session-scoped (by task
// id); ones surviving a reload belong to no live task, so they're dead. This
// bounds localStorage growth. (Open S3 uploads from a crash are reclaimed
// separately via the "clean up incomplete uploads" sweep against the bucket.)
export function pruneMultipartState() {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
