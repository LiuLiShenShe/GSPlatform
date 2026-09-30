# FIX_05_AUDIT_REMEDIATION：独立生产审计修复报告

- 日期：2026-09-30
- 阶段：FIX-05 — 独立审计整改（**无新业务功能**；仅修复已确认的安全 / 缓存 / 世界变换 / 碰撞 / dev-publish 桥 / 运行时状态问题）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体与运行时对齐）PASS · FIX-04（生产验收，软件项）PASS
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（**未升级**，§32 FORBIDDEN 遵守）

---

## RESULT

**PASS**（9 项审计全部关闭；P0/P1 无遗留）

| 审计项 | 结论 |
|---|---|
| P0-1 dev 隧道暴露 `/local-scenes/*` | ✅ FIXED |
| P0/P1-2 `/current/*` 错误 immutable | ✅ FIXED |
| P1-3 私有/分享资产错误 `public` 缓存 | ✅ FIXED |
| P1-4 世界变换恒等无法复位实体 | ✅ FIXED |
| P1-5 碰撞与变换未同步（STALE 语义） | ✅ FIXED |
| P1-6 发布信任根过宽（整个 `published/`） | ✅ FIXED |
| P1-7 publish bridge `parents[N]` repo root | ✅ FIXED |
| P2-8 setCameraPose 隐藏标注无限增长 | ✅ FIXED |
| P2-9 拾取为近似（标记 + 预留接口，不伪造精确） | ✅ FIXED（标记/文档化） |

## HEAD BEFORE

- `git log -1`：`ce6c81d chore(runtime): complete production SuperSplat acceptance`
- 工作区：8 个已修改后端文件 + 新增 `app/core/paths.py`（FIX-05 进行中未提交）
- 所有审计项在修改前均以 `rg` 复核仍存在（未修复过）。

## AUDIT ITEMS（逐项）

1. **P0-1 / §3-§6 —— dev 隧道绕过 SceneAccessPolicy**
   - 前置：`GS_ENABLE_DEV_TUNNEL=1` 时 vite 中间件对 `/local-scenes/<slug>/*` 无条件服务，
     绕过统一策略；`allowedHosts` 闸门只挡 Host，不挡路径。
   - 修复：隧道模式只放行显式白名单 `XR_DEV_PUBLIC_SCENES`（逗号分隔 slug）；
     `isDevSceneAllowed(sceneId)` 纯函数（`src/scene-dev/sceneAllowlist.ts`）；
     白名单为空 → 全部拒绝；无默认 allow-all；无 query 参数绕过；隧道关闭时本地开发不受影响。
   - 启动 WARNING（§5）：隧道开启时打印 `DEV TUNNEL ENABLED（白名单: … | NO LOCAL SCENE IS PUBLICLY EXPOSED）`。

2. **P0/P1-2 / §7-§9 —— `/current/*` 缓存**
   - 前置：`Cache-Control: public, max-age=31536000, immutable` 命中 `current/*`；
     current 是可重指向别名，禁止 immutable。
   - 修复：`build_cache_control(scope, rel)` —— `current/*` → `no-cache`；
     `versions/<ver>/*` → `immutable`。`deploy/nginx/gsplatform.conf` map 同步纠正
     （`default → public, no-cache`；`versions/*` → immutable；manifest 60s；poster 1d）；
     `scenes-streaming.conf` 移除 `add_header Cache-Control $scene_cache_control always;`
     —— API（知道访问 scope）是唯一权威，nginx 不得覆盖私有场景的 `private`。

3. **P1-3 / §10-§12 —— 私有/分享缓存 scope**
   - `SceneAssetAccessScope = PUBLIC | OWNER | SHARE`（`scene_asset.py`）；
   `SceneAccessPolicy.cache_scope(scene, share_token)` 是 scope 唯一来源。
   矩阵：PUBLIC 版本化 → `public, max-age=31536000, immutable`；PUBLIC current → `public, no-cache`；
   OWNER 版本化 → `private, …immutable`；OWNER current → `private, no-cache`；SHARE → `private, no-cache`。
   私有/分享永不 `public`。

