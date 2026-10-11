# Self-hosted official SuperSplat Editor

## Boundary and release pin

Deploy the official MIT application separately under the **same HTTPS origin** at
`/gaussian-editor/`. Do not bundle it into React or activate `apps/viewer`.
`apps/editor/editor-version.json` is the approved immutable pin. Official source,
package-lock and MIT hashes are verified; floating `main` is never a build input.
Node >=20.19.0 is required; acceptance uses Node24.16.0/npm11.13.0.
The official `BASE_HREF` build option supports the subpath without source patches.

```bash
./apps/editor/editor.sh build --cache /srv/gsplatform/editor/candidate
./apps/editor/editor.sh verify --cache /srv/gsplatform/editor/candidate
./apps/editor/editor.sh start --cache /srv/gsplatform/editor/candidate
./apps/editor/editor.sh health
./apps/editor/editor.sh stop
```

These commands manage only the independent loopback static server. They do not
restart GSPlatform services or migrate any database. There is no existing platform
one-click launcher to extend. Preserve `dist/LICENSE`, `UPSTREAM.txt`,
`dependency-licenses.json`, `licenses/`, `checksums.sha256` and `editor-build.json`
with each artifact. Do not commit source clones, node_modules, assets or caches.
HTTP health checks HTML/JS/CSS/WASM/receipt/license only, not editing functionality.

## HTTPS reverse proxy

Insert this into the **existing** HTTPS server block; do not replace its API,
Viewer, private asset internal locations, upload bounds or existing authentication.

```nginx
location = /gaussian-editor { return 308 /gaussian-editor/; }
location ^~ /gaussian-editor/ {
    proxy_pass http://127.0.0.1:18031;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    add_header Referrer-Policy no-referrer always;
}
location = /api/id { return 404; }
```

The static server emits enforced CSP and nosniff/COOP headers. Do not strip them.
Never proxy `/api/id` to superspl.at; the official Publish UI uses that endpoint
to acquire a hosted publishing identity. Never install a hosted publishing token.
The existing `/api/v1/` routes remain platform-owned. HTTPS is mandatory outside
loopback. Verify all URLs and subpath JS/CSS/locales/WebP WASM in a real browser.

## Authentication and privacy

Editor fetches a server-generated owner/session/version-bound **same-origin** source
URL through `?load=`. Encode the URL using URLSearchParams, not string interpolation.
There is no JWT/bearer/download token in the URL. The existing HttpOnly login cookie
is attached to same-origin fetches; session ID is a locator, not an access credential.
Private download still requires owner identity, active edit session and pinned
SceneVersion. Each relative SOG chunk must stay within the same authorized prefix.
Source responses must use `private, no-store`, including X-Accel handoff; Range
and Content-Type remain the existing asset service's responsibility.
No CORS credential sharing is needed or enabled. Do not redirect source downloads
to external storage or accept arbitrary remote URL parameters. A third-party origin
must not become an authenticated data proxy. CSRF applies to all mutation requests.

Enforced `connect-src 'self' blob:` blocks third-party fetch/WebSocket publishing;
other CSP directives restrict scripts, images, media, forms and frames. This is a
deployment policy, not an upstream UI modification. The hosted **Publish** menu is
still visible: explain that it is not GSPlatform publication and is unavailable in
this deployment. Users can always manually move files outside the platform; CSP is
not DRM. If a proxy removes CSP or enables hosted identity, private-data launch must
stay disabled until reviewed. No DOM/CSS hack is used to pretend Publish is disabled.
CSP deliberately blocks the upstream inline origin-wide service-worker cleanup
script; the resulting console warning is expected, rather than affecting other
applications' service workers on the shared origin.

## Sources and export

Only trust persisted, validated SceneVersion assets; an old upload history entry
does not prove that its original PLY still exists. Streamed SOG import at this pin
prompts for **one LOD**, defaults to the coarsest LOD, and shows its Gaussian count.
It does not load all LODs into one editable full-resolution project. Disclose the
selected/declared LOD and exported count; never label an arbitrary LOD as the original
full-resolution source. Large scenes need explicit browser memory checks before
load; the production 13M scene must not be edited for acceptance.

