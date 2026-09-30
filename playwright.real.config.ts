import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Import Lab, tier 2: a real browser against a real (isolated) Nebulis server.
 * No page.route() mocking of import behaviour. Run: npm run test:e2e:real
 *
 * Ports are deliberately not the dev ones (3002 / 5173) so a running dev server is left alone.
 * The specs read the server's database and library directly to verify what landed, so the
 * worker processes get the same DATA_DIR / LIBRARY_DIR the server uses.
 */
const HOME = path.join(fs.realpathSync(os.tmpdir()), 'nebulis-lab-e2e-real');   // must match scripts/lab-server.mjs
process.env.DATA_DIR = path.join(HOME, 'data');
process.env.LIBRARY_DIR = path.join(HOME, 'library');

export default defineConfig({
  testDir: './tests/e2e-real',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: [['list'], ['./tests/lab/labPlaywrightReporter.ts']],
  use: {
    baseURL: 'http://localhost:5273',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node scripts/lab-server.mjs',
      url: 'http://127.0.0.1:3102/api/v1/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite --port 5273 --strictPort',
      url: 'http://localhost:5273',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NEBULIS_API_PROXY: 'http://127.0.0.1:3102' },
    },
  ],
});