4. **P1-4 / §18-§21 —— 世界变换恒等复位**
   - 前置：`applyWorldTransform()` 恒等时 early-return，变换后改回恒等无法复位。
   - 修复：首次观察到 gsplat 实体时捕获 `baseGsplatTransform`（加载后原始 TRS）；
     `actualTransform = W ∘ base`（PlayCanvas 局部 TRS 语义，不假定 base 恒等）；
     恒等 W → 显式恢复 base。`composeEntityEulerDeg(wt, baseEuler=官方 Rz180)` 泛化。

5. **P1-5 / §22-§25 —— 碰撞 STALE 语义**
   - 产品规则：官方 API 无法可靠重变换碰撞几何 → 构建/重建时记录
     `collision.build_params.worldTransformHash`（派发时 API 记录 + worker SUCCEEDED 重写）。
   - 描述符 `RuntimeCollision.stale` = 记录 hash ≠ 当前 hash（恒等/未记录对恒等/未记录 = 一致，
     存量零回归）；`effectiveWalkAllowed = 官方 walkAllowed AND !collisionStale`；
   工具条/诊断/Authoring CollisionPanel 全部接入；CollisionPanel 显示
     `Scene transform changed. Collision must be rebuilt.`。

6. **P1-6 / §13-§15 —— 发布信任根场景级收窄**
   - 前置：信任整个 `<storage>/published/`，跨场景 symlink 可互透。
   - 修复：`SceneAssetService._trusted_roots` = `[scene_root] + published/<scene.id>`
     （`_published_root_for(scene)`）；vite 中间件同步收窄为「本场景
     `scenes/<slug>/versions/*` symlink 的 realpath（限定在 `<storage>/published` 内）」。
     测试：A 自己的版本允许，`published/<B>/…`（含 planted symlink）拒绝。

7. **P1-7 / §16-§17 —— publish bridge repo root**
   - `publish_service._bridge_dev_scene_view` 由 `Path(__file__).resolve().parents[3]` 改为
     `app.core.paths.get_repo_root()`（新共享模块，`pnpm-workspace.yaml` 标记向上查找，
     与 cwd 无关）；同时提供 `get_scene_storage_root()`。全仓库无残留 `parents[N]`。

8. **P2-8 / §26-§28 —— setCameraPose 标注增长**
   - `setCameraPose` 改固定临时 key `__gsplatform_temp_camera_pose__`（复用同一条，
     更新 pose、index 稳定）；已保存视角仍用稳定 `viewpoint:<id>`。
   测试：100 次调用 → 至多 1 条临时隐藏标注。

9. **P2-9 / §29-§30 —— 拾取近似标记**
   - `pickWorldPosition` → `pickApproximateWorldPosition`（文档明示「不保证命中 splat
     表面」，bbox 深度近似）；`ScenePickingAdapter` 接口（`pickApproximateWorldPosition` +
     预留 `pickSurfaceWorldPosition`）；Authoring 拾取态显示「近似锚点」Tag。
   - 未实现 fake 精确拾取（§30 FORBIDDEN 遵守）。

## DEV TUNNEL EXPOSURE

- 隧道默认关闭（`GS_ENABLE_DEV_TUNNEL=1` 才开）；`allowedHosts` 仅 `.trycloudflare.com`。
- 隧道开启 + 空白名单 → 所有 `/local-scenes/*` 403 + 启动 WARNING `NO LOCAL SCENE IS PUBLICLY EXPOSED`。
- 实测：白名单 `local-garden,xr-smoke-test` → `local-garden` 200 / `stream-large` 403；
  隧道关闭 → `local-garden` 200（本地开发不受影响）；编码穿越 `%2e%2e%2f` → 403；`..%2f` → 400/403。

## CACHE POLICY

