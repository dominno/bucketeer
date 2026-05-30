// A video file opens in the inline <video> preview (streamed via /view, no
// download). Headless Chromium lacks H.264, so the clip may not decode — either
// the <video> or its media-error fallback proves the video branch ran (vs. the
// generic "no preview" path).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

test('a .mp4 routes to the video preview', async ({ page }) => {
  const folder = `qa-ui-video-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  const tmp = path.join(os.tmpdir(), `${Date.now()}-clip.mp4`);
  fs.writeFileSync(tmp, Buffer.from('placeholder bytes — routed as video by extension'));
  await page.getByTestId('file-input').setInputFiles(tmp);
  const key = `${folder}/${path.basename(tmp)}`;
  await expect(page.getByTestId(`row-file-${key}`)).toBeVisible();

  // Opens the video preview (player) or its media-error fallback — never the
  // generic "no inline preview" state.
  await page.getByTestId(`row-name-${key}`).click();
  await expect(page.getByTestId('preview-modal')).toBeVisible();
  await expect(page.getByTestId('preview-video').or(page.getByTestId('preview-error'))).toBeVisible();
  await expect(page.getByTestId('preview-none')).toHaveCount(0);

  await page.keyboard.press('Escape');
  fs.unlinkSync(tmp);
});
