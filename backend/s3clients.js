// Memoized S3Client per profile id. iDrive E2 requires path-style addressing
// and an explicit https endpoint built from the bare host stored on the profile.
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import https from 'node:https';

const cache = new Map(); // profileId -> S3Client

// One shared keep-alive pool for ALL profiles. keepAlive reuses TLS connections
// so 100k tiny GetObjects don't each pay a fresh handshake (a full extra RTT to
// the bucket region); maxSockets (>> the browser's ~6-per-origin cap) ensures
// concurrent /download requests map to parallel upstream sockets instead of
// queueing behind a small pool. connectionTimeout frees a socket if the upstream
// stalls on connect — but we deliberately set NO requestTimeout, because in SDK
// v3 it covers the whole body stream and would kill legitimate large transfers.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 1000 });
const requestHandler = new NodeHttpHandler({ httpsAgent: keepAliveAgent, connectionTimeout: 3000 });

// AWS S3 rejects a request when the endpoint's region doesn't match the SigV4
// signing region (e.g. the global `s3.amazonaws.com` is us-east-1, so it fails
// "expecting us-east-1" when the profile region is eu-central-1). For any AWS
// endpoint, rewrite the host to the region-specific one. Non-AWS endpoints
// (iDrive E2, MinIO, R2, B2, …) already encode their host and are left as-is.
export function resolveHost(endpoint, region) {
  const host = String(endpoint || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const lower = host.toLowerCase();
  if (region && lower.endsWith('.amazonaws.com') && (lower.startsWith('s3.') || lower.startsWith('s3-'))) {
    return `s3.${region}.amazonaws.com`;
  }
  return host;
}

export function getClient(profile) {
  const cached = cache.get(profile.id);
  if (cached) return cached;

  const host = resolveHost(profile.endpoint, profile.region);
  const client = new S3Client({
    endpoint: `https://${host}`,
    region: profile.region,
    forcePathStyle: true, // mandatory for iDrive E2 custom endpoints
    requestHandler, // shared keep-alive pool (see above) — real concurrency for bulk downloads
    credentials: {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
    },
  });
  cache.set(profile.id, client);
  return client;
}

// Call when a profile's credentials/endpoint change or it is deleted, so a
// stale client is not reused.
export function invalidate(profileId) {
  const client = cache.get(profileId);
  if (client) {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
    cache.delete(profileId);
  }
}
