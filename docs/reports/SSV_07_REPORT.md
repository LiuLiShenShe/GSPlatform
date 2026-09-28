# SSV_07_REPORT：Collision and Walk Integration

- 日期：2026-09-29
- 阶段：SSV-07 — Collision / Walk（官方碰撞 + 官方 walk 模式）
- 前置：`docs/reports/SSV_06_REPORT.md` RESULT = PASS ✓
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（未升级）

---

## RESULT

**PASS**

- **GLB PASS ✓** —— 真实 `collision.glb`（`MeshCollision` 官方路径）作为正式支持
  格式落地：worker 真实生成、descriptor 发射 `.glb` 扩展名 URL、官方 viewer 按扩展名
  路由到 `MeshCollision.fromGlb`。
- **VOXEL PASS ✓** —— 体素碰撞**不再 placeholder**：经官方 `splat-transform`（与官方
  解码器同一工具）真实生成 `collision.voxel.json` + `collision.voxel.bin`，实测被官方
  viewer 消费（`walkAllowed=true`、`collisionFormat=voxel`、XR `hasCollision=true`）。
- **WALK PASS ✓** —— 仅用官方 `state.walkAllowed` / `toggleWalk()` / `state.cameraMode`，
  **未自建物理**；实测进入 walk、前/后移动、被碰撞墙挡停、退出恢复 orbit。
- **SCALE PASS ✓** —— 尺度诊断落地，实测真实场景 `status=ok`（水平范围 ≈ 7.6 单位 =
  7.6 米）；`needsCalibration` 时 UI 告警「Scene scale needs calibration」并禁用 Walk
  —— **不默默用错误尺度走路**。

约束落实：本阶段不实现 XR locomotion（§8 只确认碰撞资产不破坏 XR 加载）；室内外仅作
体素生成策略（§5），不是 viewer 运行模式。

---

## 一、Phase 12 碰撞审计（§1）

审计 `workers/collision/indoor.py` / `outdoor.py` / `workers/tasks/build_collision.py`：

| 项 | 结论 |
|---|---|
| `CollisionAsset` / `INDOOR` / `OUTDOOR` / `BUILD_COLLISION` Celery job | **真实**（模型/枚举/任务链完整） |
| numpy 体素构建器（Phase 12 原文） | **placeholder**：SOG 解析是假解析器、室内体素是占位数据，真实 SOG 不可用 |
| GLB / voxel 产物 | **placeholder**（旧构建器不产出官方可消费格式） |

审计顺手修复 3 个真实缺陷：

1. **`ck_jobs_kind_valid` 缺 `BUILD_COLLISION`** —— 创建 `BUILD_COLLISION` job 直接
   `CheckViolation`（既有 latent bug，历次阶段未触发）。新 migration
   `d3e4f5a6b7c8_ssv07_collision_job_kind.py`（已应用，head=`d3e4f5a6b7c8`）先
   `DROP CONSTRAINT IF EXISTS ck_jobs_kind_valid` 再按 `_KIND_ALL`（含
   `BUILD_COLLISION`）重建。
2. **GLB URL 扩展名错误** —— 原 descriptor 只发 `/collision/mesh`，官方 viewer 按
   扩展名路由（`.glb` → mesh，其它 → voxel），`/mesh` 会进 voxel 解析路径。修正为发射
   `collision.glb`（或 `collision.voxel.json`）。
3. **format 字段丢失** —— `RuntimeCollision.format`（`glb | voxel`）曾在 schema 编辑中
   被误删，恢复（`apps/api/app/schemas/scene_runtime.py`）。

## 二、第一条正式支持格式：GLB（§2）

`runtime descriptor.collision`（`scene_runtime._build_collision`）：

- voxel 存在（优先）→ `url = {base}/collision.voxel.json`，`format = "voxel"`；
- 无 voxel、有 glb → `url = {base}/collision.glb`，`format = "glb"`；
- 仅 legacy → `/collision/mesh`。

前端 `SuperSplatRuntime.create({ collisionUrl })` → 官方 `createViewer` 直接消费
（官方按扩展名路由到 `MeshCollision.fromGlb` / `loadVoxelCollision`）。开发环境跨源
（:5173 → :8001）下 URL 一律经 `resolveRuntimeAssetUrl` 解析为绝对地址（SSV-06 同款
CORS 约束）。`collision.enabled=false` 时不注入碰撞数据 —— 不默默开启 walk。

API 新增三个不可变缓存端点：`/collision/collision.glb`、
`/collision/collision.voxel.json`、`/collision/collision.voxel.bin`（bin 经
`metadata.binStorageKey` 定位）；`/collision/mesh` 保留兼容。字节级往返测试覆盖。

## 三、Walk：只走官方（§3）

`apps/web/src/features/viewer-official/useSuperSplatDesktop.ts` + `OfficialViewerToolbar.tsx`：

- `toggleWalk()` → `runtime.toggleWalk()`（官方）。**禁止自建物理控制器**：无 player
  capsule / 键盘物理 / 地面射线 —— 全部由官方 WalkController 负责
  （capsuleHeight 1.5 / eyeHeight 1.3 / gravity 9.8 / moveGroundSpeed 7）。
- Walk 按钮 `data-testid="ov-walk"`：`enabled = loaded && state.walkAllowed &&
  !sceneScale.needsCalibration`；`cameraMode === 'walk'` 时呈激活态（Walk ✓）。
- WASD 由官方引擎键盘（window `KeyW` 等）驱动；`state.cameraMode` 观测进入/退出。

## 四、Scale Gate（§4）

