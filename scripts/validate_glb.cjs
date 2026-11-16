// Official Khronos validator, no ignored issues or downgraded severities.
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const requireWeb = createRequire(path.resolve(__dirname, '../apps/web/package.json'));
const validator = requireWeb('gltf-validator');
(async () => {
  const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(process.argv[2])), { maxIssues: 1000, externalResourceFunction: () => Promise.reject(new Error('External resources forbidden')) });
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  if (report.issues.numErrors) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
