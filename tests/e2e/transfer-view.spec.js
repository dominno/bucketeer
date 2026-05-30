// Transfer overview: combined overall progress bar + ETA, expand to a
// full-window panel, and cancel-all. Tasks are injected via the store (the
// streamed transfer paths need a native picker unavailable under automation).
import { test, expect } from '@playwright/test';

test('overview shows overall progress, expands full-window, cancels all', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__app);

  await page.evaluate(() => {
    window.__app.store.setState({
      uploads: [
        { id: 'u1', name: 'a.bin', uploadName: 'a.bin', sent: 3000000, total: 6000000, rate: 1500000, attempts: 1, status: 'uploading', error: null, prefix: '', bucket: 'b' },
        { id: 'u2', name: 'b.bin', uploadName: 'b.bin', sent: 0, total: 2000000, rate: 0, attempts: 0, status: 'queued', error: null, prefix: '', bucket: 'b' },
      ],
      downloads: [
        { id: 'd1', kind: 'file', name: 'c.bin', received: 1000000, total: 4000000, rate: 800000, status: 'downloading', error: null, runtime: 'browser' },
      ],
    });
  });

  // Combined overall progress bar + stats (with % and time-left) across both.
  await expect(page.getByTestId('transfer-overview')).toBeVisible();
  await expect(page.getByTestId('transfer-overall')).toBeVisible();
  await expect(page.getByTestId('transfer-overall-stats')).toContainText('%');
  await expect(page.getByTestId('transfer-overall-stats')).toContainText('Time left');
  await expect(page.getByTestId('transfer-overview-count')).toContainText('3');

  // Expand to the full-window panel.
  await page.getByTestId('transfer-expand-toggle').click();
  await expect(page.getByTestId('transfer-docks')).toHaveClass(/expanded/);

  // Cancel everything in one click.
  await page.getByTestId('transfer-cancel-all').click();
  await expect(page.getByTestId('upload-status-u1')).toContainText('Cancelled');
  await expect(page.getByTestId('upload-status-u2')).toContainText('Cancelled');
  await expect(page.getByTestId('download-status-d1')).toContainText('Cancelled');

  // Escape collapses back to the docks.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('transfer-docks')).not.toHaveClass(/expanded/);
});

test('upload dock stays usable with a huge batch (row cap, failures stay visible)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__app);
  await page.evaluate(() => {
    const ups = [];
    for (let i = 0; i < 120; i += 1) {
      ups.push({ id: `u${i}`, name: `f${i}.bin`, uploadName: `f${i}.bin`, sent: 1000, total: 1000, rate: 0, attempts: 1, status: 'done', error: null, prefix: '', bucket: 'b' });
    }
    // A failure as the LAST item — without priority ordering it'd be hidden.
    ups[119] = { id: 'uERR', name: 'broken.bin', uploadName: 'broken.bin', sent: 0, total: 1000, rate: 0, attempts: 3, status: 'error', error: 'Network error', prefix: '', bucket: 'b' };
    window.__app.store.setState({ uploads: ups });
  });

  await expect(page.getByTestId('upload-manager')).toBeVisible();
  // Capped: a "+N more" note appears and the DOM isn't flooded with 120 rows.
  await expect(page.getByTestId('upload-more-note')).toBeVisible();
  expect(await page.locator('[data-testid^="upload-task-"]').count()).toBeLessThanOrEqual(80);
  // The failure surfaces (priority) and is retryable; summary shows the count.
  await expect(page.getByTestId('upload-task-uERR')).toBeVisible();
  await expect(page.getByTestId('upload-retry-all')).toBeVisible();
  await expect(page.getByTestId('upload-stats')).toContainText('failed');
});
