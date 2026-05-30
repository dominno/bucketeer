// Pure-logic unit tests — no live bucket / credentials required. Run with
// `npm run test:unit`. (Bucket-backed behavior lives in integration.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// One throwaway PROFILES_PATH for all store-backed tests. It MUST be set before
// any backend module is imported, because config.js reads the env once at load
// (and is cached thereafter). No electron here -> the AES key-file fallback is
// exercised deterministically; no real bucket needed.
const STORE_DIR = path.join(os.tmpdir(), `bkt-unit-${randomUUID()}`);
fs.mkdirSync(STORE_DIR, { recursive: true });
process.env.PROFILES_PATH = path.join(STORE_DIR, 'profiles.json');

test('secretBox: AES fallback seals/opens round-trip, never emits plaintext, passes through legacy', async () => {
  const { seal, open, isSealed } = await import('../backend/secretBox.js');
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const sealed = seal(secret);
  assert.ok(isSealed(sealed), 'output must be tagged/sealed');
  assert.ok(!sealed.includes(secret), 'sealed value must not contain the plaintext');
  assert.equal(open(sealed), secret, 'round-trips back to the original');
  // Two seals of the same value differ (random IV) but both open correctly.
  const sealed2 = seal(secret);
  assert.notEqual(sealed, sealed2);
  assert.equal(open(sealed2), secret);
  // A legacy plaintext value (untagged) is returned as-is so it can migrate.
  assert.equal(open('legacy-plaintext-secret'), 'legacy-plaintext-secret');
  assert.equal(isSealed('legacy-plaintext-secret'), false);
});

test('profiles store: migrates legacy plaintext to encrypted-at-rest, keeps secret usable, no on-disk leak', async () => {
  const SECRET = 'SUPER_SECRET_VALUE_1234567890';
  fs.writeFileSync(process.env.PROFILES_PATH, JSON.stringify([{ id: 'p1', name: 'n', endpoint: 'h', region: 'r', accessKeyId: 'AK', secretAccessKey: SECRET }]));
  const profiles = await import('../backend/profiles.js');
  profiles._resetCache();

  const redacted = profiles.listProfiles()[0]; // triggers load + migration
  assert.equal(redacted.secretPreview.endsWith(SECRET.slice(-4)), true);
  assert.ok(!('secretAccessKey' in redacted), 'redacted view must not include the secret');
  assert.equal(redacted.locked, false);

  const disk = fs.readFileSync(process.env.PROFILES_PATH, 'utf8');
  assert.ok(!disk.includes(SECRET), 'on-disk file must NOT contain the plaintext secret');
  assert.ok(disk.includes('"version": 1'), 'on-disk file is the encrypted wrapper format');
  assert.ok(disk.includes('bktenc:'), 'secret is stored sealed');

  assert.equal(profiles.getProfile('p1').secretAccessKey, SECRET, 'in-memory secret stays usable for the S3 client');
  profiles._resetCache(); // simulate a fresh process reading the now-encrypted file
  assert.equal(profiles.getProfile('p1').secretAccessKey, SECRET, 'decrypts on reload');
  assert.equal(profiles.securitySummary().encryption, 'localkey');
});

test('audit log: append-only, summarizes bulk keys, never records the secret', async () => {
  const audit = await import('../backend/audit.js');
  audit.clear();
  audit.record({ action: 'delete', profileId: 'p1', bucket: 'b', keys: ['a/1.txt', 'a/2.txt', 'a/3.txt'] });
  audit.record({ action: 'share.presign', profileId: 'p1', bucket: 'b', key: 'a/1.txt', detail: 'expires=3600s' });
  const { entries, total } = audit.readRecent(10);
  assert.equal(total, 2);
  assert.equal(entries[0].action, 'share.presign'); // newest first
  const del = entries.find((e) => e.action === 'delete');
  assert.equal(del.count, 3); // bulk summarized to count
  assert.equal(del.key, 'a/1.txt'); // first key only
  assert.ok(!audit.readRaw().includes('SECRET'), 'audit text never contains a secret');
});