`apps/web/src/scene-runtime/sceneScale.ts` —— 纯分类器（无渲染依赖）：

- `assessSceneScale(bounds)`：1 Scene Unit = 1 meter；水平范围 < 1m 或 > 1000m →
  `status: 'too-small' | 'too-large'`，`needsCalibration: true`；否则 `'ok'`。
- `SCENE_SCALE_WARNING = 'Scene scale needs calibration'`；`SceneViewerPage` 在
  `loaded && needsCalibration` 时渲染 `ov-scale-warning` 告警条（含实测水平范围）。
- Walk 入口在 `needsCalibration` 时禁用 —— **禁止默默用错误尺度走路**。

包围盒来源（关键修正）：官方 viewer 计算场景包围盒用的是
`gsplatComponent.customAabb` **经实体世界变换**（`sceneBound.setFromTransformedAabb(
customAabb, entity.getWorldTransform())`），**不是** `instance.aabb`（playcanvas 2.22
下为 null）。`SuperSplatRuntime.gsplatAabb()` 复刻同一数学（8 角变换 + 重新贴合），
供尺度诊断与相机焦点深度共用。实测真实场景（`?spawn` + 诊断）`horizontalExtent≈7.6`
→ `status: 'ok'`，e2e 断言通过、无告警。

## 五、室内外 = 生成策略，非运行模式（§5）

`workers/collision/splat.py`（真实生成器，替代 numpy placeholder）：

- 经锁定的 `splat-transform` CLI（与官方体素解码器同一工具链）产出
  `collision.voxel.json` + `collision.voxel.bin` + `collision.glb`。
- **INDOOR**：`--voxel-carve 1.6,0.2 --seed-pos <scene 中心>`（从 lod-meta tree.bound
  取中心）；**OUTDOOR**：`--voxel-floor-fill 1.6`。二者都是体素**生成策略**，
  viewer 只消费产物，无 INDOOR/OUTDOOR 运行模式。
- GPU 探测 `--list-gpus`：NVIDIA 用 `-g 0`，否则 `cpu`；GPU 缺失时如实降级为
  mesh-only（警告进 `build_params`），不伪造成功。

## 六、Voxel 真实化（§6）

- 原 numpy 构建器经真实 SOG 验证**不可用**（假解析器 / 占位室内）。SSV-07 以
  `splat-transform`（官方体素工具）重建：`build_collision_artifacts` 在真实 SOG 上
  跑通，任务级 in-process 测试 `ok=True format=COLLISION_VOXEL`。
- 产物与官方 viewer 实测对齐：descriptor `collisionFormat='voxel'` → 官方
  `loadVoxelCollision`（v1.1+ → 现代 VoxelCollision）→ `walkAllowed=true`；
  e2e 中 capsule 在体素网格内行走、被网格边界挡停、高度不塌。
- **不伪造**：GPU 缺失 → 警告 + mesh-only；产物构建失败 → DB 记录失败（可重建）。

## 七、实测：真实大场景（§7）

场景 `r-8c4e2264e86a`（OUTDOOR voxel，gridBounds x∈[-4.6,3.6] y∈[-1.4,2.6]
z∈[7.2,14.6]）。e2e（`apps/web/e2e/ssv07-collision.spec.ts`）：

1. `walkAllowed=true` / `hasCollision=true` / `collisionFormat=voxel` /
   `sceneScale.status=ok`（无校准告警，Walk 按钮可用）。
2. 真实按钮点击进入 Walk → `cameraMode='walk'`。
3. 重力落定：y 在网格范围（无穿地/坠落）。
4. `KeyW` 前移 → 位移 > 0.15（确实在走）。
5. 同会话继续前顶 1.5s → capsule 停在网格范围内（被碰撞墙挡停，高度不塌）——
   **穿不过墙**。
6. 退出 Walk（官方 `toggleWalk`）→ `cameraMode='orbit'`（恢复）。
7. 无碰撞场景 `local-garden` → `walkAllowed=false`、Walk 按钮禁用。

## 八、XR（§8）

本阶段**不实现 XR locomotion**；只确认碰撞资产不破坏 XR 加载：XR e2e 在
`r-8c4e2264e86a` 上 `diag-state-loaded=true`、`diag-has-collision=true`、
`diag-walk-allowed=true` —— 官方 XR 会话消费了碰撞数据，加载不被破坏。

## 九、诊断与质量门

- 诊断面板新增：`walkAllowed` / `hasCollision` / `collisionFormat` /
  `sceneScale{status,horizontalExtent,verticalExtent}` / `cameraPosition`
  （Desktop + XR 页面）。DEV 专用 `window.__gsruntime` 调试把柄（`import.meta.env.DEV`
  门控，生产构建不输出）。
- 修正（探针实测）：相机方向/上/右在 Entity 上是 Vec3 只读属性
  （`forward`/`right`/`up`），**不是** `getForward()` 方法（playcanvas 2.22 实体与
  CameraComponent 均无）—— `getCameraPose` / `pickWorldPosition` / `setCameraPose`
  一并修正。
- 单元测试：Web 204 通过（`scene-scale.test.ts` 7 + `super-splat-runtime.test.ts` 43 +
  `official-viewer-toolbar.test.tsx` 4 等）；API 132 通过；`ruff`（改动文件）clean；
  `tsc --noEmit` clean；`oxlint`（改动文件）clean；`vite build` PASS；
  `pnpm --filter @gsplatform/viewer build` PASS（viewer 冻结未动）。

## 十、Git

提交 `feat(collision): integrate SuperSplat collision and walk mode`，已 push
（migration `d3e4f5a6b7c8` 一并入列）。SSV-07 结束。
