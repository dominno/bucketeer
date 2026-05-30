// New transfer-manager features: upload conflict detection/resolution, and the
// download dock rendering (downloads inject via the store since the streamed
// path needs a native picker unavailable under automation).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

test('re-uploading an existing name is detected as a conflict and can be replaced', async ({ page }) => {
  const folder = `qa-ui-conflict-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  // A temp file with a fixed name we can upload twice.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clud-conf-'));
  const file = path.join(dir, 'dup.txt');
  fs.writeFileSync(file, 'first version\n');

  // First upload — no conflict, lands in the listing.
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId(`row-file-${folder}/dup.txt`)).toBeVisible();

  // Second upload of the same name — conflict bar appears.
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('upload-conflict-bar')).toBeVisible();
  await expect(page.getByTestId('upload-conflict-bar')).toContainText('already exist');

  // Replace all -> conflict resolves and the upload proceeds.
  await page.getByTestId('upload-replace-all').click();
  await expect(page.getByTestId('upload-conflict-bar')).toHaveCount(0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('download dock renders active/zip/finished tasks with controls', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__app);

  await page.evaluate(() => {
    window.__app.store.setState({
      downloads: [
        { id: 'dX', kind: 'file', name: 'big.bin', received: 500000, total: 1000000, rate: 250000, status: 'downloading', error: null, runtime: 'browser' },
        { id: 'dY', kind: 'batch-zip', name: 'archive.zip', received: 120000, total: null, rate: 80000, status: 'downloading', error: null, runtime: 'browser' },
        { id: 'dZ', kind: 'file', name: 'done.txt', received: 10, total: 10, status: 'done', error: null, runtime: 'browser' },
      ],
    });
  });

  await expect(page.getByTestId('download-manager')).toBeVisible();
  await expect(page.getByTestId('download-row-dX')).toBeVisible();
  await expect(page.getByTestId('download-status-dX')).toContainText('Downloading');
  // A zip stream has no known length -> indeterminate progress bar.
  await expect(page.getByTestId('download-progress-dY')).toHaveClass(/indeterminate/);
  // Header transfer pill reflects active transfers.
  await expect(page.getByTestId('transfer-pill-badge')).toBeVisible();

  // Cancel an active download.
  await page.getByTestId('download-cancel-dX').click();
  await expect(page.getByTestId('download-status-dX')).toContainText('Cancelled');

  // Clear completed removes only the finished one.
  await page.getByTestId('download-clear-btn').click();
  await expect(page.getByTestId('download-row-dZ')).toHaveCount(0);
  await expect(page.getByTestId('download-row-dX')).toBeVisible();
});
