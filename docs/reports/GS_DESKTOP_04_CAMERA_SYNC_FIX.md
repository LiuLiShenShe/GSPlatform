# GS-DESKTOP-04 —— 同会话初始视角同步 & Walk 平台安全闸门

> 任务：GS-DESKTOP-04｜执行日期：2026-10-25｜基线：`0a403e43d9514516084b7630a5cce3429ceaaf28`
> 仓库：`LiuLiShenShe/GSPlatform`｜项目目录：`/fj/GSPlatform`
> 范围：修复「保存初始视角后，同会话官方 Reset 仍回旧视角」这一 P1；建立 Walk 平台安全闸门；
> 附带的 P2（被截断提示 / 保存按钮不醒目 / FOV 输入 / 重复占位符）。
> 硬约束：不调用 `CameraManager` 私有字段、不 monkey-patch 官方 DOM、不拦截 Reset 按钮。

## 0. 结论速览（验收标记）

| 验收标记 | 判定 | 关键证据 |
|---|---|---|
| `SAME_SESSION_CAMERA_RESET` | **PASS** | 保存 B 后不刷新：平台「定位到已保存视角」回 B（误差 < 0.05）；`camera-sync.spec.ts` 6/6 |
| `OFFICIAL_RESET_TARGET_SYNC` | **PASS** | 官方 Settings→Reset 与键盘 `r` 都回 B（同一个 `CameraManager.resetCamera` 闭包目标被重建替换）；真实 GPU 截图 `camera-05/06` |
| `NO_AUTO_CAMERA_JUMP` | **PASS** | 重建后恢复用户保存时的构图（`cameraRestorePoseRef`），GS-DESKTOP-01 13/13；无新增 `frameScene()` |
| `SAVE_FAILURE_ROLLBACK` | **PASS** | 保存失败 → 不重建、不推进同步态、官方 Reset 仍是旧视角；`camera-sync.spec.ts` §5.6 |
| `VERSION_BINDING_SAFE` | **PASS** | 保存期间版本变化 → 明确报错且不同步；GS-NEXT-11/12 e2e 通过 |
| `VIEWER_LIFECYCLE_SAFE` | **PASS** | 一次保存最多一次重建；`create−destroy` 计数与 canvas 数守恒（`camera-sync.json`） |
| `WALK_PLATFORM_SAFETY_GATE` | **PASS** | 不安全时**不注入** collisionUrl ⇒ 官方 `walkAllowed=false`，UI/键盘 3/WASD/宿主 API 四路全封；真实碰撞资产的 safe 场景仍可走 |
| `REAL_GPU_BROWSER_E2E` | **PASS** | headful Chrome + Xvfb :98 + ANGLE/Vulkan（RTX A6000，GPU0）真实截图与相机时间线 |
| `DESKTOP_PRODUCT_READY` | **PASS** | 上表全 PASS；回归见 §7 |

---

## 1. Q1 —— 为什么「保存后同一个会话的 Reset 仍然回旧视角」？

复现（真实数据，任务书 A/B/C）：

```
A = [2.5, 1.8, 6.0]      B = [3.7083, 0.7145, 2.5372]      C = [1.2420, 1.7603, 4.1609]
A → 移动到 B → 保存 → 移动到 C → Reset
错误行为：Reset 回 A（旧）
正确行为：Reset 回 B（刚保存的）
刷新页面后才正确
```

根因在锁定版本 `@playcanvas/supersplat-viewer@1.35.0` 的 `CameraManager`：

```js
// dist/viewer.js:6159-6165（构造时执行一次）
const camera0 = settings.cameras[0]?.initial;
const resetCamera = camera0
    ? createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov)
    : frameCamera;
...
// dist/viewer.js:6211
this.camera.copy(resetCamera);          // 初始相机就是 resetCamera
```

`resetCamera` 是一个**构造期闭包常量**。平台保存初始视角只写 `scene_presentations`，
当前页面的 `settings.cameras[0].initial` 与这个常量都不会变 —— 所以：

- 平台按钮「定位到已保存视角」调 `runtime.resetCamera()` → 走官方 `inputEvent 'reset'`；
- 官方 UI Reset、键盘 `r` 也走同一个 `inputEvent 'reset'`；
- 三者最终都 `controllers.orbit.goto(resetCamera)`，也就是**页面加载那一刻**的 pose。

