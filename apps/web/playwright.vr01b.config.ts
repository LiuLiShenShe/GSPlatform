import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'vr01b-sog.spec.ts',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.GS_VR01B_BASE_URL,
    viewport: { width: 960, height: 720 },
    launchOptions: {
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
});
