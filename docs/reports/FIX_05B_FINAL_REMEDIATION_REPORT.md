# FIX_05B_FINAL_REMEDIATION：Vite Dev Asset / Cache / Trust Boundary 最终整改报告

- 日期：2026-09-30
- 阶段：FIX-05B —— FIX-05 的**补充收尾**（无新业务功能；仅关闭 FIX-05 遗留的
  4 项 Vite 开发资产 / 缓存 / 信任边界 / 文档问题 + 1 项门禁复核问题）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体/运行时对齐）PASS ·
  FIX-04（生产验收，软件项）PASS · FIX-05（独立审计整改）PASS
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（**未升级**，§26 遵守）
- 说明：FIX-05 已正确修复 **后端 API + Nginx** 的缓存/信任根问题；本阶段经逐项源码
  复核发现 **Vite 开发中间件** 是漏网之鱼（FIX-05 只改了 API/Nginx，`apps/web/vite.config.ts`
  的 `/local-scenes` 中间件缓存与信任根仍是旧行为），另有 2 项文档未同步。

---

## RESULT

**PASS**（4 项审计 + 1 项门禁复核全部关闭；无 P0/P1 遗留）

| 项 | 结论 |
|---|---|
| ISSUE 1 Vite `/current/*` 仍为 immutable | ✅ FIXED |
| ISSUE 2 Vite 发布信任根仍过宽（跟随 `storage/published`） | ✅ FIXED（Plan A） |
| ISSUE 3 `RuntimeAnnotation` 注释仍声称锚定 Gaussian 表面 | ✅ FIXED（仅文档） |
| ISSUE 4 `PRODUCTION_RUNTIME_ACCEPTANCE.md` 未同步到 FIX-05 之后状态 | ✅ FIXED |
| 门禁复核：FIX-05 声称 ruff clean，实测 11 处 lint 错误 | ✅ FIXED（零行为变更） |

## HEAD BEFORE

- `git log -1`：`94d7e33 fix(runtime): remediate independent production audit findings`
- 工作区：clean（本阶段开始前无未提交改动）
- §2 源码复核结论（**不只依赖报告**）：4 项**全部仍存在**，无一属于 `ALREADY FIXED
  BEFORE FIX-05B`。FIX-05 对 API（`scene_asset.py` scope/缓存/信任根）、Nginx
  （map + 移除 add_header 覆盖）、运行时（stale/复位/近似拾取）的修复是**正确的**，
  但 `vite.config.ts` 的 `/local-scenes` 中间件：缓存头仍按文件名判断
  （`manifest.json → 60s`、其余 → immutable，`current/*` 被命中 immutable）；
  信任根仍枚举 `scenes/<slug>/versions/*` symlink 的 realpath 并信任任何解析进
  `<storage>/published` 的条目 —— 无法证明该 UUID 属于本 slug，跨场景仍可互透。

## ISSUE 1：VITE CURRENT CACHE

- 前置（`vite.config.ts` send()）：
  ```ts
  const isManifest = path.basename(rel) === 'manifest.json'
  res.setHeader('Cache-Control',
    isManifest ? 'public, max-age=60' : 'public, max-age=31536000, immutable')
  ```
  → `/local-scenes/<slug>/current/*`（scene.sog / lod-meta.json / chunk）全部
  `public, max-age=31536000, immutable`。`current` 是可重指向别名（发布后 symlink
  换目标），URL 不变但字节可变，**禁止 immutable**（FIX-05 P0/P1-2 的语义在 Vite
  开发中间件漏掉）。
- 修复：纯函数 `buildDevSceneCacheControl(relPath)`（新 `src/scene-dev/sceneAssetPolicy.ts`），
  按**路径语义**而非文件名：
  - `current/<file>` → `public, no-cache`（**任何** current 下文件，含
    `current/manifest.json`、`current/poster.webp` —— 特殊策略不得覆盖 current 规则）
  - `versions/<ver>/<file>` → `public, max-age=31536000, immutable`（内容寻址不可变）
  - 顶层 `manifest.json` → `public, max-age=60`（描述符拉取）
  - 顶层 `poster.webp` → `public, max-age=86400`
  - 其它/未知 → `public, no-cache`
- 单测：`dev-scene-asset-policy.test.ts`（14 项，§5 矩阵全覆盖）。
- 实测（live vite :5199，§23）：`current/scene.sog|lod-meta.json|manifest.json`
  → `public, no-cache`；`versions/v1/scene.sog|lod-meta.json` → `public, max-age=31536000, immutable`；
  Range 0-3 → 206 + `Content-Range`。

