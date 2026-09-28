# GSPlatform

3D Gaussian Splatting scene platform — browse, upload, share, and compute high-quality 3DGS scenes in a browser.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Web Frontend | React, TypeScript, Vite, Ant Design, Zustand, Axios |
| Scene Viewer | Official [@playcanvas/supersplat-viewer](https://github.com/playcanvas/supersplat) Runtime (WebGPU/WebGL/WebXR), SOG |
| API Backend | Python 3.11, FastAPI, Pydantic v2, SQLAlchemy 2.x, Alembic |
| Async Workers | Celery, Redis, FFmpeg, COLMAP, gsplat, splat-transform |
| Database | PostgreSQL |
| Deployment | Ubuntu, Nginx, HTTPS |

## Repository Structure

```
GSPlatform/
├── apps/
│   ├── web/          # React frontend (port 5173) — official supersplat-viewer runtime
│   ├── viewer/       # LEGACY SuperSplat Editor-derived Viewer (port 5174) — FROZEN, 迁移期保留不删除
│   ├── xr-viewer/    # LEGACY standalone PlayCanvas WebXR viewer — FROZEN, 迁移期保留不删除
│   └── api/          # FastAPI backend (port 8001)
├── workers/          # Celery tasks & reconstruction pipeline
├── scenes/           # Local dev scenes (not in Git)
├── scripts/          # Release, conversion, inspection scripts
├── deploy/           # Compose, systemd, Nginx configs
├── tests/            # Cross-app acceptance tests
└── docs/             # Dev plans, phase reports, ADRs
```

## Scene Runtime Architecture

GSPlatform 有两套历史 Viewer，**当前只有一套用于生产**，必须区分清楚：

| | Official `@playcanvas/supersplat-viewer` Runtime | Legacy `apps/viewer` | Legacy `apps/xr-viewer` |
|---|---|---|---|
| 位置 | `apps/web/src/xr/` + `apps/web`（`apps/web/package.json` 依赖） | `apps/viewer` | `apps/xr-viewer` |
| 来源 | 官方 npm 包 | SuperSplat **Editor** 派生 fork | 自建 PlayCanvas Engine viewer |
| 状态 | **生产唯一 runtime** | **LEGACY / FROZEN** | **LEGACY / FROZEN** |
| 渲染 | WebGPU Desktop · WebGL XR · WebXR | 仅 WebGPU（`xrCompatible:false`） | PlayCanvas Engine + WebXR |
| 承载 | Gaussian 渲染、相机、annotation runtime、skybox、collision runtime、walk、LOD、splat budget | 与官方重复（Desktop 场景页 iframe 加载） | 与官方重复（XR 交互、collision、walk） |
| 迁移期 | SSV-03/04 逐步统一全部入口 | 保留不删除，SSV-09 清理 | 保留不删除，SSV-09 清理 |

- 生产 Scene Runtime 决策见 `docs/adr/ADR_SUPERSPLAT_RUNTIME.md`（LEGACY / FROZEN，不接受重新讨论）。
- 迁移阶段顺序见 `docs/SSV_MIGRATION_PLAN.md`（SSV-00 ～ SSV-10，顺序固定）。
- `apps/viewer` 与 `apps/xr-viewer` 在 SSV-09 之前**不删除**，但**冻结**，不得新增生产功能。

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
- `apps/viewer` is based on [SuperSplat](https://github.com/playcanvas/supersplat) (SuperSplat Editor) — MIT License.
- Production runtime is the official [@playcanvas/supersplat-viewer](https://github.com/playcanvas/supersplat) package (MIT License), not the fork.