Use official **File → Export → PLY** (or verified SOG), save locally, then return to
GSPlatform to submit. No automatic save or private Editor API is assumed.
`.ssproj` is an editing project ZIP, not a PLY/SOG or publishable Streamed SOG.
Editor changes alone do not mutate platform assets or SceneVersion.

## Deployment order and rollback

1. Check/backup the target DB; verify isolated upgrade/current=head first.
2. Explicitly approved production migration (never performed by build/start).
3. Deploy compatible API/worker code with Editor launch disabled.
4. Deploy verified Editor artifact and HTTPS route/CSP.
5. Deploy Web; configure the exact artifact receipt and enable only after gates.
6. Verify real login/CSRF/private cookie load, editing/export, same-scene immutable
   publication and official Viewer; test unauthorized access and conflicting bases.

Rollback: disable new Editor sessions/launch, retain audit and immutable versions,
stop or revert the independent Editor artifact, then roll back compatible code.
Do not delete historical assets, alter old SceneVersion hashes or repoint current
outside the existing publication transaction. Quarantined exports are private and
retained for `GS_EDITOR_EXPORT_RETENTION_DAYS` (default 7 days after session expiry)
for diagnosis/recovery. The existing scheduled cleanup task handles only terminal,
non-running edit exports, never published version directories or audit records.
Never downgrade a migration containing live edit audits merely to roll back UI.
Keep the P3-aware API/runtime/worker while linked edit uploads or STALE edited
scenes exist; a pre-P3 binary does not understand their publication/spatial guards.
Disable launch and revert the independent artifact first, then drain/cancel jobs
and use an explicitly reviewed compatible code rollback.

## Acceptance status

## API configuration and workflow

Set `GS_EDITOR_ENABLED=true` only after the independently served artifact is
verified, and `GS_EDITOR_BUILD_MANIFEST=/absolute/path/to/dist/editor-build.json`.
Defaults are a 4-hour edit session (`GS_EDITOR_SESSION_HOURS`), a 5-million Gaussian
browser admission cap (`GS_EDITOR_MAX_GAUSSIANS`) and disabled Editor launch.
Source transfer rejects a changed build identity instead of silently reopening an
older session in a different deployment. Use real session cookies; the editor
service rejects development identity even when the legacy dev flag is enabled.
Production must also use `GS_ENV=production`, `GS_DEV_IDENTITY_ENABLED=false`,
`GS_SESSION_SECURE_COOKIE=true` and the existing production CSRF/TLS guards.

Owner APIs:

- `GET /api/v1/scenes/{slug}/edit-source`: trusted current version, format, counts,
  memory limit, feature status and spatial binding validity. No file URL from users.
- `POST /api/v1/scenes/{slug}/edit-sessions`: JSON `expectedCurrentVersion`, optional
  `selectedLod`, `acknowledgeLodSource`, `acknowledgeBrowserMemory`.
- `GET /api/v1/scenes/{slug}/edit-sessions/{id}`: authoritative status/progress,
  immutable source, build, expiry and result version/counts.
- `POST /api/v1/scenes/{slug}/edit-sessions/{id}/uploads`: filename, `format` PLY/SOG,
  size, SHA256 and selected LOD acknowledgement; creates one linked existing-protocol
  upload. Never calls the ordinary create-new-Scene branch.
- Reuse `HEAD`/`PATCH /api/v1/uploads/{uploadId}` and `Upload-Offset`; submit via
  `POST .../edit-sessions/{id}/complete` or the existing complete endpoint, both
  enforce the same edit contract. Mutations require `X-CSRF-Token`.
- `POST .../edit-sessions/{id}/cancel`: idempotent cancellation, current unchanged.

Uploaded is not published. Poll the edit session until COMPLETED/FAILED/CANCELLED/
EXPIRED. Conversion uses unchanged platform SplatTransform 3.3.3/Phase 2 recipes.
Completion is idempotent; final Scene-row lock and source-version CAS prevent stale
results overriding newer versions. `409 EDIT_BASE_VERSION_CHANGED` means retain
the local export and explicitly resolve/reopen against the new version; there is
no force-save API. Valid late conflicts are privately quarantined until retention
cleanup, and cancelled running work cannot move the current pointer.

