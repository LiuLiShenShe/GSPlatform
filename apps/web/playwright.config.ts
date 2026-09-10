import { defineConfig } from '@playwright/test';
import { LAUNCH_ARGS } from './e2e/fresh-browser';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    // WebGPU via SwiftShader in headless Chrome. The spec's `page` fixture
    // launches its OWN browser per test (see fresh-browser.ts); the flags are
    // shared here so direct `page.goto` without the fixture stays consistent.
    launchOptions: {
      args: LAUNCH_ARGS,
    },
  },
  webServer: {
    command: 'pnpm --filter @gsplatform/web dev',
    port: 5173,
    timeout: 60_000,
    reuseExistingServer: !!process.env.CI === false,
  },
});
