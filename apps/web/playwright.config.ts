import { defineConfig } from '@playwright/test';
import { LAUNCH_OPTIONS } from './e2e/fresh-browser';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    // WebGPU via SwiftShader in headless Chrome. The spec's `page` fixture
    // launches its OWN browser per test (see fresh-browser.ts); the launch
    // options are shared here so direct `page.goto` without the fixture stays
    // consistent. `channel: 'chromium'` is REQUIRED — the headless shell freezes
    // rAF once on-demand rendering starts (GS-NEXT-10 root cause; see the
    // LAUNCH_OPTIONS comment).
    launchOptions: LAUNCH_OPTIONS,
  },
  webServer: {
    command: 'pnpm --filter @gsplatform/web dev',
    port: 5173,
    timeout: 60_000,
    reuseExistingServer: !!process.env.CI === false,
  },
});
