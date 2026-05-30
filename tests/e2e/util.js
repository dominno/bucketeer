// Shared helpers for the Playwright UI specs.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { findCredsFile } from '../helpers/credentials.js';

export const credsText = fs.readFileSync(findCredsFile(), 'utf8');
export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const BUCKET = process.env.TEST_BUCKET || 'browser-app-test';

// Add a working profile by pasting the real Access-Keys .txt. After saving, the
// new profile becomes active and its buckets load.
export async function addProfileViaPaste(page) {
  await page.getByTestId('manage-profiles-btn').click();
  await expect(page.getByTestId('profile-modal')).toBeVisible();
  await page.getByTestId('profile-paste').fill(credsText);
  await page.getByTestId('profile-parse-btn').click();
  await expect(page.getByTestId('profile-form-accessKeyId')).not.toHaveValue('');
  await page.getByTestId('profile-save-btn').click();
  await expect(page.getByTestId('profile-modal')).toBeHidden();
  await expect(page.getByTestId(`bucket-item-${BUCKET}`)).toBeVisible();
}

export async function openBucket(page, bucket = BUCKET) {
  await page.getByTestId(`bucket-item-${bucket}`).click();
  await expect(page.getByTestId('toolbar')).toBeVisible();
}

// `parentPrefix` is the current prefix you're browsing (''  at bucket root),
// so the new folder's row testid is row-folder-<parentPrefix><name>/.
export async function createFolder(page, name, parentPrefix = '') {
  await page.getByTestId('new-folder-btn').click();
  await expect(page.getByTestId('prompt-modal')).toBeVisible();
  await page.getByTestId('prompt-input').fill(name);
  await page.getByTestId('prompt-ok').click();
  await expect(page.getByTestId(`row-folder-${parentPrefix}${name}/`)).toBeVisible();
}
