// Uploading a folder tree (nested folders + files) preserves the structure.
// We drive the same enqueue pipeline the drag-drop walker and the "Upload
// folder" picker feed (each item carries its subpath), then verify the nested
// keys exist by navigating the tree. Objects live under qa-ui- (teardown sweeps).
import { test, expect } from '@playwright/test';
import { addProfileViaPaste, openBucket } from './util.js';

test('uploading a folder tree preserves its structure', async ({ page }) => {
  const root = `qa-ui-tree-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);

  await page.evaluate((r) => {
    const mk = (name, content) => new File([content], name, { type: 'text/plain' });
    window.__app.actions.enqueueUploads([
      { file: mk('top.txt', 'top'), relPath: `${r}/` },
      { file: mk('a.txt', 'a'), relPath: `${r}/docs/` },
      { file: mk('b.txt', 'b'), relPath: `${r}/docs/sub/` },
    ]);
  }, root);

  // Root shows the uploaded folder.
  await expect(page.getByTestId(`row-folder-${root}/`)).toBeVisible();

  // Drill in: top.txt + docs/ at the root of the tree.
  await page.getByTestId(`row-name-${root}/`).click();
  await expect(page.getByTestId(`row-file-${root}/top.txt`)).toBeVisible();
  await expect(page.getByTestId(`row-folder-${root}/docs/`)).toBeVisible();

  // docs/ contains a.txt + sub/.
  await page.getByTestId(`row-name-${root}/docs/`).click();
  await expect(page.getByTestId(`row-file-${root}/docs/a.txt`)).toBeVisible();
  await expect(page.getByTestId(`row-folder-${root}/docs/sub/`)).toBeVisible();

  // sub/ contains the deepest file.
  await page.getByTestId(`row-name-${root}/docs/sub/`).click();
  await expect(page.getByTestId(`row-file-${root}/docs/sub/b.txt`)).toBeVisible();
});