刷新后正确，是因为新页面用新的描述符重新构造了 `CameraManager`，常量随之更新。
这正是任务书 §13 明令判 FAIL 的「刷新后才正确」模式。

## 2. Q2 —— 官方 1.35.0 有受支持的「运行时更新初始相机」接口吗？

**没有。** 公开句柄（`dist/viewer.js:11643-11660`）只有：

```
app, state, events, annotations,
captureFrame, seek, frameScene, resetCamera, toggleWalk,
selectAnnotation, setMoveInput, requestFullscreen, exitFullscreen,
startXR, endXR, destroy
```

- 没有 `updateSettings()` / `setSettings()` / `setInitialCamera()` / `getCameraManager()`；
- `settings` 只在创建时读入，`CameraManager` 是 `viewer` 实例内部字段，不在句柄上；
- `state` 是官方可观察状态（`walkAllowed` 等），改它不会改变 `resetCamera` 常量，
  且任务书禁止直接改官方只读状态。

`createViewer` 也没有「注入外部 graphics device」的选项（`dist/viewer.js:11376-11388` 内部
自行 `createGraphicsDevice`），所以也无法通过共享设备做轻量重建。

## 3. Q3 —— `resetCamera()` 到底是什么意思？

```js
// dist/viewer.js:11055
resetCamera() {
    this.requireLoaded('resetCamera');
    this.global.events.fire('inputEvent', 'reset');
}
// dist/viewer.js:6302
case 'reset':
    if (state.cameraMode === 'walk') { ...controllers.walk.resetToSpawn(target); }
    else if (state.cameraMode === 'fly') { ...controllers.fly.resetToSpawn(target); }
    else { events.fire('orbitTarget:clear'); state.cameraMode = 'orbit';
           controllers.orbit.goto(resetCamera); startTransition(); }
```

即：**回到 `CameraManager` 构造时固化的那一台相机**（orbit 模式下就是 `resetCamera`），
walk/fly 模式回各自的 spawn。它不是一个可以传参的「设置相机」接口。

## 4. Q4 —— 官方 UI Reset / 键盘 Reset / 宿主 `resetCamera()` 共用状态吗？

**完全共用。** 三条入口汇聚到同一个 `inputEvent 'reset'`：

| 入口 | 源码位置 | 行为 |
|---|---|---|
| 官方 Settings 面板 Reset | `dist/viewer.js:3111-3136`（`.sse-reset` → `onReset` → `viewer.resetCamera()`） | `fire('inputEvent','reset')` |
| 键盘 `r` | `dist/viewer.js:7203`（`case 'r': events.fire('inputEvent','reset')`） | 同上 |
| 宿主 `runtime.resetCamera()` | `dist/viewer.js:11055` | 同上 |

因此「只修平台按钮」在架构上不可能完整：**必须让 `CameraManager` 的构造期目标变化**，
否则官方两条入口永远是旧视角。反过来说，只要重建一次 Viewer，让新的
`settings.cameras[0].initial` 生效，三条入口会**同时**正确 —— 这也是本轮选择的路线。

## 5. Q5 —— 能不能在不销毁 Viewer 的前提下更新初始相机？

在官方公开 API 内**不能**。可选的「假办法」都被任务书禁止，而且确实会让某个入口继续错：

| 方案 | 结论 |
|---|---|
| 写 `CameraManager` 私有字段 / 改 `resetCamera` 闭包 | 禁止（未公开内部字段）；且 `settings` 与常量不同步 |
| 拦截/改写官方 Reset 按钮的 DOM 事件 | 禁止（monkey-patch DOM 伪装修复）；键盘 `r` 仍错 |
| 只修平台按钮（自绘相机跳转） | 不完整：官方两类 Reset 仍回 A，任务书明确判不通过 |
| 每次 Reset 前注入新的 `selectAnnotation` 过渡 | 会污染标注选择态，且键盘 `r` 仍走 `resetCamera` |
| **受控重建 Viewer（重读描述符 → 新 settings → 新 CameraManager）** | 官方唯一受支持的路径，三条入口一起正确 |

