import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'vr01a-public-xr.spec.ts',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.GS_VR01A_BASE_URL,
    launchOptions: {
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
});
