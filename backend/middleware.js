// Resolve the active credential profile for a request and attach a ready S3
// client. Profile id comes from the X-Profile-Id header (used by JSON/upload
// routes) or the ?profile= query param (used by browser-navigated GET routes
// like download/presign, which cannot set custom headers).
import { getProfile } from './profiles.js';
import { getClient } from './s3clients.js';
import { httpError } from './errors.js';

export function resolveProfile(req, _res, next) {
  // The ?profile= fallback exists only for browser-navigated GETs (download,
  // presign) that cannot set headers. State-changing requests must use the
  // X-Profile-Id header, which is not attacker-settable cross-origin.
  const id = req.get('X-Profile-Id') || (req.method === 'GET' ? req.query.profile : undefined);
  if (!id) {
    return next(httpError(400, 'PROFILE_REQUIRED', 'Missing profile (X-Profile-Id header or ?profile=).'));
  }
  const profile = getProfile(id);
  if (!profile) {
    return next(httpError(404, 'PROFILE_NOT_FOUND', 'Unknown profile id.'));
  }
  req.profileId = id;
  req.profile = profile;
  req.s3 = getClient(profile);
  next();
}
