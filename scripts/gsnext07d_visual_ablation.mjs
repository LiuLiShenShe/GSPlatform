// TEST_ONLY. Renders an existing diagnostic subset in the pinned official Editor.
// No input/model writes, server conversion, publishing, or full-scene rendering.
import playwright from '../node_modules/playwright/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.GSNEXT07D_ROOT;
const input = process.env.GSNEXT07D_INPUT;
const mapping = process.env.GSNEXT07D_MAPPING;
const baselineFile = process.env.GSNEXT07D_CAMERA_BASELINE;
const editorUrl = process.env.GSNEXT07D_EDITOR_URL || 'http://127.0.0.1:18031/gaussian-editor/';
if (!root || !input || !mapping || !baselineFile) {
    throw new Error('Set GSNEXT07D_ROOT, GSNEXT07D_INPUT, GSNEXT07D_MAPPING and GSNEXT07D_CAMERA_BASELINE');
}
for (const dir of ['screenshots', 'projects']) fs.mkdirSync(path.join(root, dir), { recursive: true });
if (fs.existsSync(path.join(root, 'browser-experiment.json'))) throw new Error('Use a new evidence directory');

const steps = [], errors = [], consoleLog = [], network = [], failed = [], resources = [];
const views = {
    overall: { azim: 315, elev: -10, rounded: '-157.26, -76.3, 549.41' },
    side: { azim: 90, elev: 0, rounded: '391.59, -132.48, 324.1' },
    bottom: { azim: 0, elev: 90, rounded: '68.04, -456.03, 324.1' },
    front: { azim: 0, elev: 0, rounded: '68.04, -132.48, 647.65' }
};
let context, browser, page, monitor, safetyError;
const gpuSample = () => {
    const gpu = execFileSync('nvidia-smi', [
        '--query-gpu=index,uuid,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'
    ], { encoding: 'utf8' }).trim().split('\n').map(line => {
        const [index, uuid, usedMiB, freeMiB, utilization] = line.split(',').map(s => s.trim());
        return { index: Number(index), uuid, usedMiB: Number(usedMiB), freeMiB: Number(freeMiB), utilization: Number(utilization) };
    });
    const compute = execFileSync('nvidia-smi', [
        '--query-compute-apps=pid,gpu_uuid,used_memory,process_name', '--format=csv,noheader,nounits'
    ], { encoding: 'utf8' }).trim();
    const sample = { time: new Date().toISOString(), gpu, compute };
    resources.push(sample);
    return sample;
};
const baseline = gpuSample();
if (baseline.compute || baseline.gpu[0].freeMiB < 8192 || baseline.gpu[0].utilization > 20) {
    throw new Error('GPU0 is not idle/safely available; no browser launched');
}
const isOwnGpuProcess = (line) => {
    const fields = line.split(',').map(s => s.trim());
    if (fields[1] !== baseline.gpu[0].uuid || !line.includes('--type=gpu-process')) return false;
    let pid = Number(fields[0]);
    for (let i = 0; i < 12 && pid > 1; i++) {
        if (pid === process.pid) return true;
        try { pid = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)[1]); }
        catch { return false; }
    }
    return false;
};
const checkSafety = () => {
    const current = gpuSample();
    const externalCompute = current.compute.split('\n').filter(Boolean).filter(line => !isOwnGpuProcess(line));
    if (externalCompute.length || current.gpu[1].usedMiB > baseline.gpu[1].usedMiB + 1 ||
        current.gpu[0].usedMiB > baseline.gpu[0].usedMiB + 2048) {
        throw new Error('Resource safety changed: stop own browser session');
    }
};
const assertSafe = () => { if (safetyError) throw safetyError; checkSafety(); };

const stats = async () => (await page.locator('#status-bar .status-bar-stat-value').allTextContents())
    .map(text => Number(text.replaceAll(',', '')));