## ISSUE 2：VITE PUBLISHED TRUST ROOT

- 前置（`vite.config.ts` 信任块）：`trusted = [realSceneRoot] + realpath(versions/*)`
  （凡解析进 `<storage>/published` 的版本 symlink realpath 都被信任）。攻击面：恶意/
  误植 symlink `scenes/A/versions/evil -> published/<B>/versions/...`（或
  `-> ../B/versions/...`）→ A 可读 B 的资产。开发 origin 无 DB，无法证明
  `published/<uuid>` 属于 slug A。
- 现场盘点（§6-§8）：`<storage>/published/<uuid>/versions/<ver>` 只被 **DB 场景**
  （`r-8c4e2264e86a`、`r-edfcb5297a29`）的 `scenes/<slug>/versions/<ver>` symlink
  指向；它们的描述符走 `/api/v1/scenes/<id>/runtime` → 资产走 `/api/.../assets/*`
  （vite `/api` proxy → FastAPI），**不经** `/local-scenes`。仓库级开发场景
  （local-garden / stream-* / ssv08-* / fix02-semantics / progressive-test /
  ssv08-single）的 `versions/` **全部是真实目录**，不指向 published。
- 修复（**Plan A**，§9 首选方案）：`/local-scenes` **只服务本地场景树，不再跟随
  `storage/published` 任何 symlink**。信任根 = 该场景自身 real root 唯一一项
  （`buildDevSceneTrustedRoots(realSceneRoot)`，纯函数；回归守卫测试断言永不包含
  `published` 路径）。真实 DB/published 场景唯一合法路径是
  `/api/v1/scenes/{id}/assets/*` —— 那里信任根是 `published/<scene.id>`（FIX-05
  P1-6，`_published_root_for`，含 §11 跨场景测试）。开发中间件删除 `publishedRoot`
  常量与 versions-readdir 信任块。
- 行为影响：`current -> versions/<ver>`（真实目录）在场景根内解析，照常服务；e2e
  `ssv08-streaming` 依赖的 `/local-scenes/ssv08-large/versions/...` 不受影响（真实目录）。
- 实测（live §25，真实 A/B 场景 + 真实 symlink）：见 CROSS-SCENE TEST 与 SYMLINK REGRESSION。

## ISSUE 3：PICKING DOCUMENTATION

- 前置：`apps/web/src/scene-runtime/types.ts:116` —— `/** 3D 热点标注，锚定在 Gaussian 表面。 */`，
  与 FIX-05 §29 定下的「拾取为近似，不保证命中 splat 表面」矛盾。
- 修复：改为「`anchor` 是场景坐标系中的 3D 锚点，**不保证落在 Gaussian 表面** ——
  作者态拾取是沿视线取场景包围盒中心深度的近似（`ScenePickingAdapter.pickApproximateWorldPosition`）；
  精确表面拾取（GPU 命中测试）只有预留接口 `pickSurfaceWorldPosition`，未实现」。
  **未改动 RuntimeAnnotation 数据结构（仅文档）。**
- §14 复核：`ScenePickingAdapter.ts` 注释已正确区分 approximate（现成，bbox 深度，
  不保证命中表面）与 future exact surface（预留，禁止伪造精确）；`SuperSplatRuntime`
  拾取注释一致；全源码 grep 除历史报告外无其它「当前已是精确表面命中」主张。

## ISSUE 4：PRODUCTION ACCEPTANCE SYNC

- 前置：`docs/reports/PRODUCTION_RUNTIME_ACCEPTANCE.md` 停留在 FIX-04 阶段 +
  FIX-05 blocker 拆分段，未标记 FIX-05B、未列出 FIX-05B 之后的最新测试计数与
  各子系统状态。
- 修复：新增「## FIX-05B：最终复核（2026-09-30）」段并更新阶段行，覆盖：
  Acceptance Stage = FIX-05B；Software blockers = NONE；Hardware blockers =
  `XR HARDWARE ACCEPTANCE NOT EXECUTED`（Quest/PICO 真机）；Frontend tests =
  227 passed / 26 files；typecheck 0 errors；Backend tests = 208 passed；Worker
  tests = 13 passed；Security / Cache / World Transform / Collision stale /
  Picking 状态逐项列出（见该报告）。

## AUTOMATED TESTS（§22，真实命令）