## 6. Q6 —— 修复实现与「重建纪律」

### 6.1 纯规则层（可单测）

- `apps/web/src/scene-runtime/initialCameraSync.ts`
  - `initialCameraKey(descriptor)`：描述符初始相机的稳定 key；
  - `savedViewMatchesDescriptor(saved, descriptor, 1e-4)`：后端是否真的采用了刚保存的视角；
  - `createInitialCameraSync().evaluate(saved, descriptor)`：
    `'resync-needed' | 'already-synced' | 'ignored'`（ignored = 后端没采用，绝不重建）；
  - `adopt(descriptor)`（Viewer 装载完成时记录当前 Reset 目标）、`markSaveFailed()`。
- 单测：`src/__tests__/initial-camera-sync.test.ts`（16 项）。

### 6.2 页面层（`SceneAuthoringPage.tsx`）

```
保存按钮 → setInitialView(pose)            // PATCH /presentation（后端唯一真相）
        → verifyInitialViewUsed(pose)     // 回读 /runtime 描述符，确认「真的采用」
        → syncInitialCameraIfNeeded()     // evaluate → 需要才重建（一次）
        → setCameraResyncKey(k+1)         // 只由保存路径递增，绝不由轮询/其他 state 驱动
```

重建时（同一个 effect）：

1. `cameraRestorePoseRef` 记录用户当时所在视角（与保存目标不同才记录）；
2. 销毁旧 `SuperSplatRuntime`（官方 `destroy()` 自己释放 engine / gl / wgpu / listener / 子树）；
3. 用**新描述符**重建 → `applyWorldTransform` + `applyInitialCameraPolicy`（`resetCamera`），
   此时 `CameraManager` 的 Reset 目标 = 新保存的视角；
4. 通过官方公开的 `setCameraPose()`（内部走 annotation 过渡）恢复用户视角 —— **不写官方内部状态**；
5. 全程有明确反馈：面板 `camera-sync-progress`（进行中）、`camera-sync-failed` + 「重新同步」按钮
   （失败），`Modal.success` 明确说明「已保存，正在同步，官方 Reset 目标会一起更新」。

**一次保存最多一次重建**（`syncedKey` 去重 + `lastSavedPayloadRef` 同签名 no-op），
不会因为 `settingsRevision` / 轮询 / 其他 state 进入重建循环。

### 6.3 本轮发现并修掉的「二次保存」缺陷（重建循环的真实来源）

排查 GS-DESKTOP-01 ⑬ 时发现：**一次点击保存会产生 2 个 PATCH、2 次重建、2 个成功弹窗**，
在「切换历史 SceneVersion 后再保存」时必现。

根因（锁定版本行为，用真实浏览器取证）：

```
@playcanvas/pcui 6.1.4 NumericInput.value setter → _updateValue() → emit('change')
@playcanvas/pcui/react Element.componentDidUpdate 每次渲染都会把 value prop 赋回元素
        （它对 value 设了 _suppressChange，但只有 SliderInput / SelectInput 读这个标记）
→ 保存后 presentation.initialCameraFov 回填（47 → 85）
→ FOV 输入框 emit('change', 85) → 宿主当成用户改 FOV → 再保存一次 → 再重建一次
```

另一个同源问题：`onChange` 只在挂载时绑定一次，闭包永远停在挂载时的 state（与 `PcuiButton` 同一个坑）。

修复（宿主适配层，不改官方源码）：

- 新增 `apps/web/src/features/authoring/pcui/PcuiNumericInput.tsx`：
  最新闭包代理 + **prop 回显抑制**（与本次渲染的 prop 值相同的事件不向上转发）；
- 相机/世界方向/标注/视角的 NumericInput 全部改用它；
- 保存链路增加「同版本 + 同 pose」签名去重（`lastSavedPayloadRef`），一次用户动作最多一次写入/重建；
- 单测：`src/__tests__/pcui-numeric-input.test.tsx`（3 项：回显抑制 / 真实输入转发 / 最新闭包）。

## 7. Q7 —— Walk 平台安全闸门（§六）

### 7.1 官方逻辑

