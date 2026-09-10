import { chromium, expect, test as base, type Page } from '@playwright/test';

/**
 * Shared Chromium launch arguments for the Phase 03 e2e suite.
 *
 * Headless SwiftShader/WebGPU needs a non-default flag set: software WebGPU,
 * Vulkan passthrough for `requestDevice`, and crucially `--disable-*` flags
 * that keep the GPU process alive and its timers unfrozen even when the
 * compositor is idle (P03-001 family). `--disable-dev-shm-usage` fixes
 * context-creation wedge caused by exhausted `/dev/shm` in containers.
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
];

interface FreshBrowserFixtures {
  page: Page;
}

/**
 * Test fixture that gives every test its OWN Chromium browser process.
 *
 * Background: SuperSplat's WebGPU device teardown in headless SwiftShader
 * wedges the GPU process; the *next* test's browser-context creation then
 * hangs with `Test timeout exceeded while setting up "context"`, no matter
 * how generous the timeout. Give each test a fresh process so a heavy test
 * can never poison the one after it. Startup cost (~1s) is negligible next
 * to a full low→high progressive load (~25s+).
 */
export const test = base.extend<FreshBrowserFixtures>({
  page: async ({}, use) => {
    const browser = await chromium.launch({
      headless: true,
      args: LAUNCH_ARGS,
    });
    const context = await browser.newContext({
      baseURL: process.env.PW_BASE_URL ?? 'http://localhost:5173',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
    await browser.close();
  },
});

export { expect };