| 门禁 | 命令 | 结果 |
|---|---|---|
| web 单测 | `pnpm --filter @gsplatform/web vitest run` | **227 passed / 26 files**（含新增 dev-scene-asset-policy 14） |
| web typecheck | `pnpm --filter @gsplatform/web typecheck`（tsc -b --noEmit） | **0 errors** |
| web lint | `pnpm --filter @gsplatform/web lint`（oxlint） | exit 0 |
| web build | `pnpm --filter @gsplatform/web build`（tsc -b + vite build） | exit 0 |
| backend | `apps/api/.venv/bin/python -m pytest -q` | **208 passed** |
| backend ruff | `.venv/bin/python -m ruff check .` | **All checks passed** |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| workers | `apps/api/.venv/bin/python -m pytest tests -q`（workers/tests） | **13 passed** |
| 仓库 | `pnpm test` / `pnpm lint` / `pnpm api:check` | 227 / exit 0 / clean |

门禁复核发现：FIX-05 提交的 11 处 ruff 违规（`scene_presentation.py` 4×E501、
`scene_asset.py` UP042、`collision.py` UP037、`test_collision_stale.py` F401+W292、
`test_paths.py` F401、`test_scene_assets.py`+`test_scene_runtime.py` E501）——FIX-05
报告称 ruff clean 不实。本阶段全部修复（`(str, Enum)` → `StrEnum` 保留值/同一性语义、
注释换行、移除未用 import），**零行为变更**（208 passed 复证）。如实记录，不掩盖。

## TRAVERSAL REGRESSION（§12，live :5199，curl --path-as-is）

| 请求 | 结果 |
|---|---|
| `/local-scenes/bta/current/../../etc/passwd` | **400** |
| `/local-scenes/bta/current/..%2f..%2fetc%2fpasswd`（编码） | **400** |
| `/local-scenes/bta/current/%252e%252e%252fetc/passwd`（双重编码） | **400** |
| `/local-scenes/../../etc/passwd`（slug 注入） | **403** |
| `/local-scenes/non-existent-zzz/...` | **404** |

单次解码 / slug 语法 / `%` 残留拒绝 / 组件级 containment —— FIX-05 已有逻辑全部保留，未回归。

## SYMLINK REGRESSION（§12/§25）

| 请求 | 结果 |
|---|---|
| `/local-scenes/bta/versions/evil-sibling/scene.sog`（A→B，**可解析**，B 字节在盘上） | **403**（不得 200） |
| `/local-scenes/bta/versions/evil-published-root/scene.sog`（A→`published/<uuid>`） | **403** |
| `/local-scenes/bta/versions/v1/scene.sog`（A→A 自身版本） | 200 |
| `/local-scenes/bta/current/scene.sog`（A→A current） | 200 |
| `/local-scenes/btb/versions/v1/scene.sog`（B→B 自身） | 200 |

## CROSS-SCENE TEST（§11，真实场景 + 真实 symlink）

- 测试环境：`scenes/bta/versions/v1/scene.sog`（A 字节）+ `scenes/btb/versions/v1/scene.sog`
  （B 字节，内容 `B-SOG-BYTES`）+ `storage/published/0000…beef/versions/v1/scene.sog`；
  植 `scenes/bta/versions/evil-sibling -> ../../btb/versions/v1`（**真实可解析**，先
  验证 `realpathSync` 得 `/scenes/btb/versions/v1/scene.sog`）与
  `scenes/bta/versions/evil-published-root -> <storage>/published/<uuid>/versions/v1`。
- **A→A published ALLOW**：由 **API** 承载（`SceneAssetService._trusted_roots` =
  `[scene_root] + published/<scene.id>`，`test_scene_assets.py::TestSceneSpecificPublishedRoot`
  —— A 自己的 `versions/<ver>` symlink 允许、植 `published/<B>/` symlink 拒绝）；
  Vite 开发中间件按 Plan A **不暴露 published**（该行 = 设计上不可达，更安全）。
- **A→B / A→outside published DENY**：Vite 403（上述 SYMLINK REGRESSION）+ API 拒
  绝（FIX-05 测试不回归，208 passed 含之）。
- 本阶段关键结论：即使 `scenes/A/versions/*` symlink 真实指向 B 的目录（或
  `published/<B>/`），A 也读不到 B —— Vite 侧 403，API 侧 404/拒绝。

## CACHE MATRIX（§20，实测 header）

