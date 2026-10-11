import { chromium } from '../../node_modules/playwright/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const address = process.env.GS_EDITOR_GATE_URL;
const output = process.env.GS_EDITOR_GATE_OUTPUT;
if (!address || !output) throw new Error('GS_EDITOR_GATE_URL and GS_EDITOR_GATE_OUTPUT are required');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan',
    '--use-angle=vulkan', '--use-vulkan=native', '--disable-vulkan-surface'],
});
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
  await context.addInitScript(() => { window.showDirectoryPicker = undefined; });
  let page = await context.newPage();
  page.setDefaultTimeout(30_000);
  if (process.env.GS_EDITOR_GATE_EMAIL) {
    const login = await page.request.post(new URL('/api/v1/auth/login', address).href, {
      data: { email: process.env.GS_EDITOR_GATE_EMAIL, password: process.env.GS_EDITOR_GATE_PASSWORD },
    });
    if (login.status() !== 200) throw new Error(`Real session login failed: ${login.status()}`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await page.request.get(new URL('/api/v1/auth/me', address).href)).status() === 200) break;
      await page.waitForTimeout(150);
    }
  }
  if (process.env.GS_EDITOR_GATE_SCENE) {
    await page.goto(new URL(`/model/edit/${process.env.GS_EDITOR_GATE_SCENE}`, address).href);
    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: '打开 SuperSplat Editor', exact: true }).click();
    page = await popup;
    await page.waitForURL('**/gaussian-editor/?*');
    const source = new URL(page.url()).searchParams.get('load');
    const id = source.match(/edit-sessions\/([^/]+)\//)[1];
    const result = await page.request.get(new URL(`/api/v1/scenes/${process.env.GS_EDITOR_GATE_SCENE}/edit-sessions/${id}`, address).href);
    if (result.status() !== 200) throw new Error('Platform launch session unavailable');
    await writeFile(`${output}/session.json`, JSON.stringify(await result.json(), null, 2));
  }
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  if (!process.env.GS_EDITOR_GATE_SCENE) await page.goto(address);
  if (process.env.GS_EDITOR_GATE_LOD) {
    await page.getByText('Load Options', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('#popup-select').click();
    await page.getByText(new RegExp(`^LOD ${process.env.GS_EDITOR_GATE_LOD} \\(`)).click();
    await page.getByRole('button', { name: 'OK', exact: true }).click();
  }
  await page.waitForFunction(() => Number(document.querySelector('.status-bar-stat-value')?.textContent?.replaceAll(',', '')) > 0,
    null, { timeout: 60_000 });
  await page.waitForTimeout(3000);
  const stats = async () => page.locator('.status-bar-stat-value').evaluateAll(elements =>
    elements.map(element => Number(element.textContent.replaceAll(',', ''))));
  const initial = await stats();
  if (!await page.evaluate(() => isSecureContext && !!navigator.gpu)) throw new Error('WebGPU secure context absent');
  await page.keyboard.press('Shift+f');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${output}/before.png` });
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(800, 500, { steps: 10 });
  await page.mouse.up();
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${output}/navigation.png` });
  if (process.env.GS_EDITOR_GATE_IMPORT_ONLY === '1') {
    const receipt = { status: 'PASS', scope: 'IMPORT_AND_NAVIGATION_ONLY', browser: browser.version(),
      importedCount: initial[0], platformLaunch: !!process.env.GS_EDITOR_GATE_SCENE,
      screenshotVisualReview: 'REQUIRED, not inferred from HTTP/DOM' };
    await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } else {
  await page.keyboard.press('r');
  await page.mouse.move(550, 320);
  await page.mouse.down();
  await page.mouse.move(800, 600, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelectorAll('.status-bar-stat-value')[1]?.textContent?.replaceAll(',', '')) > 0);
  const selected = await stats();
  if (selected[1] >= initial[0]) throw new Error('Must select only part of the scene');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(700);
  const deleted = await stats();
  if (deleted[0] !== initial[0] - selected[1] || deleted[3] !== selected[1]) throw new Error('Delete count mismatch');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);
  const undone = await stats();
  if (undone[0] !== initial[0] || undone[3] !== 0) throw new Error('Undo failed');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(700);
  const redone = await stats();
  if (redone[0] !== deleted[0] || redone[3] !== deleted[3]) throw new Error('Redo failed');
  await page.getByText('File', { exact: true }).click({ force: true });
  await page.getByText('Export', { exact: true }).click({ force: true });
  await page.getByText('PLY (.ply)...', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('PLY (.ply)...', { exact: true }).click({ force: true });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click({ force: true });
  const download = await downloadEvent;
  await download.saveAs(`${output}/edited.ply`);
  const bytes = await readFile(`${output}/edited.ply`);
  const header = bytes.subarray(0, bytes.indexOf('end_header') + 10).toString();
  if (!header.startsWith('ply\n') || !header.includes(`element vertex ${deleted[0]}\n`)) throw new Error('Official export count mismatch');
  if (failures.length) throw new Error(JSON.stringify(failures));
  let sogExport = null;
  if (process.env.GS_EDITOR_GATE_EXPORT_SOG === '1') {
    await page.getByText('File', { exact: true }).click({ force: true });
    await page.locator('#menu').getByText('Export', { exact: true }).click({ force: true });
    await page.getByText('SOG (.sog)...', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('SOG (.sog)...', { exact: true }).click({ force: true });
    const sogDownload = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click({ force: true });
    await (await sogDownload).saveAs(`${output}/edited.sog`);
    const encoded = await readFile(`${output}/edited.sog`);
    sogExport = { bytes: encoded.length, sha256: createHash('sha256').update(encoded).digest('hex') };
  }
  const egressBlocked = await page.evaluate(async () => {
    const violation = new Promise(resolve => {
      window.addEventListener('securitypolicyviolation', event => {
        if (event.effectiveDirective === 'connect-src' && event.blockedURI.startsWith('https://superspl.at')) resolve(true);
      }, { once: true });
      setTimeout(() => resolve(false), 1000);
    });
    try { await fetch('https://superspl.at/gsplatform-egress-probe', { method: 'POST', mode: 'no-cors', body: '' }); }
    catch {}
    return await violation;
  });
  if (!egressBlocked) throw new Error('Third-party publishing egress was not blocked');
  const receipt = { status: 'PASS', browser: browser.version(), initial, selected, deleted, undone, redone,
    exportedCount: deleted[0], exportedBytes: bytes.length, exportSha256: createHash('sha256').update(bytes).digest('hex'),
    fileSystemAccessDisabledForDownloadFallback: true, thirdPartyEgressBlocked: egressBlocked,
    selectedLod: process.env.GS_EDITOR_GATE_LOD ?? null,
    platformLaunch: !!process.env.GS_EDITOR_GATE_SCENE,
    sogExport,
    screenshotVisualReview: 'REQUIRED, not inferred from HTTP/DOM' };
  await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  }
} finally {
  await browser.close();
}