- `SceneAssetAccessScope` + `build_cache_control(scope, rel_path)` 单一函数。
- nginx：map 纠正（current→no-cache、versions→immutable、manifest 60s、poster 1d）；
  移除 origin 级 `add_header Cache-Control` 覆盖（API 权威）。
- 实测（新代码 API）：PUBLIC current `scene.sog` → `public, no-cache`；PUBLIC 版本化 → `public, max-age=31536000, immutable`；
  PRIVATE current → `private, no-cache`；PRIVATE 版本化 → `private, max-age=31536000, immutable`。

## PRIVATE CACHE SCOPE

- OWNER/SHARE 一律 `private`（测试矩阵含 share 分支：永不 `public`，token 可吊销 → `private, no-cache`）。

## TRUSTED ROOT

- API：`_published_root_for(scene) = <storage>/published/<scene.id>`；`_trusted_roots` 场景级。
- vite 中间件：`versions/*` symlink realpath（限 published 前缀）。
- 测试：A 自己版本允许；A 链解析进 `published/<B>/` 拒绝。

## PUBLISH BRIDGE

- `get_repo_root()` 从任意 cwd 可定位（`test_paths.py`）；`get_scene_storage_root()` 归一化绝对路径。
- `publish_service._bridge_dev_scene_view` 复用共享 helper，删除 `parents[3]`。

## WORLD TRANSFORM RESET

- `baseGsplatTransform` 捕获 + 恒等恢复；合成 `W ∘ base`（位置 = `sceneToRuntimePoint(base.pos)`，
  旋转 = `composeEntityEulerDeg(wt, base.rot)`，缩放按轴相乘）。
- 测试（§21 矩阵）：base 官方 Rz180 → W Ry90 合成 → 恒等恢复 `(0,0,180)`；base 非恒等
  `(5,2,0 / 0,45,0 / 2×)` → 合成 `(25,6,0 / scale 6×)` → 恒等恢复 base 非恒等。

## COLLISION STALENESS

- `collision.build_params.worldTransformHash`：API 派发时记录（`world_transform_hash()` 内容 hash，
  恒等 = None），worker 5th 参数透传并在 SUCCEEDED 重写。
- `CollisionAssetOut.stale`（Authoring API 数据源）+ `RuntimeCollision.stale/worldTransformHash`（描述符）。
- 实测：`scene-ad04357f`（PUBLIC、SUCCEEDED 碰撞、恒等 W）→ `stale:false`；
  设 `world_position=(1,0,0)` → `stale:true`（hash `eb095b4efecc524f`）；还原 → `stale:false`。

## CAMERA POSE LEAK

- `setCameraPose` 固定 key；100 次调用 → 1 条临时标注、select 同一 index（单测）。

## PICKING LIMITATION

- 方法已重命名为 approximate；接口 + 文档 + Authoring「近似锚点」提示；未实现 fake 精确。

## TESTS

| 门禁 | 结果 |
|---|---|
| backend `pytest` 全量 | **208 passed**（含新增 `test_scene_cache` 13 / `test_collision_stale` 8 / `test_paths` 3 / `test_scene_assets` +cross-scene） |
| backend `mypy app` | **Success**（84 files） |
| web `pnpm typecheck` | **0 errors**（`tsc -b --noEmit`） |
| web `pnpm lint` | exit 0（oxlint） |
| web `pnpm vitest run` | **213 passed / 25 files**（含新增 `dev-scene-allowlist` 6、FIX-05 world-transform 2、setCameraPose 增长 1、collisionStale 工具条 2） |
| workers pytest | **13 passed**（`build_collision` hash 透传不回归） |

新增测试覆盖矩阵（§33/§34）：隧道 白名单 允许/拒绝/空白名单；穿越回归；symlink 逃逸回归；
current 不 immutable；版本化 immutable；私有 private；公开 public；share private；跨场景 published 根拒绝；
repo root 任意 cwd；世界变换恒等复位 + base 保持；碰撞构建后变换 → stale；stale → walk 禁用；
重建后恢复；setCameraPose 无标注增长。

