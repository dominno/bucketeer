// File transfer routes. Upload streams multipart form data straight into S3 via
// busboy (no body parser, no in-memory buffering, multipart for large files).
// Download streams the object body to the response. These are mounted WITHOUT
// express.json() so the raw upload stream is never pre-buffered.
import express, { Router } from 'express';
import busboy from 'busboy';
import mime from 'mime-types';
import { asyncHandler } from '../asyncHandler.js';
import { resolveProfile } from '../middleware.js';
import { assertBucket, assertKey, assertPrefix, clampExpires } from '../validate.js';
import {
  uploadObject,
  downloadObject,
  presignGet,
  deleteKeys,
  streamFolderZip,
  zipSelection,
  createMultipart,
  uploadPart,
  completeMultipart,
  abortMultipart,
  listParts,
  listMultipartUploads,
} from '../operations.js';
import { httpError } from '../errors.js';
import * as audit from '../audit.js';

const assertUploadId = (v) => {
  const id = String(v || '').trim();
  if (!id || id.length > 1024) throw httpError(400, 'INVALID_UPLOAD_ID', 'A valid uploadId is required.');
  return id;
};
const assertPartNumber = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw httpError(400, 'INVALID_PART', 'partNumber must be 1..10000.');
  return n;
};

export const transferRouter = Router();
transferRouter.use(resolveProfile);

const lastSegment = (key) => {
  const i = key.lastIndexOf('/');
  return i === -1 ? key : key.slice(i + 1);
};

// POST /upload  (multipart/form-data: fields bucket, prefix; one or more files)
transferRouter.post('/upload', (req, res, next) => {
  let bb;
  const fields = {};
  const pending = [];
  const results = []; // successfully uploaded { key, ... }
  let finished = false;

  // Single failure path: tear down the parser/socket, best-effort delete any
  // objects already written by this (now-failed) request, then forward the error.
  const fail = (err) => {
    if (finished) return;
    finished = true;
    try {
      req.unpipe(bb);
      bb.destroy();
      req.resume(); // drain any unsent body so the socket can close cleanly
    } catch {
      /* ignore */
    }
    const done = () => next(err);
    // Wait for in-flight uploads to settle FIRST — one may complete after this
    // point and would otherwise be an uncleaned orphan — then delete everything
    // this failed request managed to write.
    Promise.allSettled(pending).then(() => {
      const orphans = results.map((r) => r.key);
      if (orphans.length && req.s3 && fields.bucket) {
        deleteKeys(req.s3, fields.bucket, orphans).then(done, done);
      } else {
        done();
      }
    });
  };

  try {
    // defParamCharset 'utf8' so non-ASCII filenames in the multipart
    // Content-Disposition (as browsers send them) are not mangled as latin1.
    bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 100 } });
  } catch (err) {
    return next(err);
  }

  bb.on('field', (name, val) => {
    fields[name] = val;
  });

  bb.on('file', (_fieldname, fileStream, info) => {
    const { filename, mimeType } = info;
    if (finished || !filename) {
      fileStream.resume(); // already failing, or empty part
      return;
    }
    let bucket;
    let prefix;
    let key;
    try {
      bucket = assertBucket(fields.bucket);
      prefix = assertPrefix(fields.prefix || '');
      key = assertKey(`${prefix}${filename}`);
    } catch (err) {
      // Swallow the 'error' that bb.destroy() will emit on this stream,
      // otherwise it surfaces as an uncaughtException and crashes the server.
      fileStream.on('error', () => {});
      fileStream.resume();
      fail(err);
      return;
    }
    // Prefer extension-derived type (correctness for iDrive), then the
    // browser-provided header/part type, else octet-stream (in operations).
    const contentType = mime.lookup(filename) || req.get('X-Content-Type') || mimeType || undefined;
    // .catch on creation guarantees no upload promise is ever left unobserved
    // (which would otherwise be an unhandledRejection if close short-circuits).
    const p = uploadObject(req.s3, bucket, key, fileStream, { contentType })
      .then((r) => {
        results.push(r);
        audit.record({ action: 'upload', profileId: req.profileId, bucket, key });
      })
      .catch((err) => fail(err));
    pending.push(p);
  });

  bb.on('filesLimit', () => fail(httpError(413, 'TOO_MANY_FILES', 'Too many files in a single upload (max 100).')));
  bb.on('error', fail);
  bb.on('close', () => {
    if (finished) return;
    Promise.allSettled(pending).then(() => {
      if (finished) return;
      finished = true;
      res.status(201).json({ uploaded: results });
    });
  });

  req.on('aborted', () => {
    try {
      bb.destroy();
    } catch {
      /* ignore */
    }
  });
  req.pipe(bb);
});

// GET /download?profile=&bucket=&key=
transferRouter.get(
  '/download',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const key = assertKey(req.query.key);
    // Log only full GETs (a 206 Range is a media-seek/preview chunk, not a download).
    if (!req.headers.range) audit.record({ action: 'download', profileId: req.profileId, bucket, key });
    await downloadObject(req.s3, bucket, key, res, { filename: lastSegment(key), range: req.headers.range, ifMatch: req.headers['if-match'] });
  }),
);

// GET /view?profile=&bucket=&key=  — like /download but inline, so the browser
// renders the object (image/pdf/text) instead of saving it. Used by previews.
transferRouter.get(
  '/view',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const key = assertKey(req.query.key);
    await downloadObject(req.s3, bucket, key, res, { filename: lastSegment(key), inline: true, range: req.headers.range });
  }),
);

