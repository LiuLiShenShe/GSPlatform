# GSPlatform Rollback Runbook

> Phase 09 artifact — how to safely roll an application release back, and what
> rollback does NOT cover (database data).

## 1. Principles

1. **Application rollback** = flip `current` symlink to the previous release and
   restart services. It is fast, reversible, and the normal response to a bad
   release.
2. **Database rollback** is a **separate, deliberate** operation. Application
   rollback does NOT revert schema or data. Only migrate down when the upgrade
   was recently applied and you have a verified plan (see §4).
3. **Never guess** the previous release. The deployment scripts record it in
   `$DEPLOY_ROOT/.previous_release`.
4. Every rollback is recorded (`~/.rollback-*` files) and must be followed by
   post-rollback verification.

## 2. Standard rollback (scripted)

```bash
cd /opt/gsplatform/releases
sudo -u gsplatform ./deploy/scripts/rollback.sh --root /opt/gsplatform
# or pin a specific release:
sudo -u gsplatform ./deploy/scripts/rollback.sh --root /opt/gsplatform --to 20260917-01
```

The script:

1. Reads `DEPLOY_ROOT/.previous_release` (or `--to`).
2. Atomically swaps the `current` symlink.
3. Restarts `gsplatform-api`, `gsplatform-celery-cpu`, `gsplatform-celery-gpu`.
4. Reloads Nginx.
5. Runs `smoke_test.sh` (best effort) and reports PASS/FAIL.

## 3. Manual rollback (if scripts unavailable)

```bash
DEPLOY_ROOT=/opt/gsplatform
ln -sfn $DEPLOY_ROOT/releases/<PREV> $DEPLOY_ROOT/current.pending
mv -Tf $DEPLOY_ROOT/current.pending $DEPLOY_ROOT/current
sudo systemctl restart gsplatform-api gsplatform-celery-cpu gsplatform-celery-gpu
sudo systemctl reload nginx
curl -fsS https://DOMAIN/health/ready
```

## 4. Database rollback (destructive — human decision required)

- **Only schema-extending migrations** (additive) do NOT require a DB rollback;
  the new app works on the old schema. Just roll the app back.
- **Data-mutating or destructive migrations** (column drops, rewrites) require a
  **restore from the pre-deploy backup**, never an ad-hoc `alembic downgrade`:

```bash
# 1. Restore the DB dump taken immediately before the deploy:
./deploy/scripts/restore_drill.sh --backup <pre-deploy-backup-dir> --restore-db gsplatform
# 2. Point the app at the restored DB (GS_DATABASE_URL) and restart.
```

- **RPO/RTO:** the DB restore is time-bounded by your backup cadence + restore
  speed. Measure with `restore_drill.sh`; record results in the Phase 09 report.
- If data loss is unacceptable, **freeze writes** (stop workers) before restoring.

## 5. Post-rollback checklist

```bash
./deploy/scripts/preflight.sh --environment production
curl -fsS https://DOMAIN/health/ready
curl -fsS https://DOMAIN/api/v1/scenes?limit=3
./deploy/scripts/smoke_test.sh --environment production --base-url https://DOMAIN
# + one manual viewer open of a published scene (cold cache).
```

## 6. When to escalate

- Rollback fails (symlink swap, restart, or smoke FAIL) → treat as incident:
  follow `docs/operations/INCIDENT_RUNBOOK.md`.
- Both releases bad → pick the release **before last good**, or restore from
  backup; do not keep toggling.
