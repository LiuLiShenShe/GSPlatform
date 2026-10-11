# Independent official SuperSplat Editor

This is deployment tooling, not an Editor fork or React bundle. Build the immutable
pin, verify notices/hashes, start and stop only the loopback static server:

```bash
./apps/editor/editor.sh build
./apps/editor/editor.sh verify
./apps/editor/editor.sh start
./apps/editor/editor.sh health
./apps/editor/editor.sh stop
```

Node >=20.19.0. Cache/runtime are ignored. A verified offline official Git clone may
be supplied with `--local-source`; commit, tracked tree, license and lockfile are
still checked. Use a fresh `--cache` to preserve previous artifacts. `BASE_HREF`
is official; no upstream source modification. Each release retains upstream/MIT,
dependency notices, timestamp, Node/npm versions, individual hashes and identity.

HTTP health does not claim functional WebGPU acceptance. Hosted Publish remains
visible but is not GSPlatform publication: enforced same-origin CSP blocks external
network/form/frame activity; do not configure `/api/id`. `.ssproj` is an editable
project, not a publishing Gaussian asset. Export PLY/SOG locally and return to
GSPlatform to upload. No private Editor API or auto-save integration is used.

See `docs/operations/SUPERSPLAT_EDITOR_DEPLOYMENT.md` and the Phase 3 report.

Clean tracked-source build/start/static gate: `./deploy/scripts/verify_editor_source.sh`.
The separate real-browser gate is `node apps/editor/browser-gate.mjs`; required
environment and the actual-export-to-Viewer test are documented in the runbook.
