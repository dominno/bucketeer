import './tests/helpers/loadEnv.js'; // populate E2_CREDS_FILE etc. from .env (no-op if absent)
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// Throwaway server-side profiles file so the UI test's added profiles never
// touch the real config/profiles.json. Shared with globalTeardown via env.
const PROFILES_PATH = path.join(os.tmpdir(), `clud-e2e-profiles-${randomUUID()}.json`);
process.env.E2E_PROFILES_PATH = PROFILES_PATH;
const PORT = process.env.E2E_PORT || '5180';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1, // single server + shared server-side profile store -> run serially
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  globalTeardown: './tests/global-teardown.js',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node backend/server.js',
    env: { PORT, PROFILES_PATH },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