const assertStats = async (expected, label) => {
    const actual = await stats();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)}`);
};
const snapshot = async () => page.evaluate(() => {
    const s = window.scene, c = s.camera, cam = c.camera;
    const p = c.position, q = c.mainCamera.getRotation();
    return {
        position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w],
        worldTransform: Array.from(c.worldTransform.data),
        viewMatrix: Array.from(cam.viewMatrix.data), projectionMatrix: Array.from(cam.projectionMatrix.data),
        orbit: c.docSerialize(), sceneRadius: c.sceneRadius,
        near: c.near, far: c.far, fov: cam.fov, horizontalFov: cam.horizontalFov,
        poseOverride: c.poseOverride ? {
            position: [c.poseOverride.position.x, c.poseOverride.position.y, c.poseOverride.position.z],
            rotation: [c.poseOverride.rotation.x, c.poseOverride.rotation.y, c.poseOverride.rotation.z, c.poseOverride.rotation.w],
            fov: c.poseOverride.fov, near: c.poseOverride.near, far: c.poseOverride.far
        } : null,
        projection: cam.projection, aspectRatio: cam.aspectRatio, exposure: s.config.camera.exposure,
        tonemapping: c.tonemapping, targetSize: c.targetSize,
        renderOverlays: c.renderOverlays, movingRender: s.movingRender, warpedRender: s.warpedRender,
        stochastic: s.stochastic, view: s.events.invoke('docSerialize.view'),
        sceneBound: { center: [s.bound.center.x, s.bound.center.y, s.bound.center.z],
            halfExtents: [s.bound.halfExtents.x, s.bound.halfExtents.y, s.bound.halfExtents.z] }
    };
});
const cameraBaseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
if (Object.keys(cameraBaseline.references || {}).length !== 4) {
    throw new Error('Camera calibration must contain all four recorded A poses');
}
const references = structuredClone(cameraBaseline.references);
const actualReferences = {};
const renderFields = ['position', 'rotation', 'worldTransform', 'viewMatrix', 'projectionMatrix',
    'near', 'far', 'fov', 'horizontalFov', 'projection', 'aspectRatio', 'exposure', 'tonemapping',
    'targetSize', 'renderOverlays', 'movingRender', 'warpedRender', 'stochastic', 'view', 'poseOverride'];
const exactRenderState = state => ({ ...Object.fromEntries(renderFields.map(key => [key, state[key]])),
    focalPoint: state.orbit.focalPoint });
const setView = async (name) => {
    assertSafe();
    await page.evaluate(({ definition, reference }) => {
        const c = window.scene.camera;
        c.setPoseOverride(null);
        if (reference) {
            c.fov = reference.fov;
            c.setPose(new c.position.constructor(...reference.position),
                new c.position.constructor(...reference.orbit.focalPoint), 0);
            const q = c.mainCamera.getRotation().clone();
            q.set(...reference.rotation);
            c.setPoseOverride({ position: new c.position.constructor(...reference.position), rotation: q,
                fov: reference.fov, near: reference.near, far: reference.far });
        } else {
            c.setAzimElev(definition.azim, definition.elev, 0);
            c.onUpdate(0);
            c.setPoseOverride({ position: c.position.clone(), rotation: c.mainCamera.getRotation().clone(),
                fov: c.fov, near: c.near, far: c.far });
        }
    }, { definition: views[name], reference: references[name] });
    await page.waitForTimeout(1100);
    await page.waitForFunction(expected => document.querySelector('#camera-info-overlay')?.innerText.includes(expected),
        views[name].rounded, { timeout: 10000 });
    const current = await snapshot();
    if (!references[name]) references[name] = current;
    // Calibration restoration permits only Float32 reconstruction noise.
    // Captures below additionally require exact equality with the actual A.
    const comparable = state => ({
        position: state.position, rotation: state.rotation, worldTransform: state.worldTransform,
        viewMatrix: state.viewMatrix, projectionMatrix: state.projectionMatrix,
        near: state.near, far: state.far, fov: state.fov, horizontalFov: state.horizontalFov,
        projection: state.projection, aspectRatio: state.aspectRatio, exposure: state.exposure,
        tonemapping: state.tonemapping, targetSize: state.targetSize, renderOverlays: state.renderOverlays,
        movingRender: state.movingRender, warpedRender: state.warpedRender, stochastic: state.stochastic,
        view: state.view, focalPoint: state.orbit.focalPoint
    });
    const equal = (a, b) => {
        if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6;
        if (a && b && typeof a === 'object' && typeof b === 'object') {
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length && keys.every(key => equal(a[key], b[key]));
        }
        return a === b;
    };
    if (!equal(comparable(current), comparable(references[name]))) {
        fs.writeFileSync(path.join(root, `mismatch-${name}.json`), JSON.stringify({ reference: references[name], current }, null, 2));
        throw new Error(`Exact camera/render mismatch: ${name}`);
    }
};
const capture = async (name, phase) => {
    assertSafe();
    const before = await snapshot();
    const viewName = Object.keys(views).find(view => name.endsWith(`-${view}`));
    if (phase === 'A_ORIGINAL') actualReferences[viewName] = exactRenderState(before);
    else if (viewName && ['A_STABILITY_CONTROL', 'B_SINGLE_DELETED', 'UNDO_RESTORED'].includes(phase)) {
        if (JSON.stringify(exactRenderState(before)) !== JSON.stringify(actualReferences[viewName])) {
            throw new Error(`Camera/render state must exactly match actual A: ${name}`);
        }
    }
    await page.mouse.move(1498, 30);
    await page.screenshot({ path: path.join(root, 'screenshots', `${name}.png`), fullPage: true });
    await page.locator('canvas').first().screenshot({ path: path.join(root, 'screenshots', `${name}-canvas.png`) });
    const after = await snapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`State moved during screenshot: ${name}`);
    steps.push({ name, phase, stats: await stats(), camera: before,
        cameraOverlay: await page.locator('#camera-info-overlay').innerText(),
        canvas: await page.locator('canvas').first().evaluate(c => ({ width: c.width, height: c.height,
            cssWidth: c.clientWidth, cssHeight: c.clientHeight })) });
};
const saveProject = async (name, phase) => {
    await page.getByText('File', { exact: true }).click();
    await page.getByText('Save As...', { exact: true }).click();
    const popup = page.locator('#export-popup');
    await popup.waitFor({ state: 'visible' });
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await popup.locator('button').filter({ hasText: /^Save$/ }).click();
    const download = await downloadPromise;
    const target = path.join(root, 'projects', `${name}.ssproj`);
    await download.saveAs(target);
    steps.push({ name: `project-${name}`, phase, path: target });
    return target;
};
const auditProject = (project, expected, selected) => {
    const output = execFileSync('python3', [path.join(import.meta.dirname, 'gsnext07d_evidence.py'),
        'audit-project', '--input', input, '--mapping', mapping, '--project', project,
        '--expected-count', String(expected), '--selected', String(selected)], { encoding: 'utf8' });
    const audit = JSON.parse(output);
    steps.push({ name: `audit-${path.basename(project)}`, phase: 'IDENTITY_AUDIT', audit });
    return audit;
};

let result;
try {
    browser = await playwright.chromium.launch({ headless: false, executablePath: '/usr/bin/google-chrome', args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
        '--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=native', '--disable-vulkan-surface',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--window-size=1500,967'
    ] });
    context = await browser.newContext({ viewport: { width: 1500, height: 967 }, acceptDownloads: true });
    monitor = setInterval(() => {
        try { checkSafety(); } catch (error) { safetyError = error; void context.close(); }
    }, 5000);
    await context.addInitScript(() => {
        Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
        Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(editorUrl).origin || ['data:', 'blob:'].includes(url.protocol)) await route.continue();
        else { network.push({ blockedExternal: url.origin, path: url.pathname }); await route.abort(); }
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack }));
    page.on('console', message => consoleLog.push({ type: message.type(), text: message.text(), location: message.location() }));
    page.on('request', request => network.push({ url: request.url(), method: request.method() }));
    page.on('requestfailed', request => failed.push({ url: request.url(), failure: request.failure() }));
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const runtime = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        return { userAgent: navigator.userAgent, secureContext: isSecureContext, hasWebGPU: !!navigator.gpu,
            adapter: adapter ? { info: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
                device: adapter.info?.device, description: adapter.info?.description },
                maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : null };
    });
    if (!runtime.adapter || runtime.adapter.info.vendor !== 'nvidia') throw new Error('Expected NVIDIA WebGPU adapter');
    await page.getByText('File', { exact: true }).click();
    await page.getByText('Import...', { exact: true }).click();
    await page.locator('#file-selector').setInputFiles(input);
    await page.waitForFunction(() => document.querySelector('#status-bar .status-bar-stat-value')?.textContent === '106,283',
        null, { timeout: 120000 });
    await page.waitForTimeout(2500);
    await page.getByText('support-aware-106283-original.ply', { exact: true }).click();
    await page.keyboard.press('f');
    await page.waitForTimeout(1800);
    if (!(await page.locator('#camera-info-overlay').isVisible())) await page.keyboard.press('i');
    await assertStats([106283, 0, 0, 0], 'original count');
    for (const view of Object.keys(views)) {
        await setView(view);
        await capture(`a-${view}`, 'A_ORIGINAL');
        await capture(`a-repeat-${view}`, 'A_STABILITY_CONTROL');
    }
    await setView('front');
    await page.locator('#bottom-toolbar-selection-mode').click();
    await page.keyboard.press('r');
    const candidates = await page.evaluate(() => {
        const scene = window.scene, c = scene.camera;
        const ndc = { x: 0, y: 0, z: 0 };
        c.worldToScreen({ x: 131.88282775878906, y: -250.7272491455078, z: 427.4365234375 }, ndc);
        const canvas = document.querySelector('canvas');
        const rect = canvas.getBoundingClientRect();
        const center = { x: rect.x + ndc.x * rect.width, y: rect.y + ndc.y * rect.height };
        const offsets = [{ x: 0, y: 0 }];
        for (let radius = 4; radius <= 40; radius += 4) {
            for (let y = -radius; y <= radius; y += 4) for (let x = -radius; x <= radius; x += 4) {
                if (Math.max(Math.abs(x), Math.abs(y)) === radius) offsets.push({ x, y });
            }
        }
        return { projected: ndc, center, candidates: offsets.map(p => ({ x: center.x + p.x, y: center.y + p.y }))
            .filter(p => p.x > rect.x && p.x < rect.right && p.y > rect.y && p.y < rect.bottom) };
    });
    steps.push({ name: 'target-screen-projection', projected: candidates.projected, center: candidates.center,
        candidateCount: candidates.candidates.length });
    let targetPicked = false;
    for (let i = 0; i < Math.min(120, candidates.candidates.length); i++) {
        if (i % 16 === 0) assertSafe();
        const point = candidates.candidates[i];
        await page.mouse.click(point.x, point.y);
        await page.waitForTimeout(80);
        const selected = await page.evaluate(() => {
            const splat = window.scene.elements.find(element => element.instances?.flags);
            const indices = [];
            for (let i = 0; i < splat.instances.count; i++) if (splat.instances.flags[i] & 1) indices.push(splat.instances.sourceRow[i]);
            return indices;
        });
        // In the imported PLY, the official instance sourceRow is the saved
        // resource row. The CPU audit below maps it back to support row 159.
        if (selected.length === 1 && selected[0] === 106274) {
            targetPicked = true;
            steps.push({ name: 'candidate-picked', pixel: point, runtimeRow: selected[0], candidateIndex: i });
            break;
        }
        if (selected.length) {
            await page.keyboard.press('Control+Shift+a');
            await page.waitForTimeout(100);
        }
    }
    if (!targetPicked) throw new Error('Official depth picker did not select a mapped target runtime row');
    await assertStats([106283, 1, 0, 0], 'single target selected');
    await capture('selected-target-11183581', 'SELECTED_NOT_DELETED');
    const selectedProject = await saveProject('selected-target-11183581', 'SELECTED_NOT_DELETED');
    auditProject(selectedProject, 106283, 1); // Exact 62-field match must pass BEFORE deletion.
    await page.keyboard.press('Delete');
    await page.waitForTimeout(1500);
    await assertStats([106282, 0, 0, 1], 'exactly one deletion');
    for (const view of Object.keys(views)) {
        await setView(view);
        await capture(`b-${view}`, 'B_SINGLE_DELETED');
        if (view === 'overall') auditProject(await saveProject('b-overall', 'B_SINGLE_DELETED'), 106282, 0);
    }
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1500);
    await assertStats([106283, 1, 0, 0], 'undo restores target and selection');
    const undoSelected = await saveProject('undo-selected-restored', 'UNDO_RESTORED_SELECTED');
    auditProject(undoSelected, 106283, 1);
    await page.keyboard.press('Control+Shift+a');
    await assertStats([106283, 0, 0, 0], 'clear selection for neutral undo screenshots');
    for (const view of Object.keys(views)) {
        await setView(view);
        await capture(`undo-${view}`, 'UNDO_RESTORED');
    }
    auditProject(await saveProject('undo-neutral-restored', 'UNDO_RESTORED'), 106283, 0);
    assertSafe();
    result = { status: 'PASS', editorUrl, input, browserVersion: browser.version(), runtime, references, actualReferences,
        target: { sourceRowZeroBased: 11183581, sampleRowZeroBased: 159, deletedCount: 1,
            undoStats: await stats(), approval: 'HOLD_NOT_APPROVED' } };
} catch (error) {
    errors.push({ message: error.message, stack: error.stack, safetyError: safetyError?.message });
    result = { status: 'BLOCKED', input, browserVersion: browser?.version(), references };
    process.exitCode = 1;
    console.error(error.stack || error.message);
} finally {
    clearInterval(monitor);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    gpuSample();
    fs.writeFileSync(path.join(root, 'browser-experiment.json'), JSON.stringify({
        ...result, steps, errors, consoleLog, network, failed, resources,
        closedAndDiscarded: true, finished: new Date().toISOString()
    }, null, 2));
    console.log(JSON.stringify({ status: result?.status, screenshots: steps.filter(s => s.camera).length,
        errors, evidenceRoot: root }));
}
