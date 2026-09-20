# GSPlatform Incident Runbook

> Phase 09 artifact — first response, triage, rollback/restore decision, and
> post-mortem template.

## 1. Severity definitions

| Level | Description | Response target | Example |
|---|---|---|---|
| S1 – Service-down | Production site completely unreachable or auth broken | 30 min | Nginx returns 502; auth loop |
| S2 – Data-loss / integrity | Users see other users' data; DB corruption suspected | 15 min | Wrong assets served; audit log gaps |
| S3 – Feature-broken | One feature fails but main path works | 2 h | Favorites list empty; compute jobs stuck |
| S4 – Degraded | Slow responses, high error rates, non-critical alert | 4 h | Elevated 5xx; disk nearing quota |

## 2. Initial response checklist (first 10 minutes)

```bash
# 1. Triage: is it the app, the DB, the cache, or the host?
curl -fsS https://DOMAIN/health/ready            # app alive + DB reachable?
sudo systemctl status gsplatform-api             # app systemd health
sudo journalctl -u gsplatform-api --since 15min --no-pager | tail -40
sudo systemctl status postgresql redis-server

# 2. Is it the load balancer / Nginx?
sudo nginx -t
curl -fsS http://127.0.0.1/health/live            # bypass Nginx
sudo tail -n 100 /var/log/nginx/gsplatform.error.log

# 3. Database
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"   # connection storm?
sudo -u postgres psql -c "SELECT * FROM pg_locks WHERE granted=false;"  # lock contention

# 4. Redis / workers
redis-cli ping
celery -A workers.celery_app inspect active --timeout 5
```

## 3. Decision tree

```text
502 from Nginx?
 ├─ FastAPI process dead → restart + inspect logs → if recurring, rollback
 └─ FastAPI alive but slow → check DB locks + Redis → escalate to DB/worker triage

DB unreachable from FastAPI?
 ├─ Pg_isready false → restart PostgreSQL → if crash-looping, restore from backup
 └─ Pg_isready true, slow → check locks, vacuum, WAL, kill long queries

500 / unhandled in API?
 ├─ Deployed <1 hour ago → ROLLBACK (deploy_scripts/rollback.sh)
 └─ No recent deploy → inspect logs → check Redis/worker health

S2 (data integrity)?
 └─ STOP the app IMMEDIATELY, then follow DB restore in BACKUP_RESTORE_RUNBOOK §4
```

## 4. Rollback vs. Restore

| Situation | Use |
|---|---|
| Bad app code deploy | `rollback.sh` (symlink flip, seconds) |
| Bad migration / data loss | `restore_drill.sh` from pre-deploy backup (minutes–hours) |
| Redis lost (broker state) | Workers re-queue lost tasks; app is unaffected; re-run in-progress jobs |

Never run `alembic downgrade` under incident pressure unless a human has reviewed
the downgrade script against the current schema and confirmed it is safe.

## 5. Alert sources and thresholds

| What | Where | Threshold | Action |
|---|---|---|---|
| `health/ready` returns 5xx | External probe (curl cron / uptime kuma) | 1 × 30s | S1 |
| nginx 5xx / 5min | `goaccess` / central log | > 20 req | S1–S3 |
| DB connection pool exhaustion | `pg_stat_activity` count | > 80% pool | S3 |
| Redis memory > 80% max | `redis-cli info memory` | 80% | S4 |
| Disk / on storage root | `df -h /srv/gsplatform-data` | > 85% | S4 (capacity) |
| GPU worker task failure rate | Celery Flower / logs | > 3 in 30 min | S3–S4 |
| TLS cert expires in <14 days | `certbot certificates` cron | 14 d | S4 |

## 6. Post-mortem template

```markdown
# Incident: <short title>
- Severity: S_
- Start time (UTC):
- End time (UTC):
- Duration:
- Impact: # affected users / requests / data loss
- Root cause: (once known)
## Timeline
| Time | Event |
|---|---|
## Mitigation
## Resolution
## Follow-up actions
| Action | Owner | Due |
|---|---|---|
## Lessons learned
```

## 7. Communication

- **Internal (ops):** incident channel / ticket.
- **User-facing:** status page / product team notification.
- Keep user-facing comms factual; never claim "no data was accessed" without
  evidence (audit logs).
