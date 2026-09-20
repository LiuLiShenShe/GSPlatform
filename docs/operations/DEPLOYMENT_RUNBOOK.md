# GSPlatform Deployment Runbook

> Phase 09 artifact — production deployment of GSPlatform on Ubuntu + Nginx + HTTPS.

## 1. Topology

```text
Internet ── 443/80 ──► Nginx (Ubuntu host)
                         ├── /                  → /opt/gsplatform/current/apps/web/dist (SPA)
                         ├── /api/              → FastAPI 127.0.0.1:8001
                         ├── /health/{live,ready}
                         └── /local-scenes/     → /srv/gsplatform-data/scene-origin (Streamed SOG, Range)
FastAPI ──► PostgreSQL (127.0.0.1) · Redis (127.0.0.1) · Celery workers (CPU/GPU)
```

## 2. Host preparation (Ubuntu)

Run as root or via sudo on the fresh Ubuntu 24.04 host:

```bash
# 1. Base packages
apt update && apt upgrade -y
apt install -y nginx postgresql redis-server python3-venv python3-pip \
    ffmpeg curl zstd openssl

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

```bash
cd /opt/gsplatform/releases
# pull the repo, then:
sudo -u gsplatform ./deploy/scripts/preflight.sh --environment production
sudo -u gsplatform ./deploy/scripts/deploy_release.sh \
    --release $(date +%Y%m%d-%H%M) --environment production
```

`deploy_release.sh` builds the web SPA with `VITE_API_BASE_URL=/api/v1` so all
browser calls are same-origin through Nginx (no CORS traffic in production).

## 5. Post-deploy verification

```bash
curl -fsS https://DOMAIN/health/live
curl -fsS https://DOMAIN/health/ready
curl -I  https://DOMAIN/
curl -i  -H "Range: bytes=0-1023" \
     https://DOMAIN/local-scenes/<published-slug>/current/lod-meta.json   # expect 206
curl -i  -H "Range: bytes=999999999999-" \
     https://DOMAIN/local-scenes/<published-slug>/current/lod-meta.json   # expect 416
./deploy/scripts/smoke_test.sh --environment production --base-url https://DOMAIN
```

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
