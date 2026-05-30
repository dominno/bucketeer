// Inline preview: an uploaded image renders in the lightbox and a text file's
// contents show in the preview pane — neither is saved to disk.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

// A valid 1x1 transparent PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('preview images and text inline without downloading', async ({ page }) => {
  const folder = `qa-ui-preview-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  const imgPath = path.join(os.tmpdir(), `${Date.now()}-pic.png`);
  fs.writeFileSync(imgPath, PNG_1x1);
  const txtPath = path.join(os.tmpdir(), `${Date.now()}-note.txt`);
  const txtContent = 'PREVIEW-ME-INLINE-12345';
  fs.writeFileSync(txtPath, txtContent);

  await page.getByTestId('file-input').setInputFiles([imgPath, txtPath]);
  const imgKey = `${folder}/${path.basename(imgPath)}`;
  const txtKey = `${folder}/${path.basename(txtPath)}`;
  await expect(page.getByTestId(`row-file-${imgKey}`)).toBeVisible();
  await expect(page.getByTestId(`row-file-${txtKey}`)).toBeVisible();

  // Image preview — opens by clicking the file name, and the image truly loads.
  await page.getByTestId(`row-name-${imgKey}`).click();
  await expect(page.getByTestId('preview-modal')).toBeVisible();
  const img = page.getByTestId('preview-image');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await page.getByTestId('preview-close').click();
  await expect(page.getByTestId('preview-modal')).toHaveCount(0);

  // Text preview — contents render in the pane; Escape closes.
  await page.getByTestId(`row-name-${txtKey}`).click();
  await expect(page.getByTestId('preview-modal')).toBeVisible();
  await expect(page.getByTestId('preview-text')).toContainText(txtContent);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preview-modal')).toHaveCount(0);

  fs.unlinkSync(imgPath);
  fs.unlinkSync(txtPath);
});
