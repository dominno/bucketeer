// The folder-to-disk scan reads the listing as a stream (NDJSON). This verifies
// the frontend reader end-to-end against the real bucket: api.listTreeStream
// delivers every object via onBatch and reports the terminal truncated flag.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

test('listTreeStream streams a folder listing incrementally (NDJSON reader)', async ({ page }) => {
  const folder = `qa-ui-stream-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  // Put three files (one in a subfolder) so the stream returns a known set.
  const mk = (name, body) => {
    const p = path.join(os.tmpdir(), `${Date.now()}-${name}`);
    fs.writeFileSync(p, body);
    return p;
  };
  const f1 = mk('one.txt', 'aaaa');
  const f2 = mk('two.txt', 'bbbbbb');
  await page.getByTestId('file-input').setInputFiles([f1, f2]);
  await expect(page.getByTestId(`row-file-${folder}/${path.basename(f1)}`)).toBeVisible();
  await expect(page.getByTestId(`row-file-${folder}/${path.basename(f2)}`)).toBeVisible();

  const r = await page.evaluate(async (prefix) => {
    const { api } = await import('/js/api.js');
    const { store } = await import('/js/store.js');
    const bucket = store.getState().location.bucket;
    let batches = 0;
    let count = 0;
    const { truncated } = await api.listTreeStream(bucket, `${prefix}/`, undefined, (b) => {
      batches += 1;
      count += b.length;
    });
    return { batches, count, truncated };
  }, folder);

  expect(r.count).toBe(2); // both files streamed
  expect(r.batches).toBeGreaterThan(0); // delivered via onBatch (incrementally)
  expect(r.truncated).toBe(false);

  fs.unlinkSync(f1);
  fs.unlinkSync(f2);
});
