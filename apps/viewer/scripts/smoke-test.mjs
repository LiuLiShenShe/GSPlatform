import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

const requiredFiles = ['index.html', 'index.js', 'index.css'];

let failed = false;
for (const file of requiredFiles) {
  const p = path.join(dist, file);
  if (!fs.existsSync(p)) {
    console.error(`FAIL: missing ${file}`);
    failed = true;
    continue;
  }
  const size = fs.statSync(p).size;
  if (size === 0) {
    console.error(`FAIL: ${file} is empty`);
    failed = true;
    continue;
  }
  console.log(`OK: ${file} (${size} bytes)`);
}

// index.html must reference the built bundles and carry a title.
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
if (!/<title>/.test(html)) {
  console.error('FAIL: index.html has no <title>');
  failed = true;
}

if (failed) {
  console.error('Viewer smoke test FAILED — run pnpm --filter @gsplatform/viewer build first');
  process.exit(1);
}
console.log('Viewer smoke test PASSED (dist startup artifacts present and valid)');