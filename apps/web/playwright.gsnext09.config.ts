/**
 * GS-NEXT-09 audit-only Playwright config.
 *
 * The committed `playwright.config.ts` hardcodes baseURL/port 5173, which on
 * this shared machine is owned by an unrelated project. This override points
 * the `request` fixture and `page` fixture at the audit's own isolated
 * dev-identity stack (API :8001 + vite :5199) without touching the committed
 * config. Nothing here changes product behaviour.
 */
import { defineConfig } from '@playwright/test';
import { LAUNCH_ARGS } from './e2e/fresh-browser';

const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5199';

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  retries: 0,
  use: {
    baseURL: BASE,
    launchOptions: { args: LAUNCH_ARGS },
  },
});
