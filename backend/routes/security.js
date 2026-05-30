// App-level security surface (profileless): at-rest encryption status + the
// append-only audit log (recent entries, raw export, clear). No secrets here.
import { Router } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { securitySummary } from '../profiles.js';
import { readRecent, readRaw, clear } from '../audit.js';

export const securityRouter = Router();

// Encryption provider + audit stats for the Settings security panel.
securityRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const sec = securitySummary(); // { encryption, profiles, locked }
    const { total, bytes } = readRecent(0);
    res.json({ ...sec, audit: { entries: total, bytes } });
  }),
);

// Most-recent-first audit entries (capped) for the in-app viewer.
securityRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    res.json(readRecent(limit));
  }),
);

// Plain-text export (download). Browser saves it via Content-Disposition.
securityRouter.get(
  '/audit/export',
  asyncHandler(async (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bucketeer-audit.log"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(readRaw());
  }),
);

securityRouter.delete(
  '/audit',
  asyncHandler(async (_req, res) => {
    clear();
    res.status(204).end();
  }),
);
