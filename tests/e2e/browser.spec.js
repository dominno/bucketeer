// Happy-path UI flow against the real bucket: add a profile by pasting the
// .txt, browse, create a folder, upload, download (byte-verified), rename,
// delete — all scoped to a unique qa-ui-<id> folder cleaned up by globalTeardown.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder, sha } from './util.js';

test('add profile → browse → upload → download → rename → delete', async ({ page }) => {
  const folder = `qa-ui-${Date.now()}`;
  const fileName = 'e2e-sample.txt';
  const content = `hello from the e2e suite ${Date.now()}\n`.repeat(20);

  await page.goto('/');
  await addProfileViaPaste(page);

  // Active profile pill reflects the selection.
  await expect(page.getByTestId('profile-pill')).toBeVisible();

  await openBucket(page);
  await createFolder(page, folder);

  // Enter the folder; it should be empty.
  await page.getByTestId(`row-name-${folder}/`).click();
  await expect(page.getByTestId('table-empty')).toBeVisible();
  await expect(page.getByTestId('crumb-0')).toHaveText(folder);

  // Upload a file.
  const tmp = path.join(os.tmpdir(), `${Date.now()}-${fileName}`);
  fs.writeFileSync(tmp, content);
  await page.getByTestId('file-input').setInputFiles(tmp);

  const fileKey = `${folder}/${path.basename(tmp)}`;
  const row = page.getByTestId(`row-file-${fileKey}`);
  await expect(row).toBeVisible();

  // Download and verify the bytes match what we uploaded.
  await row.hover();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`download-${fileKey}`).click(),
  ]);
  const dlPath = await download.path();
  expect(sha(fs.readFileSync(dlPath))).toBe(sha(Buffer.from(content)));

  // Rename the file.
  const newName = 'e2e-renamed.txt';
  await row.hover();
  await page.getByTestId(`rename-${fileKey}`).click();
  await page.getByTestId('prompt-input').fill(newName);
  await page.getByTestId('prompt-ok').click();
  const newKey = `${folder}/${newName}`;
  await expect(page.getByTestId(`row-file-${fileKey}`)).toHaveCount(0);
  await expect(page.getByTestId(`row-file-${newKey}`)).toBeVisible();

  // Delete the file.
  await page.getByTestId(`row-file-${newKey}`).hover();
  await page.getByTestId(`delete-${newKey}`).click();
  await expect(page.getByTestId('confirm-modal')).toBeVisible();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId(`row-file-${newKey}`)).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toBeVisible();

  // Back to root, delete the folder.
  await page.getByTestId('crumb-root').click();
  const folderRow = page.getByTestId(`row-folder-${folder}/`);
  await expect(folderRow).toBeVisible();
  await folderRow.hover();
  await page.getByTestId(`delete-${folder}/`).click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId(`row-folder-${folder}/`)).toHaveCount(0);

  fs.unlinkSync(tmp);
});

test('bulk select and delete multiple files', async ({ page }) => {
  const folder = `qa-ui-bulk-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();
  await expect(page.getByTestId('table-empty')).toBeVisible();

  // Upload three files.
  const names = ['a.txt', 'b.txt', 'c.txt'];
  const tmpFiles = names.map((n) => {
    const p = path.join(os.tmpdir(), `${Date.now()}-${n}`);
    fs.writeFileSync(p, `content ${n}\n`);
    return p;
  });
  await page.getByTestId('file-input').setInputFiles(tmpFiles);
  for (const p of tmpFiles) {
    await expect(page.getByTestId(`row-file-${folder}/${path.basename(p)}`)).toBeVisible();
  }

  // Select all and bulk-delete.
  await page.getByTestId('select-all').click();
  await expect(page.getByTestId('selection-count')).toContainText('3 selected');
  await page.getByTestId('bulk-delete-btn').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('table-empty')).toBeVisible();

  tmpFiles.forEach((p) => fs.unlinkSync(p));
});