```js
// dist/viewer.js:6121-6128
const WALK_MIN_HORIZONTAL_RANGE = 5;
const isWalkAllowed = (bbox, collision) =>
    !!collision && x * 2 >= 5 && z * 2 >= 5;

// dist/viewer.js:6337（键盘 3 / 官方按钮 / 宿主 toggleWalk 共用）
case 'toggleWalk': if (walkAllowed) { ... }
// dist/viewer.js:7186 / 6334（WASD）
case 'requestFirstPerson': state.cameraMode = walkAllowed ? 'walk' : 'fly';
// dist/viewer.js:10930（collision 附件完成时重算）
state.walkAllowed = isWalkAllowed(sceneBound, collision);
```

官方**只看**「有 collision 对象 + 水平包围盒 ≥ 5 单位」，不关心平台的物理尺度是否可信。

### 7.2 平台闸门（唯一权威）

`apps/web/src/scene-runtime/walkSafetyPolicy.ts`：

```
decideWalkSafety({descriptor, officialHasCollision?, sceneScale?})
  → { safe, reason, collisionEnabled, collisionStale }
reason 顺序：no-collision → collision-disabled → collision-stale →
             collision-url-missing → collision-not-attached →
             scene-scale-uncalibrated → ok
```

真正生效的不是隐藏按钮，而是 **`resolveWalkCollisionUrl()`：不安全时根本不向官方注入
`collisionUrl`**。没有 collision 对象 ⇒ 官方 `isWalkAllowed(bbox, null) === false` ⇒
`walkAllowed` 为 false ⇒ **官方自己**拒绝 UI 按钮、键盘 `3`、WASD、宿主 `toggleWalk()`。
隐藏按钮/加 CSS class 只是提示，不是闸门（任务书明确「不能只隐藏按钮」）。

创作页预览与 `/scene` 浏览页共用同一份规则（`useSuperSplatDesktop.ts` 与
`SceneAuthoringPage.tsx` 都走 `decideWalkSafety`）。若加载后才发现尺度诊断不通过，
做**一次**受控重建并**不再注入**碰撞（`collisionSuppression`，sceneId 作用域，仅 false→true 一次，
不会循环）。

### 7.3 三套隔离夹具（真实碰撞资产）

`scripts/gsdesktop04_seed_walk_fixture.py` 用锁定版 `splat-transform` 在**真实内容**上生成
`collision.voxel.json` + `.voxel.bin` + `collision.glb`（真实 donor：`gsdesktop01-versions`
的 streamed-SOG，水平包围盒 7.61 × 6.89 ≥ 5，**官方逻辑本来会给出 walkAllowed=true**）：

| 夹具 | 平台判定 | 期望 |
|---|---|---|
| `gsdesktop04-walk-safe` | 校准 VERIFIED + 碰撞有效 | 四路入口都能进入 walk |
| `gsdesktop04-walk-stale` | 碰撞 STALE（worldTransformHash 与当前不符） | 四路都进不去 |
| `gsdesktop04-walk-uncalibrated` | 校准 UNVERIFIED（`physicalWalkAllowed=false`） | 四路都进不去 |

这就是任务书要求的「官方说可走 / 平台认为碰撞不可信」组合。

## 8. Q8 —— 验收证据（§五 / §八）

### 8.1 改动清单

| 文件 | 类型 | 作用 |
|---|---|---|
| `src/scene-runtime/initialCameraSync.ts` | 新增 | 同步规则纯函数（key / 匹配 / evaluate / adopt） |
| `src/scene-runtime/walkSafetyPolicy.ts` | 新增 | Walk 安全闸门纯函数 + `resolveWalkCollisionUrl` |
| `src/features/authoring/pcui/PcuiNumericInput.tsx` | 新增 | PCUI NumericInput 宿主适配（最新闭包 + prop 回显抑制） |
| `src/pages/SceneAuthoringPage.tsx` | 修改 | 保存 → 回读确认 → 单次受控重建 → 姿态恢复；同签名去重 |
| `src/features/authoring/pcui/AuthoringWorkspace.tsx` | 修改 | FOV/世界变换改 `PcuiNumericInput`；同步状态与重试入口；按钮强调类 |
| `src/features/authoring/pcui/{AnnotationProperties,ViewpointProperties,PcuiButton}.tsx` | 修改 | 同上 + PCUI `class` 单 token 修正 + 重复占位符改为 hint 文案 |
| `src/features/viewer-official/useSuperSplatDesktop.ts` / `useSuperSplatXR.ts` | 修改 | 共用 `decideWalkSafety`，不安全时不注入 `collisionUrl` |
| `src/index.css` | 修改 | 长提示换行不截断；主操作强调；侧栏激活项整宽 |
| `src/__tests__/initialCameraSync*.ts`、`walk-safety-policy.test.ts`、`pcui-numeric-input.test.tsx` | 新增 | 单测 |
| `e2e/gsdesktop04-camera-sync.spec.ts` | 新增 | §五 14 场景（6 个用例覆盖） |
| `e2e/gsdesktop04-walk-safety.spec.ts` | 新增 | §六 三夹具 × 四入口 |
| `e2e/gsdesktop04/run.mjs` | 新增 | 真实 GPU 取证（相机时间线 + 截图 + 生命周期） |
| `scripts/gsdesktop04_seed_walk_fixture.py` | 新增 | 真实碰撞资产生成（splat-transform 锁定版） |