// GET /download-folder?profile=&bucket=&prefix=  — streams a .zip of everything
// under the prefix, preserving structure. (GET so a plain <a> can trigger it.)
transferRouter.get(
  '/download-folder',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const prefix = assertPrefix(req.query.prefix || '');
    if (!prefix) throw httpError(400, 'INVALID_PREFIX', 'A folder prefix is required.');
    audit.record({ action: 'download.folder', profileId: req.profileId, bucket, key: prefix });
    await streamFolderZip(req.s3, bucket, prefix, res);
  }),
);

// POST /zip-selection  { bucket, keys:[file or "folder/" keys] } -> one streamed
// .zip of the whole selection. Needs its own JSON parser (the router has none, by
// design for the raw upload stream). Profile comes from the X-Profile-Id header.
transferRouter.post(
  '/zip-selection',
  express.json({ limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const { bucket, keys, archiveName } = req.body || {};
    assertBucket(bucket);
    if (!Array.isArray(keys) || keys.length === 0) {
      throw httpError(400, 'INVALID_KEYS', 'keys must be a non-empty array.');
    }
    if (keys.length > 1000) {
      throw httpError(400, 'TOO_MANY_KEYS', 'Select at most 1000 items per zip.');
    }
    keys.forEach((k) => assertKey(k));
    const name = typeof archiveName === 'string' && archiveName.trim() ? archiveName.trim().replace(/[/\\]/g, '_') : 'download';
    audit.record({ action: 'download.zip', profileId: req.profileId, bucket, keys });
    await zipSelection(req.s3, bucket, keys, res, { archiveName: name });
  }),
);

// ---- Resumable multipart upload (client-orchestrated) ----------------------
// The browser slices a large File and drives these endpoints, persisting the
// uploadId + part ETags so a failed/retried upload resumes from the last good
// part. JSON routes get their own parser; the part route streams the raw body.

transferRouter.post(
  '/multipart/create',
  express.json({ limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const { bucket, key, contentType } = req.body || {};
    assertBucket(bucket);
    assertKey(key);
    res.status(201).json(await createMultipart(req.s3, bucket, key, { contentType }));
  }),
);

// PUT /multipart/part?bucket=&key=&uploadId=&partNumber=  (raw body = the part)
transferRouter.put(
  '/multipart/part',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const key = assertKey(req.query.key);
    const uploadId = assertUploadId(req.query.uploadId);
    const partNumber = assertPartNumber(req.query.partNumber);
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len <= 0) throw httpError(411, 'LENGTH_REQUIRED', 'A Content-Length is required for a part.');
    // Tear the upstream part request down cleanly if the client aborts.
    req.on('aborted', () => {});
    res.json(await uploadPart(req.s3, bucket, key, uploadId, partNumber, req, len));
  }),
);

transferRouter.post(
  '/multipart/complete',
  express.json({ limit: '4mb' }), // a 10k-part manifest of {partNumber, etag}
  asyncHandler(async (req, res) => {
    const { bucket, key, uploadId, parts } = req.body || {};
    assertBucket(bucket);
    assertKey(key);
    assertUploadId(uploadId);
    if (!Array.isArray(parts) || parts.length === 0) throw httpError(400, 'INVALID_PARTS', 'parts must be a non-empty array.');
    if (parts.length > 10000) throw httpError(400, 'TOO_MANY_PARTS', 'A multipart upload has at most 10000 parts.');
    parts.forEach((p) => {
      assertPartNumber(p && p.partNumber);
      if (!p.etag || typeof p.etag !== 'string') throw httpError(400, 'INVALID_PART', 'each part needs an etag.');
    });
    const result = await completeMultipart(req.s3, bucket, key, uploadId, parts);
    audit.record({ action: 'upload', profileId: req.profileId, bucket, key, detail: `${parts.length} parts` });
    res.json(result);
  }),
);

transferRouter.post(
  '/multipart/abort',
  express.json({ limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const { bucket, key, uploadId } = req.body || {};
    assertBucket(bucket);
    assertKey(key);
    assertUploadId(uploadId);
    res.json(await abortMultipart(req.s3, bucket, key, uploadId));
  }),
);

// GET /multipart/parts?bucket=&key=&uploadId=  — parts S3 already has (for resume).
transferRouter.get(
  '/multipart/parts',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const key = assertKey(req.query.key);
    const uploadId = assertUploadId(req.query.uploadId);
    res.json(await listParts(req.s3, bucket, key, uploadId));
  }),
);

// GET /multipart/list?bucket=&prefix=  — in-progress uploads (orphan sweep).
transferRouter.get(
  '/multipart/list',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const prefix = req.query.prefix ? assertKey(req.query.prefix) : '';
    res.json(await listMultipartUploads(req.s3, bucket, { prefix }));
  }),
);

// GET /presign?profile=&bucket=&key=&expires=
transferRouter.get(
  '/presign',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const key = assertKey(req.query.key);
    const expiresIn = clampExpires(req.query.expires);
    const result = await presignGet(req.s3, bucket, key, { filename: lastSegment(key), expiresIn });
    // Record the SHARE event — never the signed URL/signature.
    audit.record({ action: 'share.presign', profileId: req.profileId, bucket, key, detail: `expires=${expiresIn}s` });
    res.json(result);
  }),
);
