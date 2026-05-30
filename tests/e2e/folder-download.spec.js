// Downloading a whole folder produces a .zip via the folder row action.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

test('download a folder as a zip', async ({ page }) => {
  const folder = `qa-ui-zip-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);

  // Put a file inside the folder.
  await page.getByTestId(`row-name-${folder}/`).click();
  const tmp = path.join(os.tmpdir(), `${Date.now()}-z.txt`);
  fs.writeFileSync(tmp, 'zip me up\n');
  await page.getByTestId('file-input').setInputFiles(tmp);
  await expect(page.getByTestId(`row-file-${folder}/${path.basename(tmp)}`)).toBeVisible();

  // Back to root; the folder row's download action yields a .zip.
  await page.getByTestId('crumb-root').click();
  const folderRow = page.getByTestId(`row-folder-${folder}/`);
  await expect(folderRow).toBeVisible();
  await folderRow.hover();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`download-${folder}/`).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  fs.unlinkSync(tmp);
});