| 路径 | Cache-Control |
|---|---|
| `current/scene.sog` | `public, no-cache` ✅ |
| `current/lod-meta.json` | `public, no-cache` ✅ |
| `current/chunk.webp` | `public, no-cache` ✅（纯函数矩阵 + 语义一致） |
| `versions/v1/scene.sog` | `public, max-age=31536000, immutable` ✅ |
| `versions/v1/chunk.webp` | `public, max-age=31536000, immutable` ✅ |
| `versions/v1/lod-meta.json` | `public, max-age=31536000, immutable`（内容寻址） |
| `current/manifest.json` | `public, no-cache`（current 规则优先于 manifest 特例） |
| 顶层 `manifest.json`（描述符拉取） | `public, max-age=60` |
| 顶层 `poster.webp` | `public, max-age=86400` |
| 其它/未知 | `public, no-cache` |

## TRUST MATRIX（§21）

| 场景 | Vite `/local-scenes` | API `/api/v1/scenes/{id}/assets` |
|---|---|---|
| A→A published（`published/<A.id>`） | N/A（Plan A 不暴露 published） | **ALLOW**（场景专属根） |
| A→B published（symlink 指向 `published/<B.id>`） | **DENY（403）** | DENY |
| A→outside published / 其它目录 | **DENY（403）** | DENY |
| A→traversal（`../`、编码、双重编码、slug 注入） | **DENY（400/403）** | DENY（404） |
| A→允许的本地 smoke 场景（local-garden 等） | **ALLOW** | — |
| 隧道非白名单 → 本地场景 | **DENY（403）** | — |

## RUNTIME VERIFICATION（§23-§25，live vite :5199）

| 项 | 实测 |
|---|---|
| VITE CURRENT header | `current/scene.sog` → `Cache-Control: public, no-cache` |
| VITE VERSIONED header | `versions/v1/scene.sog` → `Cache-Control: public, max-age=31536000, immutable` |
| CROSS-SCENE SYMLINK DENIED | **403**（A→B 可解析 symlink 与 A→published-root 均 403，非 200） |
| TUNNEL NON-WHITELIST DENIED | **403**（`GS_ENABLE_DEV_TUNNEL=1 XR_DEV_PUBLIC_SCENES=local-garden`：local-garden 200，bta / stream-large 403，query 参数不可绕过） |
| Range | 206 + `Content-Range: bytes 0-3/11` |
| 启动 WARNING | `DEV TUNNEL ENABLED (/local-scenes 白名单: local-garden)` |

## FILES CHANGED

web：`vite.config.ts`（缓存纯函数接入 + Plan A 信任根收窄 + 注释更新）、
`src/scene-dev/sceneAssetPolicy.ts`（新：buildDevSceneCacheControl /
buildDevSceneTrustedRoots）、`src/scene-runtime/types.ts`（RuntimeAnnotation 注释修正，仅文档）、
`src/__tests__/dev-scene-asset-policy.test.ts`（新，14 项）。
backend（仅门禁修复，零行为变更）：`app/api/v1/scene_presentation.py`（4×E501）、
`app/services/scene_asset.py`（UP042 → StrEnum）、`app/services/collision.py`（UP037）、
`tests/test_collision_stale.py`（F401/W292）、`tests/test_paths.py`（F401）、
`tests/test_scene_assets.py`（E501）、`tests/test_scene_runtime.py`（E501）。
docs：`docs/reports/FIX_05B_FINAL_REMEDIATION_REPORT.md`（本报告，新）、
`docs/reports/PRODUCTION_RUNTIME_ACCEPTANCE.md`（FIX-05B 同步）、
`docs/reports/FIX_05_AUDIT_REMEDIATION_REPORT.md`（仅追加 Post-audit note，不改写历史）。

## SOFTWARE BLOCKERS

**NONE**（4 项审计 + 1 项门禁复核全部关闭；无 P0/P1 遗留）。

## HARDWARE BLOCKERS

`XR HARDWARE ACCEPTANCE NOT EXECUTED` —— 无 Quest/PICO 头显；真机项（6DoF、
左右眼视差、Enter/Exit/Re-enter、TEXT/IMAGE hotspot 真机、碰撞不破坏 XR、
LOD 全量首帧真实 GPU 复核）待真机环境执行（详见 PRODUCTION_RUNTIME_ACCEPTANCE.md）。

## NEXT STEP

**Real Quest/PICO production XR acceptance**（真机硬件验收；本阶段不自动开始下一阶段）。
