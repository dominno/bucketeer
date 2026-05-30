// Bucket/object operations for the active profile (JSON in/out). Every route is
// guarded by resolveProfile and validates bucket/key/prefix before touching S3.
import { Router } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { resolveProfile } from '../middleware.js';
import { assertBucket, assertKey, assertPrefix, assertSegment, ensureTrailingSlash } from '../validate.js';
import { httpError } from '../errors.js';
import {
  listBuckets,
  listObjects,
  listTree,
  streamTree,
  searchObjects,
  headObject,
  createFolder,
  renameObject,
  deletePaths,
} from '../operations.js';
import * as audit from '../audit.js';

export const s3Router = Router();
s3Router.use(resolveProfile);

const lastSegment = (key) => {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
};

s3Router.get(
  '/buckets',
  asyncHandler(async (req, res) => {
    res.json({ buckets: await listBuckets(req.s3) });
  }),
);

s3Router.get(
  '/objects',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const prefix = assertPrefix(req.query.prefix || '');
    const result = await listObjects(req.s3, bucket, prefix, req.query.continuationToken);
    res.json(result);
  }),
);

s3Router.get(
  '/list-tree',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const prefix = assertPrefix(req.query.prefix || '');
    // Explicit, route-visible ceiling (memory backstop). Far above any real
    // folder; `truncated` becomes a genuine safety signal the client surfaces.
    res.json(await listTree(req.s3, bucket, prefix, { max: 1_000_000 }));
  }),
);

// Streaming (NDJSON) variant: the folder-to-disk scan reads this so the file count
// grows live and a cancel (client disconnect) stops the server walk mid-stream.
s3Router.get(
  '/list-tree-stream',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const prefix = assertPrefix(req.query.prefix || '');
    await streamTree(req.s3, bucket, prefix, res, { max: 1_000_000 });
  }),
);

s3Router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const prefix = assertPrefix(req.query.prefix || '');
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.json({ results: [], nextToken: null });
      return;
    }
    const continuationToken = req.query.continuationToken ? String(req.query.continuationToken) : undefined;
    res.json(await searchObjects(req.s3, bucket, prefix, q, { continuationToken }));
  }),
);

s3Router.get(
  '/object/meta',
  asyncHandler(async (req, res) => {
    const bucket = assertBucket(req.query.bucket);
    const key = assertKey(req.query.key);
    res.json(await headObject(req.s3, bucket, key));
  }),
);

s3Router.post(
  '/folder',
  asyncHandler(async (req, res) => {
    const { bucket, prefix = '', name } = req.body || {};
    assertBucket(bucket);
    assertPrefix(prefix);
    assertSegment(name);
    const result = await createFolder(req.s3, bucket, prefix, name);
    audit.record({ action: 'folder.create', profileId: req.profileId, bucket, key: `${prefix}${name}/` });
    res.status(201).json(result);
  }),
);

s3Router.post(
  '/rename',
  asyncHandler(async (req, res) => {
    const { bucket, sourceKey, destKey, overwrite } = req.body || {};
    assertBucket(bucket);
    assertKey(sourceKey);
    assertKey(destKey);
    if (sourceKey === destKey) throw httpError(400, 'INVALID_KEY', 'Source and destination are identical.');
    const result = await renameObject(req.s3, bucket, sourceKey, destKey, { overwrite: Boolean(overwrite) });
    audit.record({ action: 'rename', profileId: req.profileId, bucket, key: sourceKey, detail: `-> ${destKey}` });
    res.json(result);
  }),
);

s3Router.post(
  '/move',
  asyncHandler(async (req, res) => {
    const { bucket, sourceKey, destPrefix = '', overwrite } = req.body || {};
    assertBucket(bucket);
    assertKey(sourceKey);
    // A prefix must end in '/', else dest keys silently merge (foo + bar = foobar).
    const destPfx = destPrefix ? ensureTrailingSlash(destPrefix) : '';
    assertPrefix(destPfx);
    const base = lastSegment(sourceKey);
    const destKey = sourceKey.endsWith('/') ? `${destPfx}${base}/` : `${destPfx}${base}`;
    if (sourceKey === destKey) throw httpError(400, 'INVALID_KEY', 'Object is already in that location.');
    // Refuse to move a folder into itself or its own descendant.
    if (sourceKey.endsWith('/') && destKey.startsWith(sourceKey)) {
      throw httpError(400, 'INVALID_MOVE', 'Cannot move a folder into itself.');
    }
    const result = await renameObject(req.s3, bucket, sourceKey, destKey, { overwrite: Boolean(overwrite) });
    audit.record({ action: 'move', profileId: req.profileId, bucket, key: sourceKey, detail: `-> ${destKey}` });
    res.json(result);
  }),
);

s3Router.post(
  '/delete',
  asyncHandler(async (req, res) => {
    const { bucket, keys } = req.body || {};
    assertBucket(bucket);
    if (!Array.isArray(keys) || keys.length === 0) {
      throw httpError(400, 'INVALID_KEYS', 'keys must be a non-empty array.');
    }
    keys.forEach((k) => assertKey(k));
    const result = await deletePaths(req.s3, bucket, keys);
    audit.record({ action: 'delete', profileId: req.profileId, bucket, keys });
    res.json(result);
  }),
);