后端**零改动**（无新迁移、无模型字段变更）。

### 8.2 自动化测试

| 关卡 | 结果 |
|---|---|
| `vitest run`（web） | **412 passed / 40 files** |
| `tsc --noEmit` | **0 error** |
| `vite build` | **ok** |
| `oxlint` | 9 warning（全部为未触碰文件里的既有告警，新增文件 0） |
| `pytest`（后端，隔离库 `gsplatform_vr00_clean_20261011`，独立 storage/origin/redis db） | **629 passed / 630（1 failed = 既有缺陷）**，见 8.2.1 |

#### 8.2.1 后端 pytest 说明

结果：**629 passed / 630**，唯一失败
`tests/test_editor_publication.py::test_export_retention_preserves_current_and_history`
（`assert 0 == 1`，导出保留清理计数）——这是**既有缺陷**，与本轮改动无关
（本轮后端零改动，该用例在基线提交上同样失败，历史全量回归记录中也是唯一失败项）。

后端测试**不写 e2e 共享库**：本轮用 `gsplatform_vr00_clean_20261011`（未被任何进程使用）
+ 已迁移到 head 的 schema + `/tmp` 下的独立 `GS_STORAGE_ROOT` / `GS_SCENE_ORIGIN_ROOT` /
独立 Redis db 运行。原因：上一轮 pytest 直接打到 dev/e2e 共享库，留下 **5944 个
`celery-%` 桩任务（BUILD_COLLISION / QUEUED）**，按产品规则会正确阻塞版本切换
（`场景仍有正在运行的任务`），导致 GS-NEXT-11 e2e 出现 409 假失败。桩任务已按
「只删 QUEUED/RUNNING 的 `celery-%` 记录及其 QUEUED 碰撞资产」清理，历史
SUCCEEDED/FAILED 记录保留，`gsnext11-versions` / `gsdesktop01-versions` 活动任务归零。

#### 8.2.2 E2E

| 套件 | 结果 | 用时 |
|---|---|---|
| `gsdesktop04-camera-sync.spec.ts`（本轮新增，§五 14 场景） | **6/6 passed** | 22.0m |
| `gsdesktop04-walk-safety.spec.ts`（本轮新增，§六） | **4/4 passed** | 34.8s |
| `gsdesktop01-camera-stability.spec.ts`（GS-DESKTOP-01 回归） | **13/13 passed** | 6.9m |
| `gsdesktop02-official-ui.spec.ts`（GS-DESKTOP-02 回归） | **13/13 passed** | 8.9m |
| `gsnext11-version-management.spec.ts`（版本回滚回归） | **2/2 passed** | 13.2s |
| `gsnext12-spatial-reauthor.spec.ts`（空间重新绑定回归） | **1/1 passed** | 33.3s |
| `gsdesktop03/run.mjs 3`（旧取证脚本 save-reset） | **通过，且行为已随修复改变** | — |

GS-DESKTOP-03 phase 3 的实测输出（修复前该脚本记录的是「同会话 reset 回旧 A」；
本轮原始输出见 `gsdesktop04-evidence/gsdesktop03-phase3-after-fix.txt`，
`gsdesktop03-evidence/` 下的历史证据**保持修复前状态、未覆盖**）：

