# GSPlatform Deployment Runbook

> Phase 09 artifact — production deployment of GSPlatform on Ubuntu + Nginx + HTTPS.
> FIX-01 (2026-09-29): scene bytes are no longer delivered from a public static
> alias.  The browser fetches `/api/v1/scenes/<slug>/assets/<rel>`; FastAPI
> authorizes via the unified SceneAccessPolicy and Nginx serves the file from
> the internal `/_scene-origin/` location (X-Accel-Redirect).  There is no
> unauthenticated scene path.

## 1. Topology

```text
Internet ── 443/80 ──► Nginx (Ubuntu host)
                         ├── /                  → /opt/gsplatform/current/apps/web/dist (SPA)
                         ├── /api/              → FastAPI 127.0.0.1:8001
                         │       └── /api/v1/scenes/<slug>/assets/<rel>
                         │            → policy check → X-Accel-Redirect ↓
                         ├── /_scene-origin/    → /srv/gsplatform-data/scene-origin (internal; Range)
                         └── /health/{live,ready}
FastAPI ──► PostgreSQL (127.0.0.1) · Redis (127.0.0.1) · Celery workers (CPU/GPU)
```

## 2. Host preparation (Ubuntu)

Run as root or via sudo on the fresh Ubuntu 24.04 host:

```bash
# 1. Base packages
# postgresql-client provides `pg_isready` (host preflight probe, FIX-06.2 §16);
# redis-tools provides `redis-cli` (Redis host probe, FIX-06.2 §17).
apt update && apt upgrade -y
apt install -y nginx postgresql postgresql-client redis-server redis-tools \
    python3-venv python3-pip ffmpeg curl zstd openssl

# 2. Runtime accounts (non-root)
useradd --system --home /opt/gsplatform --shell /usr/sbin/nologin gsplatform
useradd --system --home /srv/gsplatform-data --shell /usr/sbin/nologin gsplatform-worker || true

# 3. Directory skeleton
mkdir -p /opt/gsplatform/releases /opt/gsplatform/shared
mkdir -p /srv/gsplatform-data/{staging,quarantine,published,jobs,logs,backups-local-buffer}
mkdir -p /srv/gsplatform-data/scene-origin
chown -R gsplatform:gsplatform /opt/gsplatform /srv/gsplatform-data
chmod 700 /srv/gsplatform-data/scene-origin

# 4. PostgreSQL app role (least privilege)
sudo -u postgres psql <<'SQL'
CREATE ROLE gsplatform LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE gsplatform OWNER gsplatform;
SQL

# 5. Secrets
mkdir -p /etc/gsplatform
install -m 600 /dev/null /etc/gsplatform/env      # fill from deploy/env/production.env.example
install -m 600 /dev/null /etc/gsplatform/backup.key  # openssl rand -base64 32

# 6. TLS (Let's Encrypt; replace DOMAIN)
apt install -y certbot python3-certbot-nginx
certbot certonly --standalone -d DOMAIN -d www.DOMAIN --email ops@DOMAIN --agree-tos
systemctl enable --now certbot.timer   # auto-renew; verifiable via --dry-run
```

## 3. Install the deploy assets

```bash
# From the release you just built (see deploy_release.sh), copy configs:
# NOTE: include-fragments (proxy-params, scenes-streaming) live in their own
# dir /etc/nginx/gsplatform — they are meant to be *included* by
# gsplatform.conf, NOT auto-loaded as standalone configs (nginx would parse
# them at http level and fail with "duplicate directive").
sudo mkdir -p /etc/nginx/gsplatform
sudo cp deploy/nginx/gsplatform.conf            /etc/nginx/conf.d/gsplatform.conf
sudo cp deploy/nginx/scenes-streaming.conf      /etc/nginx/gsplatform/scenes-streaming.conf
sudo cp deploy/nginx/proxy-params.conf          /etc/nginx/gsplatform/proxy-params.conf
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl reload nginx
```

**Edit `gsplatform.conf` before copying:** replace the 4 `<DOMAIN>` placeholders
with the real domain.

## 4. First deploy

The preflight is split (FIX-06.2 §13-§21): `--mode host` validates the FRESH
host (commands, filesystem/disk, env file, PostgreSQL/Redis reachability, the
production rate-limiter config gate, NVIDIA runtime) **before any release
exists**; `--mode release` validates the INSTALLED release (current symlink +
metadata, web dist, storage package, venv imports, celery, systemd ExecStart,
torch/gsplat/CUDA, alembic current==head, nginx).  Default mode is `host` —
legacy calls without `--mode` stay on the host contract.

