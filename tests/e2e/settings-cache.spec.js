// Settings dialog shows the in-memory preview cache size and can clear it.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

test('settings shows the preview cache size and clears it', async ({ page }) => {
  const folder = `qa-ui-cache-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  // Upload a text file and preview it — that caches its bytes.
  const tmp = path.join(os.tmpdir(), `${Date.now()}-c.txt`);
  fs.writeFileSync(tmp, 'cache me '.repeat(40));
  await page.getByTestId('file-input').setInputFiles(tmp);
  const key = `${folder}/${path.basename(tmp)}`;
  await expect(page.getByTestId(`row-file-${key}`)).toBeVisible();
  await page.getByTestId(`row-name-${key}`).click();
  await expect(page.getByTestId('preview-text')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preview-modal')).toHaveCount(0);

  // Open Settings → cache is non-empty.
  await page.getByTestId('manage-profiles-btn').click();
  await expect(page.getByTestId('profile-modal')).toBeVisible();
  await expect(page.getByTestId('settings-cache-size')).not.toHaveText('Empty');

  // Clear → back to empty.
  await page.getByTestId('settings-clear-cache').click();
  await expect(page.getByTestId('settings-cache-size')).toHaveText('Empty');

  fs.unlinkSync(tmp);
});