```
[B-after-drag]                      cam=[4.423743724822998,-0.2227041870355606,-0.346047580242157]
[modal:save-initial-view]           已保存（初始视角已更新…正在把新初始视角同步到当前 Viewer…）
db after save  initialCameraPosition={x:4.423743724822998,y:-0.2227041870355606,z:-0.346047580242157}
[reset-without-reload]              cam=[4.423743724822998,-0.2227041870355606,-0.346047580242157]
[official-reset-without-reload]     cam=[4.423743724822998,-0.2227041870355606,-0.346047580242157]
after reload reset: errToB=0.000  errToA=2.093
```

即 DB 写入值、同会话平台 Reset、同会话官方 Reset、刷新后 Reset **四者完全一致**。

#### 8.2.3 gsdesktop02 的用例 D 契约已按 §三 修订

GS-DESKTOP-02 用例 D 原本断言「保存后 Viewer 不重建」——那是 GS-DESKTOP-04 之前
的契约。本轮按任务书 §三 改为「保存后最多一次受控重建，且必须回到用户视角」：
断言目标从「实例不变」改为「新实例就绪 + ``建/毁计数守恒 + 视角等于保存时的视角」。
同时补了 `pumpFrames()`（手动 `app.tick`），因为 headless-shell 在后台标签页
会冻结 rAF。

### 8.3 相机时间线（真实 GPU，`camera-sync.json`）

场景 `fix02-semantics`（单文件 SOG，authored 初始相机 + 3 标注 + 1 视角），
headful Chrome + Xvfb :98 + ANGLE/Vulkan（RTX A6000，GPU0）：

| 步骤 | position | target | fov |
|---|---|---|---|
| loaded（A） | `[2.5, 1.8, 6.0]` | `[-0.01570, 0.59246, -0.03768]` | 47 |
| 拖到 B | `[5.64303, 0.59538, 3.44183]` | `[0.01654, 0.59999, 0.01009]` | 47 |
| 保存同步后 | `[5.64303, 0.59538, 3.44183]` | 同上 | 47 |
| 拖到 C | `[1.83766, 2.30127, 6.11119]` | `[-0.00861, 0.57650, -0.07414]` | 47 |
| **官方 Settings Reset** | `[5.64303, 0.59538, 3.44183]` | 同上 | 47 |
| **键盘 `r` Reset** | `[5.64303, 0.59538, 3.44183]` | 同上 | 47 |

```
deltaB_afterSave  = 0
deltaB_afterReset = 0
deltaB_afterKey   = 0
deltaA_afterReset = 4.2149      ← Reset 没有回到旧视角 A
```

方向与 FOV 同样一致（target 完全相等、fov 47 保持不变），满足「位置误差 < 0.05 +
方向 + FOV」三项。等待方式为**姿态收敛轮询**（`page.waitForFunction` 比对新目标
+ `pumpFrames`），不是固定 1s。

### 8.4 Viewer 生命周期（同一轮真实 GPU 取证）

```
lifecycle    = { created: 2, destroyed: 1 }   ← 初始 1 + 保存触发 1，旧实例被销毁
lifecycleLive= { viewers: 1, canvases: 1 }    ← 没有残留 canvas / WebGL context
pageErrors   = []                             ← 无异常
consoleErrors= 2 项（antd Drawer width / Modal static 的既有弃用告警，与本次无关）
```

e2e 侧 `§5.10/12` 用例在多次保存后断言 `created - destroyed === 1` 且
`canvas` 数量不增长，6/6 通过。

> 取证脚本早期版本有一条 `TypeError: … reading 'appendChild'`：`addInitScript`
> 在 `documentElement` 之前执行。已修（等 `readystatechange` 再注入缩短动画的
> style），重跑后 `pageErrors` 为空。该错误只影响取证脚本，不影响产品。

### 8.5 Walk 闸门证据（真实 GPU，`walk-gate.json`）

三套夹具都注入了**真实碰撞资产**（`collision.voxel.json` + `.voxel.bin` +
`collision.glb`，由锁定版 `splat-transform` 从真实内容生成；水平包围盒 7.61 × 6.89 ≥ 5，
**官方原始逻辑本应判定 `walkAllowed=true`**）：

