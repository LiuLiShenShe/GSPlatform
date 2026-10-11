# VR-00 isolated deployment startup

## Scope and prerequisites

This is the **2026-10-11 ISOLATED_STAGING acceptance deployment**, not a replacement
for the production systemd units. `/opt/gsplatform/current` is absent. The original
development APIs, workers, PostgreSQL, Redis, Editor and stale tunnel are not owned
by this launcher and are never stopped by it.

The provisioned, mode-600 environment file is outside Git:
`/home/test/.local/state/gsplatform-vr00-20261011/runtime.env`.
Override its location with `GS_VR00_ENV_FILE`; do not copy credentials into this
document. It identifies the dedicated database role/database, storage, scene
origin, Redis container/broker, HTTPS test origin and smoke-scene slug. Isolation
is checked against the adjacent `isolation.json` before startup.

Requirements: Linux `/proc` and system Python with pidfd support, the installed
API virtualenv and locked pnpm dependencies, Docker, `setsid`, `flock`, curl,
cloudflared when explicitly enabled, and the already verified official Editor.
The pinned Editor's existing independent service on 18031 is reused; if absent,
verify and start it with `./apps/editor/editor.sh verify` and
`./apps/editor/editor.sh start`, then rerun the platform launcher.

The dedicated Redis container `gsplatform-vr00-redis-20261011` uses loopback
16384, AOF and a persistent volume. Its restart policy is `unless-stopped`.
`docker start gsplatform-vr00-redis-20261011` is the recovery command if it has
been stopped. The launcher never starts/stops shared infrastructure or creates
databases, migrates schemas, deletes uploads, re-converts assets or builds collision.

## Commands

```bash
cd /fj/GSPlatform
./scripts/gsplatform-vr.sh up
./scripts/gsplatform-vr.sh status
./scripts/gsplatform-vr.sh urls
./scripts/gsplatform-vr.sh logs
./scripts/gsplatform-vr.sh down
```

`up` is serialized with a lifecycle lock, refuses competing consumers on its
dedicated broker and occupied unmanaged ports, and retains already managed
processes. It requires the repository Alembic head, real authentication and Secure
cookies. It detaches processes into separate sessions and records PID start time,
UID and executable device/inode identity; the command digest is audit metadata,
not the identity of processes such as Vite that change their own title. Shutdown
validates those receipts and uses pidfd signalling,
not a numeric-PID kill susceptible to reuse. Only SIGTERM is sent. Workers with
active/reserved work, or unavailable inspection, prevent shutdown; a slow drain
is reported rather than force-killed. Repeated `down` is safe.

The existing official Editor is borrowed, not stopped. PostgreSQL and both shared
and dedicated Redis are left running. The launcher stops only its own API, Vite,
Nginx container client, publish/CPU/optional GPU worker, Beat and optional tunnel.

## Topology

| Component | Actual endpoint / identity |
| --- | --- |
| Local entry | `http://localhost:5174` |
| Nginx staging proxy | loopback 5174; dedicated `gsplatform-vr00-nginx-20261011` container |
| Vite | loopback 5175; `VITE_API_BASE_URL=/api/v1` |
| API | loopback 18001; `GS_ENV=production`, identity bypass false |
| Official Editor | existing loopback 18031; same-origin `/gaussian-editor/` |
| PostgreSQL | `gsplatform_vr00_20261011`, restricted dedicated role; server 5432 |
| Broker / results / rate limiter | dedicated Redis 16384, databases 0 / 1 / 2 |
| Publish / maintenance | queue `gsplatform`, `vr00-publish@…` |
| Collision / CPU reconstruction | queue `cpu`, `vr00-cpu@…` |
| Optional GPU reconstruction | queue `gpu`, `vr00-gpu@…` when enabled |
| Scheduled recovery | one Beat instance; existing cleanup/recovery task every six hours |

The staging Nginx template is `deploy/nginx/vr00-staging.conf`; the rendered copy
is in the private state directory. This is necessary because the production-mode
API returns authorized `X-Accel-Redirect` responses, which a Vite proxy alone
cannot materialize. `/_scene-origin/` is internal, files are mounted read-only in
Nginx, and API authorization/cache policy remains authoritative. No public alias
to staging, source PLY or private published storage is installed. Shared production
Nginx configuration and certificates are not changed.

API, Web, proxy, publish, CPU, GPU, Beat and tunnel logs have separate files under
the private `logs/` directory. API/Nginx access logging is disabled so auth/share
capabilities are not copied into access logs. Cookie and test-account files are
mode 600 outside Git.

## HTTPS and PICO preparation

`GS_VR00_TUNNEL_ENABLED=true` explicitly enables **one managed Quick Tunnel to
5174**. It is not a production domain. The old tunnel to 5173 is unrelated and
was already unavailable. Repeated `up` retains the managed tunnel. A genuine
`down` followed by `up` creates a new random hostname: read the newest successful
hostname in `logs/tunnel.log`, verify HTTPS, and update `GS_VR00_HTTPS_URL` in the
private environment file before distributing `urls`. No tunnel token is required.

Do not use the backend's loopback URL on a headset. Login, API, authorized chunks
and Editor all use the HTTPS origin and `/api/v1` relative paths. Session cookies
are HttpOnly/Secure/SameSite=Lax; CSRF cookies are Secure/SameSite=Lax and mutations
require the matching header. `/api/id` returns 404 and the Editor's self-only CSP
must remain intact.

For the next, separately approved VR-01 hardware session, log in with the isolated
owner account recorded in the private `test-accounts.json`, visit `/works`,
`/xr/test`, then the actual `/xr/<slug>` printed by `urls`. Record PICO model,
browser version, secure-context/XR diagnostics and entry/exit behavior. Desktop
browser automation is software evidence only, not binocular/6DoF/controller
acceptance. Do not request collision or large-scene re-conversion for this check.

## Validation and limitations

Lifecycle tests are in `apps/api/tests/test_vr00_startup.py`, with actual repeated
up/down and idle-worker inspection recorded in the deployment report. Authentication
regression tests also ensure session persistence precedes cookie responses.

Backend/worker/clean-checkout gates use separately provisioned databases and
storage, never the shared `gsplatform` database. Source snapshots and pre-migration
backups remain under the private acceptance state directory. Existing worktree
document deletions and the user-supplied master plan are not part of VR-00 commits.

This minimal deployment is not supervised production systemd, has no permanent
domain or boot ordering for its application processes, and Quick Tunnel is not
qualified for the 13M scene's request concurrency or PICO performance. Review
`docs/reports/VR_00_DEPLOYMENT_BASELINE.md` before starting VR-01.
