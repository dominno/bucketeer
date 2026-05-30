// Resumable multipart upload, frontend path: a >16 MiB file is uploaded via the
// client-orchestrated multipart endpoints (create/part/complete), NOT the single
// /upload, and the assembled object is byte-exact.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

test('large file uploads via resumable multipart and lands byte-exact', async ({ page }) => {
  const folder = `qa-ui-mp-${Date.now()}`;
  // 17 MiB of varied bytes -> 3 parts at the 8 MiB part size (8+8+1).
  const size = 17 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 7) % 251;
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const tmp = path.join(os.tmpdir(), `${Date.now()}-big.bin`);
  fs.writeFileSync(tmp, buf);

  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  const hits = new Set();
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/transfer/multipart/create')) hits.add('create');
    else if (u.includes('/api/transfer/multipart/part')) hits.add('part');
    else if (u.includes('/api/transfer/multipart/complete')) hits.add('complete');
    else if (u.endsWith('/api/transfer/upload')) hits.add('single');
  });

  await page.getByTestId('file-input').setInputFiles(tmp);
  const key = `${folder}/${path.basename(tmp)}`;
  await expect(page.getByTestId(`row-file-${key}`)).toBeVisible({ timeout: 90000 });

  // The multipart path was used end-to-end; the single-shot path was NOT.
  expect(hits.has('create')).toBe(true);
  expect(hits.has('part')).toBe(true);
  expect(hits.has('complete')).toBe(true);
  expect(hits.has('single')).toBe(false);

  // Byte-exact: fetch the object back (in-page, via the app's own download URL) and
  // hash it — proves the frontend sliced + assembled the parts correctly.
  const gotSha = await page.evaluate(async (k) => {
    const { api } = await import('/js/api.js');
    const { store } = await import('/js/store.js');
    const res = await fetch(api.downloadUrl(store.getState().location.bucket, k));
    const ab = await res.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', ab);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, key);
  expect(gotSha).toBe(sha);

  fs.unlinkSync(tmp);
});
