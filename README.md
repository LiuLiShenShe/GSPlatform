# GSPlatform

3D Gaussian Splatting scene platform — browse, upload, share, and compute high-quality 3DGS scenes in a browser.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web Frontend | React, TypeScript, Vite, Ant Design, Zustand, Axios |
| Scene Viewer | SuperSplat Viewer (fork of playcanvas/supersplat), PlayCanvas Engine, SOG |
| API Backend | Python 3.11, FastAPI, Pydantic v2, SQLAlchemy 2.x, Alembic |
| Async Workers | Celery, Redis, FFmpeg, COLMAP, gsplat, splat-transform |
| Database | PostgreSQL |
| Deployment | Ubuntu, Nginx, HTTPS |

## Repository Structure

```
GSPlatform/
├── apps/
│   ├── web/          # React frontend (port 5173)
│   ├── viewer/       # SuperSplat Viewer fork (port 5174)
│   └── api/          # FastAPI backend (port 8001)
├── workers/          # Celery tasks & reconstruction pipeline
├── scenes/           # Local dev scenes (not in Git)
├── scripts/          # Release, conversion, inspection scripts
├── deploy/           # Compose, systemd, Nginx configs
├── tests/            # Cross-app acceptance tests
└── docs/             # Dev plans, phase reports, ADRs
```

## Quick Start

### Prerequisites

- Node.js ≥ 20, pnpm ≥ 9
- Python 3.11
- PostgreSQL, Redis (for backend phases)

### Install

```bash
corepack enable
pnpm install
```

### Run (Development)

```bash
# Web frontend
pnpm --filter @gsplatform/web dev

# Viewer
pnpm --filter @gsplatform/viewer dev

# API backend (separate terminal)
cd apps/api
source .venv/bin/activate
uvicorn app.main:app --reload --port 8001
```

### Quality Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# API
cd apps/api
python -m ruff check .
python -m mypy app
python -m pytest -q
```

## License

See individual application directories for license information.
Viewer is based on [SuperSplat](https://github.com/playcanvas/supersplat) — MIT License.
