import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
let collided = 0;
page.on('console', m => { if (m.text().includes('collision mesh')) collided++; else logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push('PAGEERROR: ' + (e.stack || e.message)));

const vp = JSON.stringify([
  { id: 'vp1', name: 'A', position: { x: 0, y: 1.7, z: 0 }, target: { x: 0, y: 1.5, z: -3 }, fov: 60, orderIndex: 0, enabled: true },
  { id: 'vp2', name: 'B', position: { x: 2, y: 1.7, z: 1 }, target: { x: 0, y: 1, z: 0 }, fov: 60, orderIndex: 1, enabled: true },
  { id: 'vp3', name: 'C', position: { x: -2, y: 1.7, z: 2 }, target: { x: 0, y: 1.2, z: 0 }, fov: 50, orderIndex: 2, enabled: false }, // disabled — must be filtered
]);
const ann = JSON.stringify([
  { id: 'a1', title: 'POI', description: 'A described spot', anchorX: 0.5, anchorY: 1.6, anchorZ: -1, style: 'LEADER_TEXT', contentType: 'TEXT', textContent: 'Hello annotations', textColor: '#FFFFFF', textSize: 14, fov: 60, orderIndex: 0, enabled: true },
]);

const url = new URL('http://localhost:5181/');
url.searchParams.set('url', '/local-scenes/local-garden/scene.sog');
url.searchParams.set('format', 'sog');
url.searchParams.set('id', 'garden');
url.searchParams.set('title', 'Garden');
url.searchParams.set('viewpoints', vp);
url.searchParams.set('annotations', ann);

await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(8000);

const status = await page.textContent('#status-text').catch(() => 'N/A');
const info = await page.textContent('#scene-info').catch(() => 'N/A');

console.log('=== XR Data Pipeline Test ===');
console.log('status:', status);
console.log('scene-info:', info);

// Query the app internals via window? Not exposed. Read DOM info string is enough.
const vpCount = /VPs: (\d+)/.exec(info || '')?.[1] ?? '?';
const annCount = /Annot: (\d+)/.exec(info || '')?.[1] ?? '?';
console.log('viewpoints parsed:', vpCount, '(expect 2, disabled filtered)');
console.log('annotations parsed:', annCount, '(expect 1)');

console.log('--- console logs (non-collision) ---');
for (const l of logs.slice(-20)) console.log('  ' + l.slice(0, 200));

await browser.close();
process.exit(0);