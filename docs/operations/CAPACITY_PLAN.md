# GSPlatform Capacity Plan

> Phase 09 artifact — sizing model, monitoring thresholds, and growth levers.
> Numbers below are planning estimates; validate with the metrics in
> INCIDENT_RUNBOOK §5 after the first production month.

## 1. Workload profile (from Phase 00–08 design)

- Scene = published Streamed SOG with LODs; typical 10–200 MB (poster + manifest + chunks).
- Per-view: 1 manifest fetch + N chunk Range requests (206).
- Compute jobs: FFmpeg extract → COLMAP → gsplat train → splat-transform → publish.
- API: browse (list 20), detail, favorites, shares, assistant (LLM), uploads (up to 5 GB each).

## 2. Reference sizing (single Ubuntu host, small/medium site)

| Component | Baseline | Growth trigger | Lever |
|---|---|---|---|
| Nginx | 4 worker procs | > 5k req/min | scale out/up; CDN for /local-scenes |
| FastAPI (uvicorn) | 4 workers on 2–4 vCPU | CPU > 70% sustained | +workers / separate host |
| PostgreSQL | 2 vCPU, 4 GB, max_connections=100 | pool > 80% | vacuum tuning, read replica, connection pooler |
| Redis | 1 GB maxmemory, noeviction | mem > 80% | increase maxmemory / cluster |
| Celery CPU | 4 procs | queue depth > 50 sustained | +workers / autoscale |
| Celery GPU | 1 proc (A6000) | train queue > 3 | second GPU worker |
| Scene storage | 1 TB @ published | disk > 85% | add data volume / object storage |
| Backups | 2× published size | > 2×30 d retention | external object storage |

## 3. Disk layout & quotas (Phase 09 F)

```text
/srv/gsplatform-data/
├── staging/            transient uploads  (TTL 24 h; cleanup timer)
├── quarantine/         rejected uploads   (retain; review)
├── published/          immutable versions (the only source of truth served)
├── scene-origin/       symlink tree → published  (rebuildable, NOT backed up)
├── logs/               rotated app logs
└── backups-local-buffer/  → pushed off-host
```

- Enforce a **watermark** on `/srv/gsplatform-data` (monitor > 85%; block new
  upload/compute at 90% via preflight check before starting jobs).
- Never let backups live only on the same disk as published data.

## 4. Growth levers (ordered by cost/benefit)

1. **CDN in front of `/local-scenes/`** — Range-compatible CDNs (Cloudflare,
   Fastly) offload the bulk of viewer traffic; keep `Cache-Control: immutable`
   for versioned chunks.
2. **Object storage for published assets** — move published versions to S3/OSS;
   Nginx (or FastAPI X-Accel) streams from there. Phase 06's atomic-rename
   publish must be re-validated against the object-store commit protocol.
3. **Read replica for PostgreSQL** — if browse traffic dominates.
4. **Dedicated compute host(s)** — reconstruction is CPU/GPU bursty; separate
   workers keep the serving host stable.
5. **Horizontal API replicas + sticky sessions** — needed only when session
   affinity matters (it doesn't today; sessions are DB-backed).

## 5. Capacity monitoring thresholds (dashboard)

| Metric | Good | Watch | Alarm |
|---|---|---|---|
| CPU (host) | < 60% | 60–80% | > 85% |
| RAM | < 75% | 75–85% | > 90% |
| Disk /srv | < 75% | 75–85% | > 85% |
| Disk inodes | < 75% | > 85% | > 95% |
| GPU VRAM | < 70% | 70–85% | > 90% |
| DB pool usage | < 60% | 60–80% | > 80% |
| Redis memory | < 70% | 70–80% | > 80% |
| Queue depth (CPU/GPU) | < 5 | 5–20 | > 50 |
| Task failure rate | 0 | < 2% | > 3% |
| View 4xx/5xx on /local-scenes | < 1% | 1–3% | > 5% |

## 6. Rollover budget (Phase 09 G)

- Every release: backup → preflight → migrate (compatible) → switch → smoke →
  observe 30 min before declaring success.
- DB schema: additive migrations only; destructive changes split across ≥2 releases.
- Expected worst-case app rollback time: < 5 min (symlink + restart).
- Expected worst-case DB restore time: see measured RTO in `PHASE_09_REPORT.md`.
