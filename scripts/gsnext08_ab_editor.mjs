// GS-NEXT-08 Editor A/B render harness.
// Loads the original and each floater-filter candidate into the pinned official
// SuperSplat Editor and screenshots four shared camera poses per file. All poses
// are captured from the ORIGINAL and forced onto every candidate via
// setPoseOverride, so A/B/C/D share byte-identical camera/render state.
// No writes to any model; no publishing; single local same-origin Editor.
//
// Env: GSNEXT08_ROOT, GSNEXT08_FILES (json [{label,path,count}]), GSNEXT08_EDITOR_URL
import playwright from '../node_modules/playwright/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.GSNEXT08_ROOT;
const files = JSON.parse(process.env.GSNEXT08_FILES || '[]');
const editorUrl = process.env.GSNEXT08_EDITOR_URL || 'http://127.0.0.1:18031/gaussian-editor/';
if (!root || !files.length) throw new Error('Set GSNEXT08_ROOT and GSNEXT08_FILES');
for (const dir of ['screenshots', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
if (fs.existsSync(path.join(root, 'ab-editor-result.json'))) throw new Error('Use a new evidence directory');

const views = {
    overall: { azim: 315, elev: -12 },
    side: { azim: 90, elev: 0 },
    bottom: { azim: 0, elev: 80 },
    front: { azim: 0, elev: 0 }
};
const errors = [], steps = [], resources = [], consoleLog = [];
let browser, context, page, monitor, safetyError;

const gpuSample = () => {
    const gpu = execFileSync('nvidia-smi', ['--query-gpu=index,uuid,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
        .trim().split('\n').map(line => { const [i, uuid, used, util] = line.split(',').map(s => s.trim()); return { index: +i, uuid, usedMiB: +used, util: +util }; });
    const compute = execFileSync('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid,used_memory,process_name', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim();
    const sample = { time: new Date().toISOString(), gpu, compute };
    resources.push(sample);
    return sample;
};
const isOwnGpuProcess = (line) => {
    const fields = line.split(',').map(s => s.trim());
    if (fields[1] !== baseline.gpu[0].uuid) return false;
    let pid = Number(fields[0]);
    for (let i = 0; i < 15 && pid > 1; i++) {
        if (pid === process.pid) return true;
        try { pid = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)[1]); }
        catch { return false; }
    }
    return false;
};
const baseline = gpuSample();
if (baseline.compute || baseline.gpu[0].util > 20 || baseline.gpu[0].usedMiB > 2000) {
    throw new Error(`GPU0 not idle for a browser session: ${JSON.stringify(baseline)}`);
}
const checkSafety = () => {
    const current = gpuSample();
    const external = current.compute.split('\n').filter(Boolean).filter(line => !isOwnGpuProcess(line));
    if (external.length || current.gpu[1].usedMiB > baseline.gpu[1].usedMiB + 2) {
        throw new Error(`External GPU activity detected; stopping own browser: ${JSON.stringify(external)}`);
    }
};
const assertSafe = () => { if (safetyError) throw safetyError; checkSafety(); };

const stats = async () => (await page.locator('#status-bar .status-bar-stat-value').allTextContents()).map(t => Number(t.replaceAll(',', '')));
const snapshot = async () => page.evaluate(() => {
    const c = window.scene.camera, cam = c.camera;
    const p = c.position, q = c.mainCamera.getRotation();
    const num = (v) => Array.from(v?.data ?? [v?.x, v?.y, v?.z, v?.w] ?? []);
    return { position: [p.x, p.y, p.z], rotation: num(q),
        fov: cam.fov, near: c.near, far: c.far, tonemapping: c.tonemapping,
        worldTransform: num(c.worldTransform),
        viewMatrix: num(cam.viewMatrix), projectionMatrix: num(cam.projectionMatrix),
        overlay: document.querySelector('#camera-info-overlay')?.innerText || null };
});
const applyPose = async (pose) => {
    await page.evaluate((ref) => {
        const c = window.scene.camera;
        const V = c.position.constructor;
        const Q = c.mainCamera.getRotation().constructor;
        c.setPoseOverride({ position: new V(...ref.position), rotation: new Q(...ref.rotation), fov: ref.fov, near: ref.near, far: ref.far });
    }, pose);
    await page.waitForTimeout(1000);
    const s = await snapshot();
    const close = (a, b) => Math.abs(a - b) <= 1e-4;
    const vec = (a, b) => Array.isArray(a) && a.length === 4 && a.every((v, i) => close(v, b[i]));
    const ok = s.position.every((v, i) => close(v, pose.position[i])) && vec(s.rotation, pose.rotation)
        && close(s.fov, pose.fov) && close(s.near, pose.near) && close(s.far, pose.far);
    if (!ok) throw new Error(`pose override not applied: ${JSON.stringify(s)} vs ${JSON.stringify(pose)}`);
    return s;
};
const capture = async (name) => {
    assertSafe();
    await page.mouse.move(1498, 30);
    await page.screenshot({ path: path.join(root, 'screenshots', `${name}.png`), fullPage: true });
    await page.locator('canvas').first().screenshot({ path: path.join(root, 'screenshots', `${name}-canvas.png`) });
    steps.push({ name, stats: await stats(), camera: await snapshot() });
};

const poses = {}; // captured from the original, forced on all
let result;
try {
    browser = await playwright.chromium.launch({ headless: false, executablePath: '/usr/bin/google-chrome', args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
        '--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=native', '--disable-vulkan-surface',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--window-size=1500,967'
    ] });
    context = await browser.newContext({ viewport: { width: 1500, height: 967 } });
    monitor = setInterval(() => { try { checkSafety(); } catch (e) { safetyError = e; void context?.close(); } }, 5000);
    await context.addInitScript(() => {
        Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
        Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(editorUrl).origin || ['data:', 'blob:'].includes(url.protocol)) await route.continue();
        else await route.abort();
    });
    page = await context.newPage();
    page.on('pageerror', e => errors.push({ message: e.message }));
    page.on('console', m => consoleLog.push({ type: m.type(), text: m.text() }));
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const runtime = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        return { hasWebGPU: !!navigator.gpu, adapter: adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture } : null };
    });
    steps.push({ name: 'runtime', runtime });

    // PCUI menus are span.menu-option / div.menu-row; the UI locale is Chinese.
    const openMenu = async (label) => {
        await page.locator(`span.menu-option`, { hasText: new RegExp(`^${label}$`) }).first().click();
        await page.waitForTimeout(500);
    };
    const clickRow = async (label) => {
        await page.locator(`div.menu-row`, { hasText: new RegExp(`^${label}$`) }).first().click();
        await page.waitForTimeout(400);
    };
    const splatCount = async () => {
        const stats = await page.locator('#status-bar .status-bar-stat-value').allTextContents();
        return Number((stats[0] || '0').replaceAll(',', ''));
    };
    // The Editor merges an imported PLY into the current scene, so each candidate
    // must start from an EMPTY scene. Try the official 新建 (New) path, then fall
    // back to a page reload; either way require the splat count to be exactly 0.
    const resetToEmptyScene = async () => {
        await openMenu('文件');
        await clickRow('新建');
        await page.waitForTimeout(1200);
        if (await splatCount() !== 0) {
            await page.goto(editorUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3500);
        }
        const splats = await splatCount();
        if (!Number.isFinite(splats) || splats !== 0) {
            throw new Error(`Editor scene not empty before import: ${splats}`);
        }
    };

    for (const file of files) {
        assertSafe();
        if (file.label !== files[0].label) await resetToEmptyScene();
        await openMenu('文件');
        await clickRow('导入...');
        await page.locator('#file-selector').setInputFiles(file.path);
        await page.waitForFunction((expected) =>
            document.querySelector('#status-bar .status-bar-stat-value')?.textContent === expected.toLocaleString('en-US'),
            file.count, { timeout: 600000 });
        await page.waitForTimeout(3500);
        const label = path.basename(file.path);
        try { await page.getByText(label, { exact: true }).first().click({ timeout: 4000 }); } catch { /* single item auto-selected */ }
        await page.keyboard.press('f');
        await page.waitForTimeout(2500);
        if (!(await page.locator('#camera-info-overlay').isVisible().catch(() => false))) await page.keyboard.press('i');
        steps.push({ name: `loaded-${file.label}`, stats: await stats(), expected: file.count });

        for (const view of Object.keys(views)) {
            if (file.label === 'A-original') {
                await page.evaluate((def) => {
                    const c = window.scene.camera;
                    c.setPoseOverride(null);
                    c.setAzimElev(def.azim, def.elev, 0);
                    c.onUpdate(0);
                    const q = c.mainCamera.getRotation().clone(), p = c.position.clone();
                    c.setPoseOverride({ position: p, rotation: q, fov: c.fov, near: c.near, far: c.far });
                }, views[view]);
                await page.waitForTimeout(1200);
                poses[view] = await snapshot();
            } else {
                await applyPose(poses[view]);
            }
            await capture(`${file.label}-${view}`);
        }
    }
    result = { status: 'PASS', poses: Object.fromEntries(Object.entries(poses).map(([k, v]) => [k, { position: v.position, rotation: v.rotation, fov: v.fov, near: v.near, far: v.far }])) };
} catch (e) {
    result = { status: 'FAILED', error: String(e && e.stack || e) };
} finally {
    if (monitor) clearInterval(monitor);
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    fs.writeFileSync(path.join(root, 'ab-editor-result.json'), JSON.stringify({
        result, steps, errors, resourceBaseline: baseline, resources, views }, null, 2));
    fs.writeFileSync(path.join(root, 'logs', 'ab-editor-console.json'), JSON.stringify(consoleLog.slice(-400), null, 2));
}
console.log(JSON.stringify(result));
if (result.status !== 'PASS') process.exit(1);