Ordinary uncompressed official PLY export is preferred. Do not enable Compress PLY;
submit rejects other PLY layouts, malformed/oversized headers, wrong properties,
count and exact-byte mismatches. SOG is a checked bundled ZIP with bounded v2
metadata/count before CLI decoding (the actual locked Editor export format), no
duplicate members, and existing archive safety. Streamed ZIP is not an Editor
export contract. `.ssproj`
is never accepted. SHA, size, archive traversal/symlinks/bombs and immutable output
checks still use existing upload/validator/adapter primitives. The browser computes
SHA before upload and caps that in-memory submission at 1 GiB; the server's existing
upload size bounds are still authoritative. If refresh occurs, reselect the same
file; the session locator (not credentials) is stored locally and the same protocol
resumes from the server offset. Closing the Editor alone does not cancel/save.

Geometric editing sets spatial bindings STALE and collision policy MANUAL_ONLY.
Historical camera/world/viewpoint/annotation records and calibration evidence are
not deleted or guessed into a new coordinate frame. Runtime omits stale geometric
presentation/bindings; calibration and collision keep their existing version checks.
There is no automatic spatial revalidation/migration UI in this phase.

For development use `VITE_API_BASE_URL=/api/v1`, optional `GS_API_PROXY_TARGET` for
the isolated API and `GS_EDITOR_PROXY_TARGET` for the independent static server.
This keeps browser fetches truly same-origin; defaults preserve existing API proxy
behavior. Do not point the private flow to an authenticated cross-origin subdomain.

## Reproducible gates

`./deploy/scripts/verify_editor_source.sh` archives tracked HEAD, builds the pinned
official source with its lockfile in an isolated directory, verifies license/
artifact checksums, starts on loopback 18131, tests static resources, and stops only
that process. For an already verified official Git clone, set
`GS_EDITOR_UPSTREAM_CLONE=/path/to/official/supersplat`; SHA/clean tree/lock/license
checks still apply. `GS_EDITOR_GATE_KEEP=1` preserves evidence, not Git artifacts.

Install the existing workspace lockfile and run `node apps/editor/browser-gate.mjs`
with `GS_EDITOR_GATE_URL`, `GS_EDITOR_GATE_OUTPUT` and real test login email/password
environment variables. `GS_EDITOR_GATE_SCENE` exercises the platform launch button;
otherwise supply the controlled Editor URL. `GS_EDITOR_GATE_LOD=1` selects the
declared LOD in the official visible picker. `GS_EDITOR_GATE_EXPORT_SOG=1` also
exports SOG. `GS_EDITOR_GATE_IMPORT_ONLY=1` explicitly limits acceptance to import/
navigation (it cannot substitute for the full selection/delete/undo/export gate).
The Linux test uses real Chromium/Vulkan WebGPU, not a Mock Editor, and disables
the public File System Access picker only to exercise official browser-download
fallback. Inspect screenshots separately; numerical DOM status is not a visual
rendering assertion.

Run `apps/web/e2e/pc-integration03-editor.spec.ts` with a dedicated isolated API/
PostgreSQL/worker, `PC03_E2E=1`, `PC03_BASE_URL`, `PC03_SCENE`, `PC03_SESSION`, real
`PC03_EMAIL`/`PC03_PASSWORD`, `PC03_EXPORT`, `PC03_EVIDENCE`, and optional `PC03_LOD`.
The export must be the actual preceding official Editor output, not the original
file. Never share the acceptance DB with legacy unit-test recovery fixtures:
some intentionally schedule collision work globally. Regression tests use their
own isolated DB; production and the 13M Scene are not test targets.

See `docs/reports/PC_INTEGRATION_03_EDITOR.md` for actual gates, failures and remaining
limitations. A successful build or HTTP200 is not a substitute for WebGPU rendering,
actual Gaussian edits, genuine export and version-safe publication evidence.