| 夹具 | 平台判定 | 官方 `walkAllowed` | 官方 UI 按钮可见 | 键盘 `3` | UI 按钮(force) | 宿主 `toggleWalk()` | cameraMode 真的变 walk |
|---|---|---|---|---|---|---|---|
| `walk-safe` | 校准 VERIFIED + 碰撞有效 | true | true | ✔ | ✔ | ✔ | **true** |
| `walk-stale` | 碰撞 STALE | **false** | **false** | ✘ | ✘ | ✘ | **false** |
| `walk-uncalibrated` | 校准 UNVERIFIED | **false** | **false** | ✘ | ✘ | ✘ | **false** |

`hasCollision=false` 出现在 stale/uncalibrated 行，是因为平台根本不注入
`collisionUrl` ⇒ 官方 `isWalkAllowed(bbox, null) === false`。**没有隐藏按钮了事，
也没有改官方只读状态**：安全闸门在「是否把碰撞资源交给官方」这一层生效。
「合法校准场景仍可走」由 `walk-safe` 行证明。

### 8.6 截图（`docs/reports/gsdesktop04-evidence/`）

| 文件 | 内容 |
|---|---|
| `camera-01-loaded-A.webp` | 加载完成，authored 初始视角 A |
| `camera-02-at-B.webp` | 拖到 B（保存前） |
| `camera-03-after-save-sync.webp` | 保存并同步后，视角仍在 B（没有跳远） |
| `camera-04-at-C.webp` | 拖到 C |
| `camera-05-official-reset.webp` / `camera-05-official-reset-render.webp` | 官方 Settings → Reset 后回到 B，含真实 Gaussian 渲染帧 |
| `camera-06-keyboard-r-reset.webp` | 键盘 `r` 后回到 B |
| `walk-{safe,stale,uncalibrated}-01-loaded(-render).webp` | 三夹具加载态 + 真实渲染 |
| `walk-*-02-after-key-3.webp` / `-03-after-ui-button.webp` / `-04-after-host-toggle.webp` | 三个官方入口逐一取证 |

（`.webp` 是从页面 canvas `toDataURL` 抓的真实渲染帧，非 DOM 截图伪造。）

### 8.7 已知环境限制（如实记录，不影响判定）

1. **headless SwiftShader 第二次 `requestAdapter()` 需要 112–400s**：保存触发重建后，
   headless 环境下新设备申请极慢（真实 GPU 上为亚秒级）。因此 e2e 的同步收敛预算
   设为 `SYNC_CONVERGE_MS = 600_000`，且用**条件轮询**而非固定睡眠。
2. **headless 下 antd 弹窗离场动画不结束**（`animationend` 不触发，遮罩残留）：
   e2e 里只把动画时长压到 1ms，不改业务 DOM/逻辑。
3. **GS-DESKTOP-03 的 `phase 3` 脚本**记录的是修复前行为；本轮跑通后输出已变为新行为，
   旧断言（若有硬编码）需按 8.2.2 的新输出理解。

### 8.8 复现命令

```bash
# 单测 + 静态检查
cd apps/web && npx vitest run && npx tsc --noEmit
# 新增 E2E（需要 dev API :8001 + vite :5173 + 隔离夹具）
cd apps/web && npx playwright test e2e/gsdesktop04-camera-sync.spec.ts e2e/gsdesktop04-walk-safety.spec.ts --workers=1
# 真实 GPU 取证
Xvfb :98 -screen 0 1920x1080x24 &
cd apps/web && DISPLAY=:98 node e2e/gsdesktop04/run.mjs all
# Walk 夹具重建（真实碰撞资产）
python3 scripts/gsdesktop04_seed_walk_fixture.py
```

### 8.9 交付信息

- 分支：`main`（基线 `0a403e43d9514516084b7630a5cce3429ceaaf28`）
- 提交：`2ac119a1ff3d1b93e3c9d10ec47295b1a67a6fe5`
  （`fix(web): GS-DESKTOP-04 同会话初始视角同步官方 Reset + Walk 平台安全闸门`）
- 未改动：历史 13M 原始 PLY、已发布 SceneVersion、生产 current 指针；未占用 GPU1。