test('secretBox: a truncated/corrupt key file is quarantined, never overwritten in place', async () => {
  const { seal } = await import('../backend/secretBox.js');
  const keyFile = path.join(STORE_DIR, '.secret-key');
  seal('x'); // ensures a valid 32-byte key exists
  fs.writeFileSync(keyFile, Buffer.alloc(10)); // simulate truncation/corruption
  seal('y'); // must quarantine the bad key + mint a fresh one, not clobber in place
  assert.equal(fs.readFileSync(keyFile).length, 32, 'a fresh 32-byte key is minted');
  const quarantined = fs.readdirSync(STORE_DIR).filter((f) => f.startsWith('.secret-key.corrupt-'));
  assert.ok(quarantined.length >= 1, 'the bad key is preserved aside for recovery, not destroyed in place');
});



test('searchObjects paginates: page-boundary stop + resume token, no missed/duplicate matches', async () => {
  const { searchObjects } = await import('../backend/operations.js');
  // Fake S3 client whose ListObjectsV2 honours ContinuationToken.
  const PAGES = {
    start: { Contents: [{ Key: 'a/x.mp4' }, { Key: 'a/y.mp4' }, { Key: 'a/z.mp4' }, { Key: 'a/note.txt' }], IsTruncated: true, NextContinuationToken: 'T1' },
    T1: { Contents: [{ Key: 'b/w.mp4' }, { Key: 'b/readme.md' }], IsTruncated: false },
  };
  const client = { send: async (cmd) => PAGES[cmd.input.ContinuationToken || 'start'] };

  // A small `max` forces a stop after page 1 — but at the PAGE boundary, so the
  // whole page is returned (3 matches, not cut to 2) plus a token to resume.
  const r1 = await searchObjects(client, 'bk', '', '*.mp4', { max: 2 });
  assert.deepEqual(r1.results.map((r) => r.name), ['x.mp4', 'y.mp4', 'z.mp4']);
  assert.equal(r1.nextToken, 'T1');

  // Resuming from the token appends page 2's matches and exhausts the listing.
  const r2 = await searchObjects(client, 'bk', '', '*.mp4', { max: 2, continuationToken: r1.nextToken });
  assert.deepEqual(r2.results.map((r) => r.name), ['w.mp4']);
  assert.equal(r2.nextToken, null); // fully scanned -> no more pages

  // No overlap across pages and non-matching extensions (.txt/.md) are filtered.
  assert.ok(!r2.results.some((r) => r1.results.some((p) => p.key === r.key)));
});

test('texture resolver: matches FBX external textures to sibling keys, passes embedded/absolute through', async () => {
  const { buildResourceMap, matchResourceKey } = await import('../frontend/js/textureResolver.js');
  const files = [
    { name: 'Fresh_Coconut_high.fbx', key: 'models/Fresh_Coconut_high.fbx' }, // not a resource
    { name: 'coconut_diffuse.jpg', key: 'models/coconut_diffuse.jpg' },
    { name: 'Coconut_Normal.PNG', key: 'models/Coconut_Normal.PNG' },
    { name: 'notes.txt', key: 'models/notes.txt' }, // not a resource
    { name: 'mesh.bin', key: 'models/mesh.bin' }, // gltf binary buffer counts
  ];
  const map = buildResourceMap(files);
  assert.deepEqual([...map.keys()].sort(), ['coconut_diffuse.jpg', 'coconut_normal.png', 'mesh.bin'].sort());

  assert.equal(matchResourceKey('coconut_diffuse.jpg', map), 'models/coconut_diffuse.jpg');
  assert.equal(matchResourceKey('coconut_normal.png', map), 'models/Coconut_Normal.PNG'); // case-insensitive
  assert.equal(matchResourceKey('..\\textures\\coconut_diffuse.jpg', map), 'models/coconut_diffuse.jpg'); // backslash
  assert.equal(matchResourceKey('C:/art/exports/coconut_diffuse.jpg', map), 'models/coconut_diffuse.jpg'); // absolute fwd-slash
  assert.equal(matchResourceKey('coconut_diffuse.jpg?v=2', map), 'models/coconut_diffuse.jpg'); // query stripped

  for (const u of ['blob:abc123', 'data:image/png;base64,AAAA', 'http://x/y.png', 'https://x/y.png', '//cdn/y.png']) {
    assert.equal(matchResourceKey(u, map), null, `must pass through unchanged: ${u}`);
  }
  assert.equal(matchResourceKey('missing_texture.jpg', map), null); // unmatched -> grey fallback
  assert.equal(matchResourceKey('coconut_diffuse.jpg', new Map()), null); // empty scan
});

