// Shared test utilities: a deterministic per-run prefix, hashing, a raw S3
// client for teardown, and a self-cleaning prefix sweep. All test objects live
// under qa/<uuid>/ so runs never collide and cleanup is total.
import { createHash, randomUUID } from 'node:crypto';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

export const RUN_PREFIX = process.env.TEST_RUN_PREFIX || `qa/${randomUUID()}/`;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function rawClient(creds) {
  return new S3Client({
    endpoint: `https://${creds.endpoint.replace(/^https?:\/\//i, '')}`,
    region: creds.region,
    forcePathStyle: true,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

// Make a profile through the running API and return its id.
export async function makeProfileViaApi(base, creds, name = 'integration-test') {
  const res = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...creds }),
  });
  if (!res.ok) throw new Error(`Failed to create test profile: ${res.status}`);
  const { profile } = await res.json();
  return profile.id;
}

// Delete everything under a prefix (paginated, chunked to 1000).
export async function sweepPrefix(client, bucket, prefix) {
  let token;
  let removed = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }),
    );
    const objects = (out.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length) {
      // eslint-disable-next-line no-await-in-loop
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      removed += objects.length;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return removed;
}
