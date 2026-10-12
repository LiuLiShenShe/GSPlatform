import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'vr01c-pico.spec.ts', timeout: 190_000,
  workers: 1, retries: 0,
  use: {
    baseURL: process.env.GS_VR01C_BASE_URL,
    viewport: { width: 960, height: 720 },
    acceptDownloads: true,
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=1536'] },
  },
});