test('fixMaterials: dead-map sweep drops never-loaded textures to grey (no more solid-black FBX)', async () => {
  const { fixMaterials } = await import('../frontend/js/materialFix.js');
  const THREE = { DoubleSide: 2 };
  const GREY = 0x9aa7b4;

  // Build a fake mesh material. `imageReady` controls whether the assigned map
  // ever got pixels (a 404'd external texture → image: null).
  const makeMat = ({ imageReady, color = { r: 0, g: 0, b: 0 } }) => {
    let disposed = false;
    return {
      side: null,
      map: { image: imageReady ? { width: 256, height: 256 } : null, dispose() { disposed = true; } },
      color: { ...color, setHex(h) { this.hex = h; } },
      needsUpdate: false,
      get _disposed() { return disposed; },
    };
  };
  const meshOf = (material) => ({ isMesh: true, material });
  const run = (material, dropDeadMaps) => {
    fixMaterials(THREE, { traverse: (cb) => cb(meshOf(material)) }, dropDeadMaps);
    return material;
  };

  // 1) Missing texture (dead map) + black color, sweep ON → map dropped, greyed.
  const dead = run(makeMat({ imageReady: false }), true);
  assert.equal(dead.map, null, 'dead map must be dropped');
  assert.equal(dead.color.hex, GREY, 'black mesh with no usable texture must go grey');
  assert.equal(dead.side, THREE.DoubleSide);

  // 2) Same material, sweep OFF (initial pass) → map kept, NOT greyed: a valid
  //    external texture may still be loading, so we must not prematurely rescue.
  const pending = run(makeMat({ imageReady: false }), false);
  assert.notEqual(pending.map, null, 'map must be preserved while textures may still load');
  assert.equal(pending.color.hex, undefined, 'must not grey a mesh whose map might still load');

  // 3) Live texture, sweep ON → map kept, NOT greyed (the working/textured case).
  const live = run(makeMat({ imageReady: true }), true);
  assert.notEqual(live.map, null, 'a loaded texture must survive the sweep');
  assert.equal(live.color.hex, undefined, 'textured mesh must keep its texture, not grey out');

  // 4) Color-only mesh (no map at all), bright color → left alone.
  const bright = run({ side: null, map: null, color: { r: 0.8, g: 0.2, b: 0.1, setHex(h) { this.hex = h; } }, needsUpdate: false }, false);
  assert.equal(bright.color.hex, undefined, 'a non-black untextured mesh keeps its own color');
});

test('i18n en/pl dictionaries have identical key sets (parity invariant the UI relies on)', async () => {
  const { DICT } = await import('../frontend/js/i18n.js');
  const en = Object.keys(DICT.en);
  const pl = Object.keys(DICT.pl);
  assert.deepEqual(en.filter((k) => !(k in DICT.pl)), [], 'keys missing from pl');
  assert.deepEqual(pl.filter((k) => !(k in DICT.en)), [], 'keys missing from en');
  assert.equal(en.length, pl.length);
});
