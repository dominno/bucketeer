// All S3 business logic, decoupled from Express. Each function takes an
// S3Client (built per profile) plus plain args, and returns plain data or
// streams to a response. Honors the iDrive E2 quirks documented in the plan:
//   - Content-Type MUST be set on upload (provider defaults to binary/octet-stream)
//   - folders are virtual (zero-byte "prefix/" markers + Delimiter listing)
//   - CopySource MUST be encodeURIComponent(bucket + '/' + key)
//   - DeleteObjects is capped at 1000 keys per call
import {
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import archiver from 'archiver';
import mime from 'mime-types';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_LIST_KEYS, PART_SIZE, QUEUE_SIZE, DELETE_CHUNK } from './config.js';
import { httpError } from './errors.js';

const stripQuotes = (etag) => (typeof etag === 'string' ? etag.replace(/^"|"$/g, '') : etag);
const basename = (key) => {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
};
const contentTypeFor = (key, explicit) => explicit || mime.lookup(key) || 'application/octet-stream';

// RFC 6266 / 5987 Content-Disposition with an ASCII fallback + UTF-8 filename*.
// `type` is 'attachment' (force download) or 'inline' (display in the browser).
function contentDisposition(filename, type = 'attachment') {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 8187 attr-char excludes ' ( ) * which encodeURIComponent leaves intact.
  const enc = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${enc}`;
}

export async function listBuckets(client) {
  const out = await client.send(new ListBucketsCommand({}));
  return (out.Buckets || []).map((b) => ({
    name: b.Name,
    creationDate: b.CreationDate ? b.CreationDate.toISOString() : null,
  }));
}

// Folder-view listing: Delimiter '/' collapses sub-trees into CommonPrefixes.
export async function listObjects(client, bucket, prefix = '', continuationToken) {
  const out = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: MAX_LIST_KEYS,
      ContinuationToken: continuationToken || undefined,
    }),
  );

  const folders = (out.CommonPrefixes || []).map((cp) => ({
    prefix: cp.Prefix,
    name: cp.Prefix.slice(prefix.length).replace(/\/$/, ''),
  }));

  const files = (out.Contents || [])
    // Drop the zero-byte marker that represents the current folder itself.
    .filter((o) => o.Key !== prefix)
    .map((o) => ({
      key: o.Key,
      name: o.Key.slice(prefix.length),
      size: Number(o.Size ?? 0),
      lastModified: o.LastModified ? o.LastModified.toISOString() : null,
      etag: stripQuotes(o.ETag),
    }))
    // A stray "name === ''" would be another marker variant; exclude it.
    .filter((f) => f.name !== '');

  return {
    prefix,
    folders,
    files,
    isTruncated: Boolean(out.IsTruncated),
    nextContinuationToken: out.NextContinuationToken || null,
  };
}

// Glob-aware, case-insensitive match (mirrors frontend matchesQuery): `*`/`?`
// wildcards are anchored; a plain query is a substring match.
function matchName(name, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = name.toLowerCase();
  if (q.includes('*') || q.includes('?')) {
    const re = q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try {
      return new RegExp(`^${re}$`).test(n);
    } catch {
      return n.includes(q);
    }
  }
  return n.includes(q);
}

// Recursively scan objects under `prefix` and return those whose file name matches
// `query`. Bounded PER CALL by a result cap and a scan cap so one request can't hang
// on a huge bucket. Stops only at S3 page boundaries and returns `nextToken` — the
// continuation token to resume from — so the UI can paginate ("load more") through
// the whole bucket without ever re-scanning or missing a match. `nextToken` is null
// once the listing is fully exhausted. `continuationToken` resumes a prior scan.
export async function searchObjects(client, bucket, prefix, query, { max = 1000, continuationToken } = {}) {
  const results = [];
  let token = continuationToken || undefined;
  let scanned = 0;
  const SCAN_CAP = 50000; // objects scanned per call before yielding a nextToken
  let nextToken = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }),
    );
    for (const o of out.Contents || []) {
      scanned += 1;
      if (o.Key.endsWith('/')) continue; // skip folder markers
      const name = basename(o.Key);
      if (!matchName(name, query)) continue;
      results.push({
        key: o.Key,
        name,
        size: Number(o.Size ?? 0),
        lastModified: o.LastModified ? o.LastModified.toISOString() : null,
      });
    }
    const more = out.IsTruncated ? out.NextContinuationToken : null;
    // Stop at the page boundary once we've collected enough results or scanned
    // enough objects — resuming from `more` (next page) loses/duplicates nothing.
    if (results.length >= max || scanned >= SCAN_CAP) {
      nextToken = more;
      break;
    }
    token = more || undefined;
  } while (token);
  return { results, nextToken };
}

// Flat recursive listing of every file under a prefix (key + size), for the
// "download to a folder" feature which writes each object to disk individually.
// `max` is a memory backstop (entries are buffered in RAM and serialized in one
// response), NOT a feature cap — it must sit far above any real folder so a large
// folder is fully enumerated. `truncated` only trips at this ceiling, and the
// frontend treats that as a blocking warning rather than a silent partial.
export async function listTree(client, bucket, prefix, { max = 1_000_000 } = {}) {
  const entries = [];
  let token;
  let truncated = false;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }),
    );
    for (const o of out.Contents || []) {
      if (o.Key.endsWith('/')) continue; // folder markers
      if (entries.length >= max) {
        truncated = true;
        break;
      }
      entries.push({ key: o.Key, size: Number(o.Size ?? 0) });
    }
    if (truncated) break;
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return { entries, truncated };
}

// Streaming variant of listTree: writes one NDJSON line per object ({key,size})
// as it paginates, plus a terminal {done,truncated,count} line. Nothing is
// buffered (memory stays O(1) regardless of folder size), the client sees the
// count grow live even within one huge folder, and a client disconnect (cancel)
// stops the pagination — so an aborted scan does no further S3 work.
export async function streamTree(client, bucket, prefix, res, { max = 1_000_000 } = {}) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  // Respect HTTP backpressure: if the socket buffer is full, wait for 'drain'
  // before queuing more so a fast lister can't balloon memory on a slow client.
  const write = (chunk) => (res.write(chunk) ? Promise.resolve() : new Promise((r) => res.once('drain', r)));

  let count = 0;
  let truncated = false;
  let token;
  do {
    if (closed) return; // client cancelled — stop paginating, do no more S3 work
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }),
    );
    let lines = '';
    for (const o of out.Contents || []) {
      if (o.Key.endsWith('/')) continue; // folder markers
      if (count >= max) {
        truncated = true;
        break;
      }
      lines += `${JSON.stringify({ key: o.Key, size: Number(o.Size ?? 0) })}\n`;
      count += 1;
    }
    if (lines) {
      // eslint-disable-next-line no-await-in-loop
      await write(lines);
    }
    if (truncated) break;
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  if (!closed) {
    res.write(`${JSON.stringify({ done: true, truncated, count })}\n`);
    res.end();
  }
}

export async function headObject(client, bucket, key) {
  const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return {
    key,
    size: Number(out.ContentLength ?? 0),
    lastModified: out.LastModified ? out.LastModified.toISOString() : null,
    etag: stripQuotes(out.ETag),
    contentType: out.ContentType || 'application/octet-stream',
    storageClass: out.StorageClass || 'STANDARD',
    metadata: out.Metadata || {},
  };
}

// Streaming upload via lib-storage (auto-multipart past one part). The
// Content-Type is forced from the file extension because iDrive otherwise
// stores binary/octet-stream, breaking previews and typed downloads.
export async function uploadObject(client, bucket, key, bodyStream, { contentType } = {}) {
  const ct = contentTypeFor(key, contentType);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  bodyStream.on('error', (err) => counter.destroy(err));
  bodyStream.pipe(counter);

  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body: counter, ContentType: ct },
    partSize: PART_SIZE,
    queueSize: QUEUE_SIZE,
    leavePartsOnError: false,
  });
  const out = await upload.done();
  return { key, etag: stripQuotes(out.ETag), size: bytes, contentType: ct };
}

// ---- Client-orchestrated multipart upload (resumable) ----------------------
// The browser slices a large File into parts and drives these. Because the
// UploadId + per-part ETags are exposed (unlike lib-storage's internal Upload),
// a failed/retried upload resumes from the last completed part instead of byte 0.

export async function createMultipart(client, bucket, key, { contentType } = {}) {
  const ct = contentTypeFor(key, contentType);
  const out = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: ct }));
  return { uploadId: out.UploadId, key, contentType: ct };
}

// Stream one part straight from the request body to S3. ContentLength is required
// for a stream Body, so the caller passes the exact part byte length.
export async function uploadPart(client, bucket, key, uploadId, partNumber, body, contentLength) {
  const out = await client.send(
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: contentLength }),
  );
  return { partNumber, etag: stripQuotes(out.ETag) };
}

export async function completeMultipart(client, bucket, key, uploadId, parts) {
  // S3 requires parts in ascending PartNumber order with their exact ETags.
  const Parts = [...parts]
    .map((p) => ({ PartNumber: Number(p.partNumber), ETag: p.etag }))
    .sort((a, b) => a.PartNumber - b.PartNumber);
  const out = await client.send(
    new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts } }),
  );
  return { key, etag: stripQuotes(out.ETag) };
}

export async function abortMultipart(client, bucket, key, uploadId) {
  await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
  return { aborted: true };
}

// Parts S3 has actually stored for an in-progress upload — the source of truth
// for resuming (the client reconciles its persisted ETags against this).
export async function listParts(client, bucket, key, uploadId) {
  const parts = [];
  let token;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: token }),
    );
    for (const p of out.Parts || []) parts.push({ partNumber: p.PartNumber, etag: stripQuotes(p.ETag), size: Number(p.Size ?? 0) });
    token = out.IsTruncated ? out.NextPartNumberMarker : undefined;
  } while (token);
  return { parts };
}

// In-progress multipart uploads under a bucket (optionally a prefix) — used to
// surface and abort orphans left by a hard crash, which silently accrue storage.
export async function listMultipartUploads(client, bucket, { prefix } = {}) {
  const uploads = [];
  let keyMarker;
  let idMarker;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix || undefined, KeyMarker: keyMarker, UploadIdMarker: idMarker }),
    );
    for (const u of out.Uploads || []) {
      uploads.push({ key: u.Key, uploadId: u.UploadId, initiated: u.Initiated ? u.Initiated.toISOString() : null });
    }
    if (out.IsTruncated) {
      keyMarker = out.NextKeyMarker;
      idMarker = out.NextUploadIdMarker;
    } else {
      keyMarker = undefined;
    }
  } while (keyMarker);
  return { uploads };
}

// Stream an object straight to the HTTP response. Sets type/length/disposition
// and tears the upstream body down if the client disconnects mid-download.
export async function downloadObject(client, bucket, key, res, { filename, inline = false, range, ifMatch } = {}) {
  // Forward a Range request to S3 so media seeking / partial fetches work. An
  // optional If-Match makes a resumed download fail with 412 if the object changed
  // since the partial was written — the client then restarts cleanly from byte 0.
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range || undefined, IfMatch: ifMatch || undefined }));
  const name = filename || basename(key);
  res.setHeader('Content-Type', out.ContentType || contentTypeFor(key));
  res.setHeader('Accept-Ranges', 'bytes');
  // Expose the object's ETag so the client can capture it as the resume guard.
  if (out.ETag) res.setHeader('ETag', out.ETag);
  if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
  res.setHeader('Content-Disposition', contentDisposition(name, inline ? 'inline' : 'attachment'));
  // Inline previews are cacheable so re-opening an image/video/PDF doesn't
  // re-download; real (attachment) downloads are never cached.
  res.setHeader('Cache-Control', inline ? 'private, max-age=300' : 'no-store');
  if (range && out.ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', out.ContentRange);
  }

  const body = out.Body;
  res.on('close', () => {
    if (!res.writableEnded && typeof body?.destroy === 'function') body.destroy();
  });
  try {
    await pipeline(body, res);
  } catch (err) {
    // Client aborts surface as premature close / ERR_STREAM_PREMATURE_CLOSE.
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.writableEnded) throw err;
  }
}

// Longest common directory prefix of a set of keys (used to compute zip entry
// names that keep just enough structure to be unambiguous).
function commonDirPrefix(keys) {
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const i = keys[0].lastIndexOf('/');
    return i === -1 ? '' : keys[0].slice(0, i + 1);
  }
  let prefix = keys[0];
  for (const k of keys) {
    while (!k.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  const i = prefix.lastIndexOf('/');
  return i === -1 ? '' : prefix.slice(0, i + 1);
}

// Core zip streamer. `entries` is [{ key, name }]. Objects are fetched ONE AT A
// TIME so we never hold many open S3 connections / buffer the tree in memory. A
// single concurrently-deleted object is skipped, not fatal.
async function pipeZip(res, archiveName, client, bucket, entries) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(`${archiveName}.zip`, 'attachment'));
  res.setHeader('Cache-Control', 'no-store');

  const archive = archiver('zip', { zlib: { level: 6 } });
  let fatal = null;
  archive.on('error', (err) => {
    fatal = err;
    if (!res.writableEnded) res.destroy(err);
  });
  res.on('close', () => {
    if (!res.writableEnded) archive.abort();
  });
  archive.pipe(res);

  for (const { key, name } of entries) {
    if (fatal || res.writableEnded) break;
    try {
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      archive.append(obj.Body, { name });
      // Wait until this entry's source is fully consumed before the next GetObject.
      await new Promise((resolve, reject) => {
        const onEntry = () => {
          cleanup();
          resolve();
        };
        const onErr = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          archive.off('entry', onEntry);
          archive.off('error', onErr);
        };
        archive.once('entry', onEntry);
        archive.once('error', onErr);
      });
    } catch (err) {
      if (fatal) break;
      // eslint-disable-next-line no-console
      console.error(`[zip] skipped ${key}: ${err.message}`);
    }
  }
  if (!fatal && !res.writableEnded) await archive.finalize();
}

// Zip every object under `prefix`, entry names relative to the prefix.
export async function streamFolderZip(client, bucket, prefix, res, { archiveName } = {}) {
  const fileKeys = (await listAllKeys(client, bucket, prefix)).filter((k) => !k.endsWith('/'));
  const entries = fileKeys.map((key) => ({ key, name: key.slice(prefix.length) || basename(key) }));
  await pipeZip(res, archiveName || basename(prefix) || 'download', client, bucket, entries);
}

// Zip an arbitrary SELECTION of keys (files and/or "folder/" prefixes) into one
// archive. Folder prefixes are expanded; entry names keep structure relative to
// the selection's common directory; duplicate names are de-duped.
export async function zipSelection(client, bucket, keys, res, { archiveName } = {}) {
  const fileSet = new Set();
  for (const k of keys) {
    if (k.endsWith('/')) {
      // eslint-disable-next-line no-await-in-loop
      for (const d of await listAllKeys(client, bucket, k)) if (!d.endsWith('/')) fileSet.add(d);
    } else {
      fileSet.add(k);
    }
  }
  const fileKeys = [...fileSet];
  const common = commonDirPrefix(fileKeys);
  const seen = new Map();
  const entries = fileKeys.map((key) => {
    let name = key.slice(common.length) || basename(key);
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    } else {
      seen.set(name, 0);
    }
    return { key, name };
  });
  await pipeZip(res, archiveName || 'download', client, bucket, entries);
}

export async function createFolder(client, bucket, prefix, name) {
  const key = `${prefix}${name}/`;
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: '', ContentType: 'application/x-directory' }),
  );
  return { key };
}

// Collect every key under a prefix (no delimiter), paginating fully.
async function listAllKeys(client, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: token,
      }),
    );
    for (const o of out.Contents || []) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function copyOne(client, bucket, sourceKey, destKey) {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: destKey,
      CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
      MetadataDirective: 'COPY', // preserves the source Content-Type
    }),
  );
}

// True if an object exists at the given key (used to refuse silent overwrite).
async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

// Batch delete, chunked to the 1000-key API limit. Returns deleted keys and any
// per-key errors (never throws on partial failure).
export async function deleteKeys(client, bucket, keys) {
  const deleted = [];
  const errors = [];
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
    const chunk = keys.slice(i, i + DELETE_CHUNK);
    const out = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
      }),
    );
    for (const d of out.Deleted || []) deleted.push(d.Key);
    for (const e of out.Errors || []) errors.push({ key: e.Key, code: e.Code, message: e.Message });
  }
  return { deleted, errors };
}

// Rename/move a single file: copy-first, then delete the original. Refuses to
// clobber an existing destination unless overwrite is explicitly requested.
export async function renameObject(client, bucket, sourceKey, destKey, { overwrite = false } = {}) {
  if (sourceKey.endsWith('/')) {
    return renameFolder(client, bucket, sourceKey, destKey.endsWith('/') ? destKey : `${destKey}/`, { overwrite });
  }
  if (!overwrite && (await objectExists(client, bucket, destKey))) {
    throw httpError(409, 'DEST_EXISTS', `An object named "${destKey}" already exists.`);
  }
  await copyOne(client, bucket, sourceKey, destKey);
  await deleteKeys(client, bucket, [sourceKey]);
  return { sourceKey, destKey, copied: 1, errors: [] };
}

// Rename/move a "folder": recursively copy every descendant to the new prefix
// (copies FIRST), then batch-delete the originals. Partial failures surfaced.
// Refuses to merge into a destination that already contains objects unless
// overwrite is requested.
export async function renameFolder(client, bucket, srcPrefix, dstPrefix, { overwrite = false } = {}) {
  if (!overwrite) {
    const probe = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: dstPrefix, MaxKeys: 1 }));
    if ((probe.Contents || []).length > 0) {
      throw httpError(409, 'DEST_EXISTS', `Destination "${dstPrefix}" already contains objects.`);
    }
  }
  const keys = await listAllKeys(client, bucket, srcPrefix);
  if (keys.length === 0) {
    // Empty folder: just recreate the marker at the destination.
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: dstPrefix, Body: '', ContentType: 'application/x-directory' }),
    );
    return { sourceKey: srcPrefix, destKey: dstPrefix, copied: 0, errors: [] };
  }
  const copyErrors = [];
  let copied = 0;
  for (const key of keys) {
    const destKey = `${dstPrefix}${key.slice(srcPrefix.length)}`;
    try {
      await copyOne(client, bucket, key, destKey);
      copied += 1;
    } catch (err) {
      copyErrors.push({ key, code: err?.name, message: err?.message });
    }
  }
  // Only delete sources that copied successfully.
  const copiedSources = copyErrors.length
    ? keys.filter((k) => !copyErrors.some((e) => e.key === k))
    : keys;
  const del = copiedSources.length ? await deleteKeys(client, bucket, copiedSources) : { deleted: [], errors: [] };
  return { sourceKey: srcPrefix, destKey: dstPrefix, copied, errors: [...copyErrors, ...del.errors] };
}

// Delete a mixed set of file keys and "folder/" prefixes. Folder prefixes are
// expanded to all descendants first; everything is de-duped then chunk-deleted.
export async function deletePaths(client, bucket, keys) {
  const set = new Set();
  for (const key of keys) {
    if (key.endsWith('/')) {
      const descendants = await listAllKeys(client, bucket, key);
      for (const k of descendants) set.add(k);
      set.add(key); // ensure the marker itself goes too
    } else {
      set.add(key);
    }
  }
  return deleteKeys(client, bucket, [...set]);
}

export async function presignGet(client, bucket, key, { filename, expiresIn }) {
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: contentDisposition(filename || basename(key)),
  });
  const url = await getSignedUrl(client, cmd, { expiresIn });
  return { url, expiresIn };
}
