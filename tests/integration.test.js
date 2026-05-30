// End-to-end backend integration tests against the REAL iDrive E2 bucket.
// Boots the Express app in-process on an ephemeral port, drives every operation
// through the HTTP API, and cleans up all objects under a unique run prefix.
import './helpers/loadEnv.js'; // populate E2_CREDS_FILE etc. from .env (no-op if absent)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { loadCreds, TEST_BUCKET } from './helpers/credentials.js';
import { RUN_PREFIX, sha256, rawClient, makeProfileViaApi, sweepPrefix } from './helpers/s3-fixture.js';

let creds;
let server;
let base;
let profileId;
let raw;
const profilesFile = path.join(os.tmpdir(), `clud-itest-profiles-${randomUUID()}.json`);

// --- HTTP helpers ---
async function apiJson(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Profile-Id': profileId, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function uploadViaApi(prefix, filename, buf) {
  const fd = new FormData();
  fd.append('bucket', TEST_BUCKET);
  fd.append('prefix', prefix);
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(`${base}/api/transfer/upload`, { method: 'POST', headers: { 'X-Profile-Id': profileId }, body: fd });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function downloadBytes(key) {
  const url = `${base}/api/transfer/download?profile=${encodeURIComponent(profileId)}&bucket=${encodeURIComponent(TEST_BUCKET)}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, contentType: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
}

before(async () => {
  creds = loadCreds();
  raw = rawClient(creds);
  process.env.PROFILES_PATH = profilesFile;
  const { createApp } = await import('../backend/server.js');
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  profileId = await makeProfileViaApi(base, creds);
});

after(async () => {
  try {
    await sweepPrefix(raw, TEST_BUCKET, RUN_PREFIX);
  } finally {
    if (server) server.close();
    try {
      fs.unlinkSync(profilesFile);
    } catch {
      /* ignore */
    }
  }
});

test('resolveHost normalizes AWS endpoints to the region and leaves others alone', async () => {
  const { resolveHost } = await import('../backend/s3clients.js');
  // AWS: region-mismatched / generic endpoints become the regional endpoint.
  assert.equal(resolveHost('s3.amazonaws.com', 'eu-central-1'), 's3.eu-central-1.amazonaws.com');
  assert.equal(resolveHost('https://s3.amazonaws.com/', 'us-west-2'), 's3.us-west-2.amazonaws.com');
  assert.equal(resolveHost('s3-eu-west-1.amazonaws.com', 'eu-west-1'), 's3.eu-west-1.amazonaws.com');
  assert.equal(resolveHost('s3.us-east-1.amazonaws.com', 'us-east-1'), 's3.us-east-1.amazonaws.com');
  // Non-AWS providers are untouched.
  assert.equal(resolveHost('m2o3.fra.idrivee2-58.com', 'eu-central-2'), 'm2o3.fra.idrivee2-58.com');
  assert.equal(resolveHost('s3.us-west-002.backblazeb2.com', 'us-west-002'), 's3.us-west-002.backblazeb2.com');
  assert.equal(resolveHost('abc123.r2.cloudflarestorage.com', 'auto'), 'abc123.r2.cloudflarestorage.com');
});

test('smoke: ListBuckets includes the test bucket', async () => {
  const { status, data } = await apiJson('GET', '/api/buckets');
  assert.equal(status, 200);
  assert.ok(data.buckets.some((b) => b.name === TEST_BUCKET), `expected ${TEST_BUCKET} in bucket list`);
});

test('wrong secret -> 401 SignatureDoesNotMatch', async () => {
  const { data: created } = await apiJson('POST', '/api/profiles', { name: 'bad-secret', ...creds, secretAccessKey: 'totally-wrong-secret' });
  const id = created.profile.id;
  const res = await fetch(`${base}/api/profiles/${id}/test`, { method: 'POST' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'SignatureDoesNotMatch');
  await fetch(`${base}/api/profiles/${id}`, { method: 'DELETE' });
});

test('wrong access key id -> 401 InvalidAccessKeyId', async () => {
  const { data: created } = await apiJson('POST', '/api/profiles', { name: 'bad-key', ...creds, accessKeyId: 'NOPEKEYDOESNOTEXIST' });
  const id = created.profile.id;
  const res = await fetch(`${base}/api/profiles/${id}/test`, { method: 'POST' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'InvalidAccessKeyId');
  await fetch(`${base}/api/profiles/${id}`, { method: 'DELETE' });
});

test('create folder -> appears as a CommonPrefix and head marker is 0 bytes', async () => {
  const folder = 'folders-test';
  const { status } = await apiJson('POST', '/api/folder', { bucket: TEST_BUCKET, prefix: RUN_PREFIX, name: folder });
  assert.equal(status, 201);
  const { data } = await apiJson('GET', `/api/objects?bucket=${TEST_BUCKET}&prefix=${encodeURIComponent(RUN_PREFIX)}`);
  assert.ok(data.folders.some((f) => f.name === folder), 'folder should show as CommonPrefix');
  const meta = await apiJson('GET', `/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent(`${RUN_PREFIX}${folder}/`)}`);
  assert.equal(meta.status, 200);
  assert.equal(meta.data.size, 0);
});

test('upload .txt forces Content-Type text/plain (not binary/octet-stream)', async () => {
  const key = `${RUN_PREFIX}ct/hello.txt`;
  const body = Buffer.from('the quick brown fox\n');
  const up = await uploadViaApi(`${RUN_PREFIX}ct/`, 'hello.txt', body);
  assert.equal(up.status, 201);
  assert.equal(up.data.uploaded[0].contentType, 'text/plain');
  const meta = await apiJson('GET', `/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent(key)}`);
  assert.equal(meta.data.contentType, 'text/plain');
  assert.notEqual(meta.data.contentType, 'binary/octet-stream');
  assert.equal(meta.data.size, body.length);
});

test('uploaded file appears in listing, downloads byte-for-byte', async () => {
  const key = `${RUN_PREFIX}dl/data.txt`;
  const body = Buffer.from(`download-roundtrip ${randomUUID()}\n`.repeat(50));
  await uploadViaApi(`${RUN_PREFIX}dl/`, 'data.txt', body);
  const list = await apiJson('GET', `/api/objects?bucket=${TEST_BUCKET}&prefix=${encodeURIComponent(`${RUN_PREFIX}dl/`)}`);
  assert.ok(list.data.files.some((f) => f.name === 'data.txt'));
  const dl = await downloadBytes(key);
  assert.equal(dl.status, 200);
  assert.equal(sha256(dl.buf), sha256(body), 'downloaded bytes must match uploaded');
  assert.match(dl.disposition || '', /attachment/);
});

test('presigned URL serves identical bytes from the iDrive host', async () => {
  const key = `${RUN_PREFIX}presign/p.txt`;
  const body = Buffer.from('presigned content\n');
  await uploadViaApi(`${RUN_PREFIX}presign/`, 'p.txt', body);
  const { status, data } = await apiJson('GET', `/api/transfer/presign?profile=${profileId}&bucket=${TEST_BUCKET}&key=${encodeURIComponent(key)}&expires=120`);
  assert.equal(status, 200);
  assert.match(data.url, new RegExp(creds.endpoint.replace(/\./g, '\\.')));
  const res = await fetch(data.url);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(sha256(buf), sha256(body));
});

test('rename: old key 404s, new key 200s with identical bytes', async () => {
  const src = `${RUN_PREFIX}rename/before.txt`;
  const dst = `${RUN_PREFIX}rename/after.txt`;
  const body = Buffer.from('rename me\n');
  await uploadViaApi(`${RUN_PREFIX}rename/`, 'before.txt', body);
  const { status } = await apiJson('POST', '/api/rename', { bucket: TEST_BUCKET, sourceKey: src, destKey: dst });
  assert.equal(status, 200);
  const oldMeta = await apiJson('GET', `/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent(src)}`);
  assert.equal(oldMeta.status, 404);
  const dl = await downloadBytes(dst);
  assert.equal(dl.status, 200);
  assert.equal(sha256(dl.buf), sha256(body));
});

test('multipart upload (>8 MiB) round-trips correctly', async () => {
  const SIZE = 9 * 1024 * 1024; // exceeds 8 MiB part size -> exercises multipart
  const big = Buffer.allocUnsafe(SIZE);
  for (let i = 0; i < SIZE; i += 1) big[i] = (i * 31) % 256;
  const key = `${RUN_PREFIX}big/large.bin`;
  const up = await uploadViaApi(`${RUN_PREFIX}big/`, 'large.bin', big);
  assert.equal(up.status, 201);
  assert.equal(up.data.uploaded[0].size, SIZE);
  const meta = await apiJson('GET', `/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent(key)}`);
  assert.equal(meta.data.size, SIZE);
  const dl = await downloadBytes(key);
  assert.equal(sha256(dl.buf), sha256(big), 'multipart download must match');
});

test('special-character filename round-trips through upload/list/download', async () => {
  const name = 'wéird name (v2) #1 &ok.txt';
  const key = `${RUN_PREFIX}special/${name}`;
  const body = Buffer.from('special chars ok\n');
  const up = await uploadViaApi(`${RUN_PREFIX}special/`, name, body);
  assert.equal(up.status, 201);
  const list = await apiJson('GET', `/api/objects?bucket=${TEST_BUCKET}&prefix=${encodeURIComponent(`${RUN_PREFIX}special/`)}`);
  assert.ok(list.data.files.some((f) => f.name === name), 'special-char file should be listed');
  const dl = await downloadBytes(key);
  assert.equal(dl.status, 200);
  assert.equal(sha256(dl.buf), sha256(body));
});

test('content-type matrix is set from extension', async () => {
  const cases = [
    ['a.txt', 'text/plain'],
    ['b.json', 'application/json'],
    ['c.png', 'image/png'],
    ['d.csv', 'text/csv'],
    ['noext', 'application/octet-stream'],
  ];
  for (const [filename, expected] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const up = await uploadViaApi(`${RUN_PREFIX}matrix/`, filename, Buffer.from(`x-${filename}`));
    assert.equal(up.status, 201);
    assert.equal(up.data.uploaded[0].contentType, expected, `${filename} -> ${expected}`);
  }
});

test('10 concurrent uploads all land', async () => {
  const prefix = `${RUN_PREFIX}concurrent/`;
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => uploadViaApi(prefix, `c${i}.txt`, Buffer.from(`concurrent ${i}\n`))),
  );
  const list = await apiJson('GET', `/api/objects?bucket=${TEST_BUCKET}&prefix=${encodeURIComponent(prefix)}`);
  assert.equal(list.data.files.length, 10);
});

test('recursive delete removes a folder and all descendants', async () => {
  const prefix = `${RUN_PREFIX}deltree/`;
  await uploadViaApi(prefix, 'one.txt', Buffer.from('1'));
  await uploadViaApi(`${prefix}sub/`, 'two.txt', Buffer.from('2'));
  const del = await apiJson('POST', '/api/delete', { bucket: TEST_BUCKET, keys: [prefix] });
  assert.equal(del.status, 200);
  assert.ok(del.data.deleted.length >= 2, 'should delete both descendants');
  const list = await apiJson('GET', `/api/objects?bucket=${TEST_BUCKET}&prefix=${encodeURIComponent(prefix)}`);
  assert.equal(list.data.files.length, 0);
  assert.equal(list.data.folders.length, 0);
});

test('startServer(0) boots on a loopback port and serves health (the Electron path)', async () => {
  // Mirrors exactly what electron/main.js does: dynamic-import startServer and
  // listen on an OS-assigned port.
  const { startServer } = await import('../backend/server.js');
  const srv = await startServer(0);
  try {
    const addr = srv.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0);
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('download-folder streams a structure-preserving zip', async () => {
  await uploadViaApi(`${RUN_PREFIX}zip/`, 'top.txt', Buffer.from('top level\n'));
  await uploadViaApi(`${RUN_PREFIX}zip/sub/`, 'deep.txt', Buffer.from('nested\n'));
  const url = `${base}/api/transfer/download-folder?profile=${encodeURIComponent(profileId)}&bucket=${encodeURIComponent(TEST_BUCKET)}&prefix=${encodeURIComponent(`${RUN_PREFIX}zip/`)}`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') || '', /zip\.zip/);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `clud-zip-${randomUUID()}.zip`);
  fs.writeFileSync(tmp, buf);
  try {
    const entries = execSync(`unzip -Z1 ${JSON.stringify(tmp)}`, { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    assert.deepEqual(entries, ['sub/deep.txt', 'top.txt'], 'zip must preserve the folder structure');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('zip-selection zips an arbitrary mix of files and folders into one archive', async () => {
  await uploadViaApi(`${RUN_PREFIX}sel/`, 'a.txt', Buffer.from('A\n'));
  await uploadViaApi(`${RUN_PREFIX}sel/`, 'b.txt', Buffer.from('B\n'));
  await uploadViaApi(`${RUN_PREFIX}sel/docs/`, 'c.txt', Buffer.from('C\n'));
  // Select one loose file + a whole folder.
  const res = await fetch(`${base}/api/transfer/zip-selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Profile-Id': profileId },
    body: JSON.stringify({ bucket: TEST_BUCKET, keys: [`${RUN_PREFIX}sel/a.txt`, `${RUN_PREFIX}sel/docs/`], archiveName: 'selection' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') || '', /selection\.zip/);
  const tmp = path.join(os.tmpdir(), `clud-sel-${randomUUID()}.zip`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    const entries = execSync(`unzip -Z1 ${JSON.stringify(tmp)}`, { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    // common dir is sel/, so entries keep just enough structure.
    assert.deepEqual(entries, ['a.txt', 'docs/c.txt']);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('zip-selection rejects an empty or oversized key list', async () => {
  const empty = await apiJson('POST', '/api/transfer/zip-selection', { bucket: TEST_BUCKET, keys: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error.code, 'INVALID_KEYS');
});

test('search finds files recursively across subfolders (with glob)', async () => {
  await uploadViaApi(`${RUN_PREFIX}srch/`, 'top.fbx', Buffer.from('a'));
  await uploadViaApi(`${RUN_PREFIX}srch/sub/`, 'deep.fbx', Buffer.from('b'));
  await uploadViaApi(`${RUN_PREFIX}srch/sub/`, 'note.txt', Buffer.from('c'));
  const enc = encodeURIComponent;
  const glob = await apiJson('GET', `/api/search?bucket=${TEST_BUCKET}&prefix=${enc(`${RUN_PREFIX}srch/`)}&q=${enc('*.fbx')}`);
  assert.equal(glob.status, 200);
  assert.deepEqual(glob.data.results.map((r) => r.name).sort(), ['deep.fbx', 'top.fbx']);
  assert.equal(glob.data.results.find((r) => r.name === 'deep.fbx').key, `${RUN_PREFIX}srch/sub/deep.fbx`);
  // plain substring works too
  const sub = await apiJson('GET', `/api/search?bucket=${TEST_BUCKET}&prefix=${enc(`${RUN_PREFIX}srch/`)}&q=fbx`);
  assert.equal(sub.data.results.length, 2);
});

test('list-tree returns every file under a prefix recursively with sizes (no folder markers)', async () => {
  const root = `${RUN_PREFIX}tree/`;
  await uploadViaApi(root, 'a.txt', Buffer.from('aa')); // 2 bytes
  await uploadViaApi(`${root}sub/`, 'b.bin', Buffer.from('bbbb')); // 4 bytes
  await uploadViaApi(`${root}sub/deep/`, 'c.dat', Buffer.from('cccccc')); // 6 bytes
  const enc = encodeURIComponent;
  const res = await apiJson('GET', `/api/list-tree?bucket=${TEST_BUCKET}&prefix=${enc(root)}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.truncated, false);
  const byKey = Object.fromEntries(res.data.entries.map((e) => [e.key.slice(root.length), e.size]));
  assert.deepEqual(byKey, { 'a.txt': 2, 'sub/b.bin': 4, 'sub/deep/c.dat': 6 });
  // The implicit folder markers (sub/, sub/deep/) must NOT appear as entries.
  assert.ok(!res.data.entries.some((e) => e.key.endsWith('/')));
});

test('list-tree-stream emits every file as NDJSON + a terminal done marker (the folder-scan source)', async () => {
  const root = `${RUN_PREFIX}stream/`;
  await uploadViaApi(root, 'a.txt', Buffer.from('aa'));
  await uploadViaApi(`${root}sub/`, 'b.bin', Buffer.from('bbbb'));
  await uploadViaApi(`${root}sub/deep/`, 'c.dat', Buffer.from('cccccc'));
  const url = `${base}/api/list-tree-stream?bucket=${encodeURIComponent(TEST_BUCKET)}&prefix=${encodeURIComponent(root)}`;
  const res = await fetch(url, { headers: { 'X-Profile-Id': profileId } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /ndjson/);
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = lines.find((l) => l.done);
  const entries = lines.filter((l) => !l.done);
  assert.ok(done, 'stream ends with a terminal done marker');
  assert.equal(done.truncated, false);
  assert.equal(done.count, 3);
  const byRel = Object.fromEntries(entries.map((e) => [e.key.slice(root.length), e.size]));
  assert.deepEqual(byRel, { 'a.txt': 2, 'sub/b.bin': 4, 'sub/deep/c.dat': 6 });
  assert.ok(!entries.some((e) => e.key.endsWith('/')), 'no folder markers streamed');
});

test('listTree caps at max and reports truncated — the flag the folder-to-disk download blocks on', async () => {
  const { listTree } = await import('../backend/operations.js');
  const root = `${RUN_PREFIX}cap/`;
  await uploadViaApi(root, 'f1.txt', Buffer.from('1'));
  await uploadViaApi(root, 'f2.txt', Buffer.from('2'));
  await uploadViaApi(root, 'f3.txt', Buffer.from('3'));
  // Below the cap: every file, truncated=false (the normal path; download proceeds).
  const full = await listTree(raw, TEST_BUCKET, root, { max: 1_000_000 });
  assert.equal(full.entries.length, 3);
  assert.equal(full.truncated, false);
  // At the cap: exactly `max` entries and truncated=true, so the client can
  // surface a blocking "download will be INCOMPLETE" warning instead of silently
  // dropping files (the bug at 50k that this raised ceiling + flag fixes).
  const capped = await listTree(raw, TEST_BUCKET, root, { max: 2 });
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.truncated, true);
});

test('resumable multipart upload: create -> parts -> listParts -> complete -> byte-exact download', async () => {
  const enc = encodeURIComponent;
  const key = `${RUN_PREFIX}mp/big.bin`;
  const part1 = Buffer.alloc(5 * 1024 * 1024, 0x41); // 5 MiB (min part size) of 'A'
  const part2 = Buffer.alloc(3 * 1024, 0x42); // small last part of 'B'

  const created = await apiJson('POST', '/api/transfer/multipart/create', { bucket: TEST_BUCKET, key });
  assert.equal(created.status, 201);
  const uploadId = created.data.uploadId;
  assert.ok(uploadId, 'create returns an uploadId');

  const putPart = async (n, buf) => {
    const res = await fetch(`${base}/api/transfer/multipart/part?bucket=${enc(TEST_BUCKET)}&key=${enc(key)}&uploadId=${enc(uploadId)}&partNumber=${n}`, {
      method: 'PUT',
      headers: { 'X-Profile-Id': profileId },
      body: buf,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  // Upload part 1, then verify listParts reflects it (the resume source of truth).
  const p1 = await putPart(1, part1);
  assert.equal(p1.status, 200);
  assert.ok(p1.data.etag, 'part 1 returns an ETag');
  const afterOne = await apiJson('GET', `/api/transfer/multipart/parts?bucket=${enc(TEST_BUCKET)}&key=${enc(key)}&uploadId=${enc(uploadId)}`);
  assert.deepEqual(afterOne.data.parts.map((p) => p.partNumber), [1]);

  // Upload the last part, then complete with both ETags.
  const p2 = await putPart(2, part2);
  assert.equal(p2.status, 200);
  const completed = await apiJson('POST', '/api/transfer/multipart/complete', {
    bucket: TEST_BUCKET,
    key,
    uploadId,
    parts: [
      { partNumber: 1, etag: p1.data.etag },
      { partNumber: 2, etag: p2.data.etag },
    ],
  });
  assert.equal(completed.status, 200);

  // The assembled object must equal part1 + part2, byte for byte.
  const dl = await downloadBytes(key);
  assert.equal(dl.status, 200);
  assert.equal(sha256(dl.buf), sha256(Buffer.concat([part1, part2])));
});

test('multipart abort removes the in-progress upload (no orphaned parts left to bill)', async () => {
  const enc = encodeURIComponent;
  const key = `${RUN_PREFIX}mp/abort.bin`;
  const created = await apiJson('POST', '/api/transfer/multipart/create', { bucket: TEST_BUCKET, key });
  const uploadId = created.data.uploadId;
  await fetch(`${base}/api/transfer/multipart/part?bucket=${enc(TEST_BUCKET)}&key=${enc(key)}&uploadId=${enc(uploadId)}&partNumber=1`, {
    method: 'PUT',
    headers: { 'X-Profile-Id': profileId },
    body: Buffer.alloc(5 * 1024 * 1024, 0x43),
  });
  const aborted = await apiJson('POST', '/api/transfer/multipart/abort', { bucket: TEST_BUCKET, key, uploadId });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.data.aborted, true);
  // Completing an aborted upload must fail (the upload no longer exists).
  const after = await apiJson('POST', '/api/transfer/multipart/complete', { bucket: TEST_BUCKET, key, uploadId, parts: [{ partNumber: 1, etag: '"x"' }] });
  assert.ok(after.status >= 400, 'completing an aborted upload is rejected');
});

test('download resume: Range + If-Match returns 206 from the offset, and 412 when the object changed', async () => {
  const enc = encodeURIComponent;
  const key = `${RUN_PREFIX}resume/data.bin`;
  const body = Buffer.alloc(10000);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 13) % 256;
  await uploadViaApi(`${RUN_PREFIX}resume/`, 'data.bin', body);

  const url = `${base}/api/transfer/download?profile=${enc(profileId)}&bucket=${enc(TEST_BUCKET)}&key=${enc(key)}`;
  // Byte-0 request exposes the ETag (the resume guard) and full length.
  const first = await fetch(url);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ETag header is exposed for the resume guard');
  assert.equal(Number(first.headers.get('content-length')), 10000);

  // Resume from byte 6000 with the matching If-Match -> 206 + exact tail bytes.
  const resumed = await fetch(url, { headers: { Range: 'bytes=6000-', 'If-Match': etag } });
  assert.equal(resumed.status, 206);
  assert.match(resumed.headers.get('content-range') || '', /^bytes 6000-9999\/10000/);
  const tail = Buffer.from(await resumed.arrayBuffer());
  assert.equal(sha256(tail), sha256(body.subarray(6000)));

  // A stale guard (object "changed") must fail with 412 so the client restarts.
  const stale = await fetch(url, { headers: { Range: 'bytes=6000-', 'If-Match': '"deadbeefdeadbeefdeadbeefdeadbeef"' } });
  assert.equal(stale.status, 412);
});

test('multipart/list surfaces in-progress uploads for the orphan sweep, abort removes them', async () => {
  const enc = encodeURIComponent;
  const key = `${RUN_PREFIX}mp/orphan.bin`;
  const created = await apiJson('POST', '/api/transfer/multipart/create', { bucket: TEST_BUCKET, key });
  const uploadId = created.data.uploadId;
  // The sweep lists in-progress uploads under the prefix; ours must appear.
  const listed = await apiJson('GET', `/api/transfer/multipart/list?bucket=${enc(TEST_BUCKET)}&prefix=${enc(`${RUN_PREFIX}mp/`)}`);
  assert.equal(listed.status, 200);
  const mine = listed.data.uploads.find((u) => u.key === key && u.uploadId === uploadId);
  assert.ok(mine, 'the in-progress upload is listed for cleanup');
  assert.ok(mine.initiated, 'list includes an initiated timestamp (used to age out stale uploads)');
  // Abort it (what cleanupIncompleteUploads does) — then it is gone from the list.
  await apiJson('POST', '/api/transfer/multipart/abort', { bucket: TEST_BUCKET, key, uploadId });
  const after = await apiJson('GET', `/api/transfer/multipart/list?bucket=${enc(TEST_BUCKET)}&prefix=${enc(`${RUN_PREFIX}mp/`)}`);
  assert.ok(!after.data.uploads.some((u) => u.uploadId === uploadId), 'aborted upload no longer listed');
});

test('inline view endpoint returns the bytes with an inline disposition', async () => {
  const key = `${RUN_PREFIX}view/note.txt`;
  const body = Buffer.from('inline preview content\n');
  await uploadViaApi(`${RUN_PREFIX}view/`, 'note.txt', body);
  const url = `${base}/api/transfer/view?profile=${encodeURIComponent(profileId)}&bucket=${encodeURIComponent(TEST_BUCKET)}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /^inline/);
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.equal(sha256(Buffer.from(await res.arrayBuffer())), sha256(body));
});

test('view serves HTTP Range requests (206 partial content, for media seeking)', async () => {
  const key = `${RUN_PREFIX}range/data.bin`;
  const body = Buffer.allocUnsafe(2000);
  for (let i = 0; i < 2000; i += 1) body[i] = i % 256;
  await uploadViaApi(`${RUN_PREFIX}range/`, 'data.bin', body);
  const url = `${base}/api/transfer/view?profile=${encodeURIComponent(profileId)}&bucket=${encodeURIComponent(TEST_BUCKET)}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.match(res.headers.get('content-range') || '', /^bytes 0-99\/2000/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(sha256(buf), sha256(body.subarray(0, 100)));
});

test('rename refuses to overwrite an existing destination unless overwrite=true', async () => {
  const src = `${RUN_PREFIX}clobber/src.txt`;
  const dst = `${RUN_PREFIX}clobber/dst.txt`;
  const srcBody = Buffer.from('SOURCE\n');
  const dstBody = Buffer.from('IMPORTANT EXISTING DATA\n');
  await uploadViaApi(`${RUN_PREFIX}clobber/`, 'src.txt', srcBody);
  await uploadViaApi(`${RUN_PREFIX}clobber/`, 'dst.txt', dstBody);

  // Without overwrite -> 409, and BOTH files must still exist (no data loss).
  const blocked = await apiJson('POST', '/api/rename', { bucket: TEST_BUCKET, sourceKey: src, destKey: dst });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, 'DEST_EXISTS');
  const stillThere = await downloadBytes(dst);
  assert.equal(sha256(stillThere.buf), sha256(dstBody), 'destination must be untouched after a blocked rename');
  assert.equal((await apiJson('GET', `/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent(src)}`)).status, 200);

  // With overwrite -> succeeds, dst now holds source bytes, src is gone.
  const ok = await apiJson('POST', '/api/rename', { bucket: TEST_BUCKET, sourceKey: src, destKey: dst, overwrite: true });
  assert.equal(ok.status, 200);
  assert.equal(sha256((await downloadBytes(dst)).buf), sha256(srcBody));
  assert.equal((await apiJson('GET', `/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent(src)}`)).status, 404);
});

test('an invalid filename in a multi-file upload fails cleanly without crashing the server', async () => {
  // One valid file + one with an over-long key (>1024) in the same request.
  const fd = new FormData();
  fd.append('bucket', TEST_BUCKET);
  fd.append('prefix', `${RUN_PREFIX}crash/`);
  fd.append('file', new Blob([Buffer.from('ok')]), 'good.txt');
  fd.append('file', new Blob([Buffer.from('bad')]), `${'x'.repeat(1200)}.txt`);
  const res = await fetch(`${base}/api/transfer/upload`, { method: 'POST', headers: { 'X-Profile-Id': profileId }, body: fd });
  assert.ok(res.status >= 400, `expected a 4xx, got ${res.status}`);

  // The server must still be alive and serving requests afterwards.
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  // And it must not have left an orphaned object behind.
  const list = await apiJson('GET', `/api/objects?bucket=${TEST_BUCKET}&prefix=${encodeURIComponent(`${RUN_PREFIX}crash/`)}`);
  assert.equal(list.data.files.length, 0, 'no orphaned object should remain from the failed upload');
});

test('path-traversal keys are rejected with 400', async () => {
  const res = await fetch(`${base}/api/object/meta?bucket=${TEST_BUCKET}&key=${encodeURIComponent('../etc/passwd')}`, {
    headers: { 'X-Profile-Id': profileId },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_KEY');
});