## REAL RUNTIME VERIFICATION（§35，live）

| 项 | 实测 |
|---|---|
| 隧道 403/200 | 白名单内 200 / 白名单外 403 / 空白名单全 403 / 关闭隧道本地正常 |
| 私有 current 缓存 | `private, no-cache` |
| 公开 版本化 缓存 | `public, max-age=31536000, immutable` |
| 公开 current 缓存 | `public, no-cache` |
| 世界变换 rotate→reset | 单测矩阵（§21）；live 描述符 stale 翻转/还原（见 COLLISION STALENESS） |
| 碰撞改变 → walk 禁用 | `stale:true` 实测 + 工具条 disabled 单测 |

## NGINX VERIFICATION（§36）

- `nginx:alpine` 容器实跑 `nginx -t`（`/tmp/nginx-test` 挂载树 + 自签证书）：**syntax ok / test successful**。
- 配置文本检查：map `default → "public, no-cache"`（current 不再 immutable）；`versions/` → immutable；
  `scenes-streaming.conf` 已移除 `add_header Cache-Control … always`（API 权威）。

## FILES CHANGED

后端：`app/core/paths.py`（新）、`services/scene_asset.py`（scope/缓存/信任根）、`services/scene_access.py`（cache_scope）、
`services/scene_runtime.py`（stale/版本化 URL）、`services/collision.py`（hash/Stale）、`services/publish_service.py`（repo root）、
`schemas/scene_runtime.py` + `schemas/collision.py`、`api/v1/scene_runtime.py` + `collision.py` + `scene_presentation.py`。
worker：`workers/tasks/build_collision.py`（hash 透传）。
web：`vite.config.ts`（隧道白名单/信任根收窄）、`src/scene-dev/sceneAllowlist.ts`（新）、`scene-runtime/ScenePickingAdapter.ts`（新）、
`SceneTransformAdapter.ts`（compose 泛化）、`SuperSplatRuntime.ts`（复位/固定 key/近似拾取）、`types.ts`、`descriptorResolver` fixture、
`useSuperSplatDesktop/XR`（collisionStale/effectiveWalk）、`OfficialViewerToolbar`/`CollisionPanel`/`AnnotationPanel`/`SceneViewerPage`/
`XRViewerPage`/`XRTestPage`/`SceneAuthoringPage`、`services/collisionApi.ts`。
部署：`deploy/nginx/gsplatform.conf` + `scenes-streaming.conf`。
测试：`test_scene_cache.py` / `test_collision_stale.py` / `test_paths.py`（新）、`test_scene_assets.py` / `test_scene_runtime.py`（扩展）、
`dev-scene-allowlist.test.ts`（新）、`super-splat-runtime.test.ts` / `official-viewer-toolbar.test.tsx`（扩展）。

## KNOWN LIMITATIONS

1. 拾取为 bbox 深度近似（不保证命中 splat 表面）；精确 GPU 拾取是预留接口，未实现。
2. 非恒等世界变换下，官方 runtime 对已构建碰撞的渲染对齐仍受官方能力限制 —— 产品规则以
   STALE + 重建门禁管理（不让用户以为 walk 可用）。
3. 缩放合成在任意旋转下为按轴相乘（对齐轴精确）；当前 base 恒等缩放（1×），实际无偏差。
4. nginx `map` 仅作策略文档/兜底：API 已设置 scope-aware 头，nginx 不再覆盖。

## REMAINING BLOCKERS

无（9 项审计全关闭；无 P0/P1 遗留）。硬件级验收 blocker 见 `PRODUCTION_RUNTIME_ACCEPTANCE.md`：
`XR HARDWARE ACCEPTANCE NOT EXECUTED`（软件 blocker 与本阶段已全清）。

## NEXT STEP

**Real Quest/PICO production XR acceptance**（真机硬件验收；本阶段不自动开始下一阶段）。