```bash
cd /opt/gsplatform/releases
# pull the repo, then:
# 1. HOST readiness (no release exists yet — this MUST pass first)
sudo -u gsplatform ./deploy/scripts/preflight.sh --environment production --mode host
# 2. Deploy (builds the web SPA + venv, switches /opt/gsplatform/current,
#    then runs `preflight.sh --mode release` internally as a post-switch gate;
#    a release-preflight failure rolls the symlink back and aborts)
sudo -u gsplatform ./deploy/scripts/deploy_release.sh \
    --release $(date +%Y%m%d-%H%M) --environment production
# 3. Manual release re-check (optional but recommended after the first deploy)
sudo -u gsplatform ./deploy/scripts/preflight.sh --environment production --mode release
```

`deploy_release.sh` builds the web SPA with `VITE_API_BASE_URL=/api/v1` so all
browser calls are same-origin through Nginx (no CORS traffic in production).

**Environment file (FIX-06.2 §24/§25):** preflight, deploy_release.sh and the
systemd units share one source: `$GS_ENV_FILE` (default `/etc/gsplatform/env`,
the file created in §2 step 5).  Scripts load it with a safe parser — no `source`
of arbitrary paths, no shell expansion (`$` in passwords survives verbatim),
secrets never printed.  systemd `EnvironmentFile=` does **not** shell-expand,
and the celery broker/backend are consumed via the application Settings — set
`GS_CELERY_BROKER_URL` / `GS_CELERY_RESULT_BACKEND` directly in the file; the
`CELERY_BROKER_URL=${...}` lines in `production.env.example` are documentation
only.

## 5. Post-deploy verification

```bash
curl -fsS https://DOMAIN/health/live
curl -fsS https://DOMAIN/health/ready
curl -I  https://DOMAIN/
# FIX-01: authorized asset path (public scene).  `/_scene-origin/...` is
# internal — a direct curl there must 404.
curl -i  -H "Range: bytes=0-1023" \
     https://DOMAIN/api/v1/scenes/<published-slug>/assets/current/lod-meta.json   # expect 206
curl -i  -H "Range: bytes=999999999999-" \
     https://DOMAIN/api/v1/scenes/<published-slug>/assets/current/lod-meta.json   # expect 416
curl -o /dev/null -s -w '%{http_code}\n' \
     https://DOMAIN/_scene-origin/<published-slug>/current/lod-meta.json          # expect 404 (internal)
./deploy/scripts/smoke_test.sh --environment production --base-url https://DOMAIN \
    --public-scene <slug>
```

`--public-scene <slug>` (FIX-06.2 §26) makes the smoke's asset section exercise
the REAL FastAPI GET path (Viewer GET → policy authorization → X-Accel-Redirect
→ Nginx internal file → Range/206/416 headers).  The asset API is GET-only, so
the smoke uses one real GET per asset (`-D` headers + `-o` body + `-w` code) and
never HEAD.  The scene must be **PUBLIC + PUBLISHED + not-deleted** and have a
**current** version (a published scene always has one).

`deploy_release.sh` resolves and auto-passes `--public-scene` (see its header):
explicit `SMOKE_PUBLIC_SCENE_SLUG` above the deterministic DB query
(`visibility=PUBLIC AND status=PUBLISHED AND deleted_at IS NULL` with a current
version); a release deploy runs the smoke automatically and a missing public
scene fails the deploy rather than silently skipping the asset checks.

**TLS（FIX-06.2.1 §C/§16-§23）：** production smoke 默认严格验证**真实 TLS
证书链与主机名**（不含 `-k` / `--insecure`）。证书过期 / 主机名不匹配 / 未知 CA /
证书链断裂 → curl 非零 → smoke FAIL，绝不吞掉。`--insecure` 是**仅限 staging/local
的显式诊断选项**（自签/临时证书）；生产环境直接拒绝
（`--insecure + production` → 脚本 exit 1）。生产命令不带 `--insecure`；内部私有
CA 场景走系统 CA trust（本任务不实现私有 CA 管理）。staging 自签可按需追加
`--insecure`（deploy_release 亦支持 `SMOKE_INSECURE=1` 显式传入 staging smoke）。

## 6. Backups & maintenance

- Daily DB + published-assets backup: `deploy/scripts/backup.sh --environment production`
  (schedule via `cron` or a systemd timer on the host; retention = `BACKUP_KEEP_N` days).
- Periodic isolated restore rehearsal: `deploy/scripts/restore_drill.sh`.
- Cleanup timer is shipped as `gsplatform-cleanup.timer` (every 6h, randomized delay).

## 7. Monitoring hooks

- External probes: `/health/live`, `/health/ready`, and one public scene manifest URL.
- Alert sources and thresholds: see `docs/operations/INCIDENT_RUNBOOK.md` §1.
- Log locations: `/var/log/nginx/gsplatform.*.log`, `journalctl -u gsplatform-*`.

## 8. Firewall (UFW example)

```bash
ufw allow 22/tcp          # from management IPs only
ufw allow 80/tcp          # ACME
ufw allow 443/tcp
ufw default deny incoming
ufw enable
# PostgreSQL (5432) and Redis (6379) are NOT opened — private interface only.
```
