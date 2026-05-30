// Credential profile management. Responses are always redacted (no secrets).
import { Router } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import {
  listProfiles,
  addProfile,
  getRedacted,
  updateProfile,
  deleteProfile,
  parseIdriveCreds,
  getProfile,
  redact,
} from '../profiles.js';
import { invalidate } from '../s3clients.js';
import { getClient } from '../s3clients.js';
import { listBuckets } from '../operations.js';
import { httpError } from '../errors.js';

export const profilesRouter = Router();

profilesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ profiles: listProfiles() });
  }),
);

// Parse a pasted iDrive Access-Keys .txt into form fields (no secret stored).
profilesRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const parsed = parseIdriveCreds(req.body?.text);
    res.json(parsed);
  }),
);

profilesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const profile = addProfile(req.body || {});
    res.status(201).json({ profile: redact(profile) });
  }),
);

profilesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const profile = getRedacted(req.params.id);
    if (!profile) throw httpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
    res.json({ profile });
  }),
);

profilesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const profile = updateProfile(req.params.id, req.body || {});
    invalidate(req.params.id); // creds/endpoint may have changed
    res.json({ profile: redact(profile) });
  }),
);

profilesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    deleteProfile(req.params.id);
    invalidate(req.params.id);
    res.status(204).end();
  }),
);

// Live credential check via ListBuckets.
profilesRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const profile = getProfile(req.params.id);
    if (!profile) throw httpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
    const buckets = await listBuckets(getClient(profile));
    res.json({ ok: true, bucketCount: buckets.length });
  }),
);
