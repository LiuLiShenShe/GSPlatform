# VR-01B evidence

Collected on 2026-10-12. Source fidelity evidence uses `70f77075f5285e2e23a3e167fa0ff42a0b8a2623`; final deployed application and closure gates use `fa4ef0b420e17e69792df8a3636b41246480df8b` (legacy SOG container validation only, no renderer or output change).

- `original.png`, `old-lod0.png`, `old-lod2.png`, `regular.png`, `comparison-grid.png`: real pinned official Viewer, identical camera/settings; not generated illustrations. `regular.png` reads the currently published asset. `comparison.json`, `pixel-comparison.json` provide the machine-verifiable settings and errors.
- `desktop.png`, `formal-xr.png`: anonymous database-backed current regular SOG. `live-browser.json` records sustained frame counts, authoritative URLs and actual renderer.
- `prebuilt-zip-xr.png`, `prebuilt-browser.json`: validated legacy streamed archive uploaded through the normal API and loaded through the formal XR route; original historical files remain immutable.
- `editor-regular-import.png`, `editor-published.png`, `editor-roundtrip.json`: unmodified official Editor import/export and authenticated private publication. No passwords, Cookie or CSRF tokens are included.
- `fidelity-stats.json`, `published-fidelity-errors.json`, `color-outliers.json`: raw/official-decoded statistics, unique geometric matching and low-opacity quantization limitations.
- `manifest-regular.json`, `build-info-regular.json`, `checksums-regular.txt`: actual immutable published metadata, without the SOG binary itself.
- `published-encoding-comparison.json`: probe and published ZIP differ in timestamps, not the six internal encoded resources.
- `closure.json`, `current-upgrade.json`, `live-upload.json`, `live-prebuilt.json`: isolated environment identities, legitimate publication responses, true anonymous statuses and unchanged historical hashes. These are limited test evidence, not a database dump.
- `red-workers.txt`, `red-api.txt`, `red-publication-runtime.json`: actual baseline failures; the standalone baseline PostgreSQL publication transaction was rolled back.
- `real-streamed-cli.json`, `real-streamed-info.txt`: real four-level CLI fixture and strict validation. It is not a production-threshold override or a claimed million-point source test.
- `legacy-sog-red.txt`, `legacy-sog-green.txt`: actual legacy V1 rejection followed by pinned CLI decode and byte-identical passthrough success; `workers-closure.txt` includes that additional regression (153 tests).
- `backend-green.txt`, `workers-last.txt`, `web-summary.txt`, `playwright-final.txt`, `clean-final.txt`, `clean-final-exit.txt`: actual final gates; clean-archive SKIPs are distinguished in the report from the installed environment's no-SKIP real runs.
- `backend-closure.txt`, `workers-closure.txt`, `playwright-closure.txt`, `clean-closure.txt`, `clean-closure-exit.txt`: final application-commit gates after the legacy fix; the default release-source script does not include Web. `clean-web-closure.txt` and `clean-web-exit.txt` separately verify fresh archived Web install/typecheck/lint/tests/build.

Image interpretation used Agnes API. Quantitative pixel/count/hash evidence takes precedence over subjective image descriptions. No trained PLY, SOG asset, credentials, sensitive runtime configuration, DB backup or `node_modules` is committed.

Copied text logs normalize trailing whitespace only; original raw logs remain in the local evidence directory. Test outputs, values and exit codes are unchanged.
