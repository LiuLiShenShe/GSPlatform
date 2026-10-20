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
  // GS-NEXT-10: GPU-process compositing with SwiftShader WebGPU stalls the
  // renderer's frame production (measured: `app.frame` frozen for 10s+ while a
  // camera transition was in flight; the page eventually crashed). Rendering the
  // canvas on the CPU keeps the tick loop running so camera transitions can
  // complete. Without it, every frame/reset/viewpoint/annotation assertion
  // spuriously fails even though the product logic is correct.
  '--disable-gpu-compositing',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
];

/**
 * Launch with the **full** Chromium build, not Playwright's stripped
 * `chromium_headless_shell`.
 *
 * GS-NEXT-10 root cause (verified): the headless shell freezes the renderer's
 * `requestAnimationFrame` as soon as the official viewer switches to on-demand
 * rendering (`app.autoRender = false`, which happens at `state.progress = 100`).
 * From then on `app.tick` is never scheduled again: measured `rAF = 0/s`,
 * `app.frame` frozen, so *every* camera transition — frameScene, resetCamera,
 * saved viewpoints, annotation navigation — silently does nothing. The same
 * build under the full Chromium runs `rAF` at ~60/s and the camera moves.
 *
 * That is a test-harness defect, not a product defect. Do not "fix" a camera
 * assertion by loosening it — assert against a browser that actually ticks.
 */
export const LAUNCH_OPTIONS = {
  headless: true,
  channel: 'chromium',
  args: LAUNCH_ARGS,
} as const;

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
    const browser = await chromium.launch(LAUNCH_OPTIONS);
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