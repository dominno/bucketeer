// Polish language support: switching the language translates the UI live and
// the choice persists across reloads.
import { test, expect } from '@playwright/test';

test('switch to Polish translates the UI and persists across reload', async ({ page }) => {
  await page.goto('/');
  const search = page.getByTestId('search-input');

  // Default English (assert on always-present chrome, not profile-dependent state).
  await expect(search).toHaveAttribute('placeholder', /Search this folder/);
  await expect(page.getByTestId('upload-btn')).toContainText('Upload');

  // Switch to Polish — UI updates live.
  await page.getByTestId('language-select').selectOption('pl');
  await expect(search).toHaveAttribute('placeholder', /Szukaj w tym folderze/);
  await expect(page.getByTestId('upload-btn')).toContainText('Wyślij');
  await expect(page.getByTestId('new-folder-btn')).toContainText('Nowy folder');

  // Persists across reload.
  await page.reload();
  await expect(page.getByTestId('language-select')).toHaveValue('pl');
  await expect(page.getByTestId('upload-btn')).toContainText('Wyślij');

  // Switch back to English.
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.getByTestId('upload-btn')).toContainText('Upload');
});
