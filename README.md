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
│   ├── viewer/       # LEGACY / DEPRECATED SuperSplat Editor-derived fork — 不参与生产查看
│   └── api/          # FastAPI backend (port 8001)
├── workers/          # Celery tasks & reconstruction pipeline
├── scenes/           # Local dev scenes (not in Git)
├── scripts/          # Release, conversion, inspection scripts
├── deploy/           # Compose, systemd, Nginx configs
├── tests/            # Cross-app acceptance tests
└── docs/             # Dev plans, phase reports, ADRs
```

## Scene Runtime Architecture

**Scene Runtime = 官方 `@playcanvas/supersplat-viewer`（唯一生产路径）**，见
`apps/web`（`apps/web/package.json` 依赖，WebGPU Desktop · WebGL XR · WebXR）。
GSPlatform 不再存在任何生产 legacy viewer 引用（SSV-09 已清理，见
`docs/SSV_09_REPORT.md` 与 `docs/adr/ADR_SUPERSPLAT_RUNTIME.md`）。

| | Official `@playcanvas/supersplat-viewer` Runtime | Legacy `apps/viewer` |
|---|---|---|
| 位置 | `apps/web`（官方 npm 包依赖） | `apps/viewer`（FROZEN fork） |
| 来源 | 官方 npm 包 | SuperSplat **Editor** 派生 fork |
| 状态 | **生产唯一 runtime** | **LEGACY / DEPRECATED**（`apps/xr-viewer` 已于 SSV-09 删除） |
| 承载 | Gaussian 渲染、相机、annotation、skybox、collision、walk、LOD、streaming、splat budget | 无生产用途；仅供未来可能的 primitive-level 编辑（另开 ADR） |
| 引用护栏 | — | `apps/web/src/__tests__/no-legacy-viewer-references.test.ts` 强制生产 Web 零引用 |

- 生产 Scene Runtime 决策见 `docs/adr/ADR_SUPERSPLAT_RUNTIME.md`（LEGACY / FROZEN，不接受重新讨论）。
- 迁移阶段顺序见 `docs/SSV_MIGRATION_PLAN.md`（SSV-00 ～ SSV-10，顺序固定）。
- `apps/viewer` 保留但**冻结**：不参与 dev / build / deploy / acceptance（root 聚合脚本已去除）。

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

正常开发只需 Web + API（Scene 由官方 runtime 渲染，不再需要启动 viewer）：

```bash
# Web frontend (Scene 查看就在这里)
pnpm --filter @gsplatform/web dev

# API backend (separate terminal)
cd apps/api
source .venv/bin/activate
uvicorn app.main:app --reload --port 8001
```

Redis / PostgreSQL / workers 在需要后台任务时再启动（见 `workers/` 与 `deploy/`）。

> Legacy `apps/viewer` 不再参与正常开发；如需单独构建/维护该冻结包，显式使用
> `pnpm legacy:viewer:dev` / `pnpm legacy:viewer:build`（root 脚本）。

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
