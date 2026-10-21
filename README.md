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

最终运行时链路（SSV-10 → FIX-02/03/04 验收）：

```text
GSPlatform → SceneRuntimeDescriptor → ExperienceSettings v2
           → @playcanvas/supersplat-viewer@1.35.0
             → Desktop：WebGPU-first（官方自动回退 WebGL2）
             → XR（/xr/:sceneId）：WebGL + WebXR（renderer 强制 webgl，同一 SuperSplatRuntime）
           → @photo-sphere-viewer/core@5.15.1（PANORAMA 360° 标注媒体，FIX-03）
```

| | Official `@playcanvas/supersplat-viewer` Runtime | Legacy `apps/viewer` |
|---|---|---|
| 位置 | `apps/web`（官方 npm 包依赖） | `apps/viewer`（FROZEN fork） |
| 来源 | 官方 npm 包 | SuperSplat **Editor** 派生 fork |
| 状态 | **生产唯一 runtime** | **LEGACY / DEPRECATED**（`apps/xr-viewer` 已于 SSV-09 删除） |
| 承载 | Gaussian 渲染、相机、annotation、skybox、collision、walk、LOD、streaming、splat budget；背景音频与 PANORAMA 360° 由 GSPlatform 层管理 | 无生产用途；仅供未来可能的 primitive-level 编辑（另开 ADR） |
| 引用护栏 | — | `apps/web/src/__tests__/no-legacy-viewer-references.test.ts` 强制生产 Web 零引用 |

- 生产 Scene Runtime 决策见 `docs/adr/ADR_SUPERSPLAT_RUNTIME.md`（LEGACY / FROZEN，不接受重新讨论；SSV-00 ～ SSV-10 迁移已闭环）。
- 迁移记录见 `docs/SSV_MIGRATION_PLAN.md`（SSV-00 ～ SSV-10，全部完成）；SSV 阶段验收见 `docs/reports/SSV_FINAL_ACCEPTANCE.md`。

### 当前真正支持能力（FIX-04 验收口径）

- **Desktop** `/scene/:sceneId`：官方 runtime 渲染 Gaussian（SOG / streamed LOD），
  WebGPU-first（不可用时自动回退 WebGL2）；相机/视角点/标注/背景色/Skybox/PostFX/
  碰撞 Walk（官方固定物理，物理参数不可调）/Scale 校准/Performance Mode；媒体标注
  IMAGE/VIDEO/AUDIO/PANORAMA（PSV 360°）+ 自管背景音频（volume/loop/ducking）。
- **XR** `/xr/:sceneId`：正式全屏产品页（最小 UI：场景名 / Enter VR / Exit VR / Back /
  Loading / Error），同一 SuperSplatRuntime，renderer 强制 WebGL + WebXR；
  工程诊断集中在 `/xr/test` 与 `/xr/diagnostics/:sceneId`。
- **未验收的能力绝不声称**：Quest/PICO 真机 6DoF 验收与真实域名 HTTPS 部署未执行
  （见 `docs/reports/PRODUCTION_RUNTIME_ACCEPTANCE.md`，OVERALL=BLOCKED — XR HARDWARE
  ACCEPTANCE NOT EXECUTED）；沉浸 WebXR 会话内不显示 HTML 媒体 Overlay / 官方
  annotation tooltip（DOM 层），产品行为 = 退出沉浸后使用 2D Overlay。
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

# Python environment — managed by uv (conda is NOT used)
./scripts/bootstrap_python_env.sh              # API + dev tools
./scripts/bootstrap_python_env.sh --with-recon # + torch/gsplat for the GPU worker
```

### Python dependency management (uv)

本仓库的 Python 依赖**不再使用 conda**：

| 文件 / 命令 | 作用 |
| --- | --- |
| `apps/api/pyproject.toml` | 声明运行时依赖与 `dev` extra |
| `apps/api/uv.lock` | 锁定的完整解析结果（提交入库） |
| `scripts/bootstrap_python_env.sh` | 用 uv 创建/刷新 `apps/api/.venv` |
| `uv sync --extra dev --python 3.11` | 等价的手动命令（在 `apps/api/` 下执行） |
| `uv lock` | 修改依赖后重新生成锁文件 |

`apps/api/pyproject.toml` 里的 `[tool.uv] python-preference = "only-managed"`
强制 venv 使用 uv 自己管理的 CPython，**即使 PATH 里存在 conda 也不会复用**。
`apps/api/.venv/bin/python` 指向 `~/.local/share/uv/python/…`，不再指向任何
conda 环境。

GPU 重建运行时（`torch==2.14.0+cu126` / `gsplat==1.5.3`）有两个等价的固定入口：

- 开发机：`scripts/bootstrap_python_env.sh --with-recon`（即
  `uv sync --extra dev --extra recon`）；torch 由 `[tool.uv.sources]` 指向
  PyTorch cu126 索引，版本已经写进 `uv.lock`；
- 生产发布：`deploy/requirements-reconstruction.txt`（pip 自包含 venv，
  见 `deploy/scripts/deploy_release.sh`），与 `recon` extra 保持同一组版本。

> uv 的 `sync` 会移除未选中的 extra。需要 GPU worker 时请始终带
> `--with-recon`，否则 torch/gsplat 会被卸载。
>
> uv venv 默认不安装 `pip`；请用 `uv pip install …`（自动作用于
> `apps/api/.venv`），不要依赖 `apps/api/.venv/bin/pip`。

### Run (Development)

正常开发只需 Web + API（Scene 由官方 runtime 渲染，不再需要启动 viewer）：

```bash
# Web frontend (Scene 查看就在这里)
pnpm --filter @gsplatform/web dev

# API backend (separate terminal) — 无需 activate
apps/api/.venv/bin/uvicorn app.main:app --reload --port 8001
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
