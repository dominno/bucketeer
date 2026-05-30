// After the Playwright run, delete every object the UI tests created (all live
// under the qa-ui- prefix) and remove the throwaway profiles file.
import fs from 'node:fs';
import { loadCreds, TEST_BUCKET } from './helpers/credentials.js';
import { rawClient, sweepPrefix } from './helpers/s3-fixture.js';

export default async function globalTeardown() {
  try {
    const client = rawClient(loadCreds());
    const removed = await sweepPrefix(client, TEST_BUCKET, 'qa-ui-');
    // eslint-disable-next-line no-console
    console.log(`[e2e teardown] removed ${removed} object(s) under "qa-ui-"`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e teardown] S3 sweep failed: ${e.message}`);
  }
  const pf = process.env.E2E_PROFILES_PATH;
  if (pf) {
    try {
      fs.unlinkSync(pf);
    } catch {
      /* already gone */
    }
  }
}
