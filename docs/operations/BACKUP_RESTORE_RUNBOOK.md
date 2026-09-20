# GSPlatform Backup & Restore Runbook

> Phase 09 artifact — automated backup, isolated restore rehearsal, RPO/RTO.

## 1. Data & backup scope

| Item | Include? | Why |
|---|---|---|
| PostgreSQL (`gsplatform` DB: users, scenes, versions, assets, jobs, sessions) | ✅ | business truth |
| Published scene assets (`published/`) | ✅ | user content; cannot be regenerated |
| Scene-origin symlink tree (`scene-origin/`) | rebuildable | recreated by deploy_release.sh step 7 |
| Uploads staging/quarantine | ❌ (clean) | transient; quarantine is retained until TTL |
| Jobs outputs / logs | ❌ | rebuildable; logs shipped to central collector |
| Config `/etc/gsplatform` | ✅ | small, secrets redacted when snapshotting |

## 2. Automated backup (`deploy/scripts/backup.sh`)

```bash
# Production
sudo -u gsplatform ./deploy/scripts/backup.sh --environment production

# Optional: push to ANOTHER failure domain
BACKUP_PUSH_CMD='rsync -a --delete /srv/gsplatform-data/backups-local-buffer/ backup@offsite:/backups/' \
    sudo -u gsplatform ./deploy/scripts/backup.sh --environment production
```

Output under `$BACKUP_ROOT/<timestamp>/`:

```text
gsplatform-db.sql.enc          # PostgreSQL custom-format dump, AES-256-CBC (backup.key) or GPG
gsplatform-db.sql.enc.sha256
published-assets.tar.zst       # published scene versions (zstd or gzip fallback)
published-assets.tar.zst.sha256
config.tar.gz                  # /etc/gsplatform snapshot
backup-manifest.json           # sizes/checksums/date
```

Requirements:

- `pg_dump` on PATH, or set `PG_DUMP_CMD` (e.g. a docker wrapper on isolated boxes).
- `BACKUP_KEYFILE=/etc/gsplatform/backup.key` (generate: `openssl rand -base64 32 > backup.key; chmod 600`).
- Or `BACKUP_GPG_RECIPIENT=<key>` for GPG.

### Scheduling (cron example)

```cron
17 2 * * *  sudo -u gsplatform /opt/gsplatform/current/deploy/scripts/backup.sh --environment production >> /var/log/gsplatform-backup.log 2>&1
```

### Retention

`BACKUP_KEEP_N` days (default 14). Off-host copy uses `--delete` on the push
target so retention is mirrored.

## 3. Isolated restore rehearsal (`deploy/scripts/restore_drill.sh`)

Must be run **monthly** and whenever the DB schema or backup tool changes.

```bash
sudo -u gsplatform ./deploy/scripts/restore_drill.sh \
    --backup /srv/gsplatform-data/backups-local-buffer/<timestamp> \
    --restore-db gsplatform_restore_drill
```

Checks:

1. Creates an **isolated** database (`gsplatform_restore_drill`) — never touches production.
2. Decrypts + restores the dump (`pg_restore --no-owner`).
3. Counts rows (scenes/assets/versions/users) and reports.
4. Restores **one published scene** (manifest + Streamed SOG + poster) into an
   isolated dir, verifies files, and confirms it is viewer-openable.
5. Prints **measured RTO** (seconds) and RPO (backup timestamp).

**RPO/RTO are recorded in `docs/reports/PHASE_09_REPORT.md`** — keep them current.

## 4. Restore procedure (real incident)

```bash
# 1. STOP the app so no writes race the restore
sudo systemctl stop gsplatform-api gsplatform-celery-cpu gsplatform-celery-gpu

# 2. Restore the DB into a replacement database
./deploy/scripts/restore_drill.sh --backup <latest-good> --restore-db gsplatform_restore_recovery

# 3. Verify: counts + one scene + one user session
# 4. Point GS_DATABASE_URL at gsplatform_restore_recovery (or rename it to gsplatform)
# 5. Restart app; run smoke_test.sh
# 6. Update RPO/RTO + incident post-mortem (INCIDENT_RUNBOOK.md)
```

Never restore a DB dump into the live database while the app is writing
("hot restore") — that is how backups get corrupted.

## 5. Disaster recovery ordering

```text
LD failure → rebuild host → install deps (runbook) → create roles/dbs →
pull latest release → preflight → restore DB (drill) → restore published assets →
deploy_release.sh (syncs scene-origin) → smoke → open 1 scene cold-cache in Viewer.
```

## 6. Privacy

- Backups include user PII (emails, display names) — treat as sensitive;
  encrypt at rest (AES/GPG) and in transit (rsync over SSH / TLS).
- Retention must comply with the product privacy policy; delete expired backups.