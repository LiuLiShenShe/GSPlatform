/**
 * GS-DESKTOP-03 公共启动与取证工具（真实浏览器，headful + Xvfb + NVIDIA GPU）。
 *
 * 与 GS-DESKTOP-02 的差别：上一轮用 headless + SwiftShader，WebGL/WebGPU canvas
 * 不参与截图合成（截图里 3D 视口全黑）。本轮用 **headful Chrome** 挂在隔离的
 * Xvfb 显示 :98 上，并强制 ANGLE/Vulkan 走真实 NVIDIA 设备，因此：
 *   - 页面截图包含真实 3D 画面（compositor 合成）；
 *   - 官方 `captureFrame()` 也能给出纯渲染结果（无 UI）。
 * 运行前需要：Xvfb :98 -screen 0 1920x1080x24 &
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

export const OUT = process.env.GSD03_OUT
  ?? path.resolve(import.meta.dirname, '../../../../docs/reports/gsdesktop03-evidence');

/** 证据截图编码：WebP q85。原始 PNG 单张 0.5–4 MB，原样入库会让证据目录到 32 MB。 */
export const SHOT_FORMAT = 'webp';
export const SHOT_QUALITY = 85;
export const SHOT_MAX_WIDTH = 1600;
export const DISPLAY = process.env.GSD03_DISPLAY ?? ':98';
export const BASE = process.env.GSD03_BASE ?? 'http://localhost:5173';

export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--window-size=1920,1200',
  '--window-position=0,0',
  // 真实 GPU：ANGLE Vulkan 走 NVIDIA（实测 RTX A6000，非 SwiftShader）
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-webgl',
  // Xvfb 里窗口不应被当作遮挡而冻结渲染循环
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
];

export function ensureOut() { fs.mkdirSync(OUT, { recursive: true }); }

export async function launch(browser = 'chrome') {
  return chromium.launch({
    channel: browser,
    headless: false,
    args: LAUNCH_ARGS,
    env: { ...process.env, DISPLAY },
  });
}

export async function newPage(browser, { width = 1600, height = 1000, base = BASE } = {}) {
  const context = await browser.newContext({ baseURL: base, viewport: { width, height } });
  const page = await context.newPage();
  const events = { consoleErrors: [], pageErrors: [], failedRequests: [], responses: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') events.consoleErrors.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => events.pageErrors.push(String(e).slice(0, 400)));
  page.on('requestfailed', (r) => events.failedRequests.push(`${r.failure()?.errorText} ${r.url().slice(0, 200)}`));
  page.on('response', (r) => {
    const u = r.url();
    if (/\/(assets|versions)\//.test(u)) events.responses.push({ status: r.status(), url: u.replace(/^.*\/api\/v1\//, '/api/v1/').slice(0, 220) });
  });
  page.on('crash', () => events.pageErrors.push('PAGE_CRASH'));
  return { context, page, events };
}

export async function diag(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    try { return JSON.parse(el?.textContent ?? '{}'); } catch { return {}; }
  });
}

export async function waitLoaded(page, timeout = 180_000) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    if (!el) return false;
    try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
  }, { timeout });
  // 等第一帧真正有 Gaussian（gsplats > 0），否则截图可能还是空场景
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    if (!el) return false;
    try { return (JSON.parse(el.textContent ?? '{}').gsplats ?? 0) > 0; } catch { return false; }
  }, { timeout }).catch(() => {});
  return diag(page);
}

export async function openViewer(page, scene) {
  await page.goto(`/scene/${scene}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]', { timeout: 60_000 });
  return waitLoaded(page);
}

/**
 * 证据截图：直接用 Playwright 的 WebP 编码。
 * 原始 PNG 单张 0.5–4 MB（32 MB 全量），WebP q85 在 1600 宽下内容不变、目录降到 ~2.3 MB
 * （任务 §11：证据目录过大时保留轻量截图 + JSON 入库）。
 * 注意：任务编号脚本里仍写 `.png`，这里统一改写扩展名，不改内容、不裁切。
 */
export async function shot(page, name, opts = {}) {
  ensureOut();
  const file = name.replace(/\.png$/, '.webp');
  await page.screenshot({
    path: path.join(OUT, file),
    type: 'webp',
    quality: SHOT_QUALITY,
    ...opts,
  });
}

/** 官方 captureFrame 的纯渲染结果（无 UI），用于画质证据。 */
export async function capture(page, name, { width = 1600, height = 1000, supersample = 1 } = {}) {
  ensureOut();
  const result = await page.evaluate(
    ([w, h, ss]) => (window.__gsruntime ?? window.__gsauthoringruntime)
      ?.captureScreenshot({ width: w, height: h, supersample: ss, format: 'image/webp', quality: 0.85 })
      ?? null,
    [width, height, supersample],
  );
  if (!result?.dataUrl) return false;
  // captureScreenshot 返回的已经是 WebP dataURL（上面显式指定），落盘扩展名同步。
  const file = name.replace(/\.png$/, '.webp');
  fs.writeFileSync(path.join(OUT, file), Buffer.from(result.dataUrl.split(',')[1], 'base64'));
  return true;
}

export function writeJson(name, data) {
  ensureOut();
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
}

export function readJson(name, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8')); } catch { return fallback; }
}

export function dist(a, b) {
  if (!a || !b) return NaN;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function log(...args) { console.log(...args); }

/**
 * 相机 pose / 运行态读数 —— 浏览页有 `ov-diagnostics`，创作页没有该节点，
 * 因此统一走 DEV 调试把柄 `window.__gsruntime`（两页都由 useSuperSplatDesktop 挂）。
 */
export async function pose(page) {
  return page.evaluate(() => {
    const rt = window.__gsruntime ?? window.__gsauthoringruntime;
    if (!rt) return null;
    const p = rt.getCameraPose?.();
    return p ? { position: p.position, target: p.target, fov: p.fov } : null;
  });
}

export async function runtimeState(page) {
  return page.evaluate(() => {
    const rt = window.__gsruntime ?? window.__gsauthoringruntime;
    if (!rt) return null;
    return {
      loaded: rt.state.loaded,
      progress: rt.state.progress,
      cameraMode: rt.state.cameraMode,
      showAnnotations: rt.state.showAnnotations,
      performanceMode: rt.state.performanceMode,
      walkAllowed: rt.state.walkAllowed,
      hasCollision: rt.state.hasCollision,
      isFullscreen: rt.state.isFullscreen,
    };
  });
}

/** 等待创作页/浏览页的官方 runtime 真正加载完成。 */
export async function waitRuntime(page, timeout = 180_000) {
  await page.waitForFunction(
    () => (window.__gsruntime ?? window.__gsauthoringruntime)?.state?.loaded === true,
    { timeout },
  );
  await page.waitForTimeout(500);
  return pose(page);
}
