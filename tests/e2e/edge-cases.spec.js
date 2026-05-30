// Edge cases through the UI: bad credentials surface cleanly, empty-folder
// state, nested-folder breadcrumb navigation, and special-character filenames.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder, sha, BUCKET } from './util.js';

test('wrong credentials surface an error, not a crash or blank screen', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('manage-profiles-btn').click();
  await expect(page.getByTestId('profile-modal')).toBeVisible();
  await page.getByTestId('profile-form-name').fill('bad-creds');
  await page.getByTestId('profile-form-endpoint').fill('m2o3.fra.idrivee2-58.com');
  await page.getByTestId('profile-form-region').fill('eu-central-2');
  await page.getByTestId('profile-form-accessKeyId').fill('NOPEKEYDOESNOTEXIST');
  await page.getByTestId('profile-form-secret').fill('definitely-wrong-secret');
  await page.getByTestId('profile-save-btn').click();

  // A clear error must appear (sidebar bucket error or an error toast).
  await expect(
    page.getByTestId('buckets-error').or(page.getByTestId('toast-error')).first(),
  ).toBeVisible();
  // The app shell is still intact.
  await expect(page.getByTestId('sidebar')).toBeVisible();
});

test('empty folder shows an explicit empty state', async ({ page }) => {
  const folder = `qa-ui-empty-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();
  await expect(page.getByTestId('table-empty')).toBeVisible();
});

test('nested folders navigate via breadcrumbs', async ({ page }) => {
  const a = `qa-ui-nest-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, a);
  await page.getByTestId(`row-name-${a}/`).click();
  await createFolder(page, 'inner', `${a}/`);
  await page.getByTestId(`row-name-${a}/inner/`).click();

  // Breadcrumb shows bucket > a > inner; click the bucket root to go all the way up.
  await expect(page.getByTestId('crumb-root')).toHaveText(BUCKET);
  await expect(page.getByTestId('crumb-0')).toHaveText(a);
  await page.getByTestId('crumb-0').click();
  await expect(page.getByTestId(`row-folder-${a}/inner/`)).toBeVisible();
  await page.getByTestId('crumb-root').click();
  await expect(page.getByTestId(`row-folder-${a}/`)).toBeVisible();
});

test('special-character filename uploads, lists and downloads intact', async ({ page }) => {
  const folder = `qa-ui-special-${Date.now()}`;
  const fileName = 'wéird name (v2) #1 &ok.txt';
  const content = 'special-characters survive the round trip\n';

  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  const tmp = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(tmp, content);
  await page.getByTestId('file-input').setInputFiles(tmp);

  const fileKey = `${folder}/${fileName}`;
  const row = page.getByTestId(`row-file-${fileKey}`);
  await expect(row).toBeVisible();

  await row.hover();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`download-${fileKey}`).click(),
  ]);
  expect(sha(fs.readFileSync(await download.path()))).toBe(sha(Buffer.from(content)));

  fs.unlinkSync(tmp);
});
