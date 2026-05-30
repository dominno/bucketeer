// Recursive search: a file in a subfolder isn't found by the current-folder
// filter, but "Search all subfolders" finds it (glob *.fbx).
import { test, expect } from '@playwright/test';
import { addProfileViaPaste, openBucket } from './util.js';

test('search all subfolders finds a file nested below the current folder', async ({ page }) => {
  const root = `qa-ui-search-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);

  // Build a tree: <root>/readme.txt and <root>/sub/deep.fbx
  await page.evaluate((r) => {
    const mk = (n, c) => new File([c], n, { type: 'text/plain' });
    window.__app.actions.enqueueUploads([
      { file: mk('readme.txt', 'x'), relPath: `${r}/` },
      { file: mk('deep.fbx', 'y'), relPath: `${r}/sub/` },
    ]);
  }, root);
  await expect(page.getByTestId(`row-folder-${root}/`)).toBeVisible();
  await page.getByTestId(`row-name-${root}/`).click();

  // Filtering THIS folder for *.fbx finds nothing (the .fbx is in sub/).
  await page.getByTestId('search-input').fill('*.fbx');
  await expect(page.getByTestId('table-no-matches')).toBeVisible();

  // Search all subfolders → the nested file appears with its path.
  await page.getByTestId('search-all-btn').click();
  await expect(page.getByTestId('recursive-bar')).toBeVisible();
  await expect(page.getByTestId(`result-${root}/sub/deep.fbx`)).toBeVisible();

  // Back to the folder view.
  await page.getByTestId('recursive-clear').click();
  await expect(page.getByTestId('recursive-bar')).toHaveCount(0);
});
