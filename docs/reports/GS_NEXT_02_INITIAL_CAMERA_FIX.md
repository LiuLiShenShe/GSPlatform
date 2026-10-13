# GS-NEXT-02 —— 初始视角修复与默认性能模式（软件收口报告）

> 任务：GS-NEXT-02｜日期：2026-10-13｜基线 HEAD：`f99d80d`
> 触发：真实 PICO Neo3 复测 —— **A 组 PASS**（WebXR / 双目 / 6DoF / 基础交互）；
> **B 组 FAIL**（网页创作页设置初始视角后，重新进入场景仍是原来的远景鸟瞰，用户希望
> 进入场景内部）；**C 组**（Performance Mode 降低显示 Gaussian 数）。
>
> **本报告只声明软件可验证的结论。** 真机出生点是否因此正确，必须由随后的 PICO Neo3
> 复测确认（见 §10）。

---

## 1. 任务目标与成功标准

| 项 | 内容 |
| --- | --- |
| 必须修复 | 用户保存的初始视角在被重新打开的场景中**真的生效**（B 组） |
| 必须修改 | Performance Mode **默认 ON**（Desktop / XR 一致，C 组） |
| 硬约束 | 不升级依赖；不 Fork 官方 Viewer；不重写官方 CameraManager；不建第二套相机系统；不硬编码相机偏移；不重写官方 Gaussian Budget / LOD / 渲染器；不为切换性能模式重建 Viewer |
| 数据保护 | 历史 13M Gaussian 的 PLY、SceneVersion 与 2,076 个发布资产**完全不变**；不重新过滤 / 转换 / 发布 / 覆盖 |
| 禁止 | `reset --hard`、`git clean`、force push；不触碰其他工作者改动；不制造 PASS |

**成功标准（原文）**：不是测试通过，而是用户真正保存一个近距离初始视角后，重新打开场景
能够恢复该位置；在 PICO 中能否正确出生则由随后的真实头显复测最终确认。

---

## 2. 真机现象与既有自动化测试的关系（为什么不能拿旧测试否定用户）

FIX-02 的 6 条 Playwright 用例**全部通过**，但它们全部运行在 **`fix02-semantics` 这个
精心构造的夹具场景**上（DB 里已有 authored 相机 `[2.5,1.8,6]`/fov 47、3 条带相机的标注、
1 个视角点）。它们证明的是「**已经存在**的 authored 相机能被正确采用」，**完全没有覆盖**
「用户在创作页**新保存**一个视角后，它是否真的落库并对下一次打开生效」。

因此旧测试通过 ≠ 用户的问题不存在。本任务按用户要求，先造一个**独立的可复现环境**
（隔离数据库 + HEAD 代码 + 真实浏览器），再分阶段定位失败点。

---

## 3. 复现环境（与生产代码等价，不改动共享资源）

| 组件 | 配置 |
| --- | --- |
| 隔离数据库 | `gsplatform_gsnext02`（alembic `cd03ef05ab06` = head） |
| HEAD API | `127.0.0.1:18002`（`GS_ENV=development GS_DEV_IDENTITY_ENABLED=true`） |
| 前端 | vite dev `:5173`（`GS_API_PROXY_TARGET=http://127.0.0.1:18002`），源码 = 当前工作区 |
| 场景夹具 | `gsnext02-cam`（无 authored 相机）+ `fix02-semantics`（从 dev 库原样镜像） |
| 真实浏览器 | Playwright / 每用例独立 Chromium + SwiftShader（`e2e/fresh-browser.ts`） |

**发现（环境事实，值得记录）**：共享 dev 库 `gsplatform` 落后 head **2 个迁移**，
缺 `scene_spatial_states` 表。HEAD 代码访问该库会对任何场景加载抛
`UndefinedTable`。因此所有**忠实于 HEAD 的验证都在隔离库上完成**；dev 库未做任何迁移。

---

## 4. 分阶段根因定位（任务要求的 8 个环节逐一判定）

复现按「创作页读取 → 动画中途捕获 → 保存 API → DB 持久化 → 描述符 → ExperienceSettings
映射 → 官方 CameraManager 恢复 → XR 首帧 Rig 对齐」链路逐段测量：

| # | 环节 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 创作页读取相机 | **正常** | `getCameraPose()` 返回的 RUNTIME 位姿经 adapter 换算回 SCENE 空间，与 PATCH 落库值一致（误差 ~1e-4） |
| 2 | 抓拍时机落在官方动画中途 | **排除** | 探针在 t≈0/1s/3s/8s/20s 采样：`cameraMode='orbit'`，位姿在 20s 内**逐位不变**（见 §5） |
| 3 | 保存 API（PATCH `/presentation`） | **缺陷（读己之写竞态）** | PATCH 返回 200 且响应体是新值；**紧接着**的 GET 仍返回旧值，约 0.5s 后才收敛。见下方实测 |
| 4 | DB 持久化 | **正常** | 隔离库/迁移到 head 的库上，保存值经独立会话立即可读（新增后端测试锁定） |
| 5 | 运行时描述符（`/runtime`） | **缺陷（STALE 有意丢弃）** | 空间状态为 `STALE` 时描述符**有意**把 `initialCamera` 置空，而 `/presentation` 仍有值 → 「面板显示已保存、每个场景打开却仍是官方取景」 |
| 6 | ExperienceSettings 映射 | **正常** | `buildExperienceSettings` → `settings.cameras[0].initial` 与描述符逐字段一致（单元 + 夹具测试） |
| 7 | 官方 CameraManager 恢复 | **正常** | `resetCamera()` 后相机精确落在 authored 位姿（`dist < 5e-5`），**不被自动动画覆盖** |
| 8 | XR 首帧 Rig 对齐 | **缺陷（零值位姿对齐）** | 原实现在 WebXR tracking 尚未可用（头部位姿为零值）时即一次性写入 Rig，此后永不修正 → 出生点/朝向算错 |

### 4.1 环节 3 实测（旧构建 `:8001` 上现场复现）

```text
PATCH /presentation {initialCameraPosition: {2.5,1.8,6}, ...} → 200
响应体: initialCameraPosition = {x:2.5, y:1.8, z:6.0}, fov 47     ← 新值
紧接着 GET /presentation
      : initialCameraPosition = {x:0.2, y:0.55, z:0.4}, fov 71     ← 旧值！
t+0.5s: {x:2.5, y:1.8, z:6.0} fov 47                              ← 收敛
```

**根因**：`get_db_session` 是 `yield` 依赖，其 `commit()` 在**响应发送之后**的 teardown
才执行。创作页的保存链路恰好是「PATCH → 递增 `settingsRevision` → 立刻重新解析描述符并
重建预览」，因此预览会读到旧值并用旧值重建 —— 用户的观感正是「刚设好的视角又跳回远景」。
若此刻复查，DB 里是**新值**，于是外部怎么看都像"没问题"。

### 4.2 环节 5 的位置（第二个、永久性的成因）

`apps/web/src/scene-runtime/initialCameraPolicy.ts` 记录的既定语义：描述符在
`SceneSpatialState.state == 'STALE'` 时**有意**丢弃 `initialCamera`/`worldTransform`/
视角点/标注（几何变更后旧相机姿态已无意义）。但创作页面板读的是 `scene_presentations`
**活表** —— 于是面板说"已保存"，而所有场景加载都走官方 `frameScene()` 鸟瞰。
这就是 B 组现象的**永久形态**。本任务不猜测 STALE 的成因，而是让创作页**如实报告**
这种分叉（见 §6）。

### 4.3 用户真实场景的物证（为什么 B 组必然复现）

对 dev 库全量统计：

| 事实 | 数值 |
| --- | --- |
| `u-*` 用户上传场景总数 | **555** |
| 其中 `initial_camera_position` 为 NULL 的 | **555（100%）** |
| 全库带 authored 相机的场景 | 164 |
| 其中为**同一个硬编码常量** `{0,1.2,3.5}/{0,0.8,0}/55` 的 | **163** |
| 唯一一个真正用户设定的 authored 相机 | `fix02-semantics`（即 FIX-02 夹具本身） |

即：**全库没有任何一个真实用户成功保存过初始视角**，且历史的 163 个"相机"全部是
`workers/pipeline/convert_scene.py:300` 写进每个 manifest 的**硬编码常量**（`§7` 判定为
不可用作"自动推荐"）。这从数据侧印证了 §4.1/§4.2 的机制：保存从未真正对用户生效。

---

## 5. 场景包围盒 / 相机焦点：AABB 假说的实证否定

任务 §3 提出过一个合理怀疑：`getCameraPose()` 的 target 距离由整场景 Gaussian AABB 中心
估算，历史大场景包围盒极端/离群 → 可能污染保存的视角。

**实测结论：该假说对「位置与朝向」不成立，已否定。** 对同一已保存位姿人为改变保存时的
target 距离：

| 保存时 target 距离 | 重开后位置误差 | 朝向 |
| --- | --- | --- |
| 0.001 | 0.009（仅因官方 orbit `zoomRange.x = 0.01` 夹取） | 正确 |
| 1.0 | 0 | `forwardZ = 1.0` |
| 1e7 | 0 | `forwardZ = 1.0` |

结论：**target 距离不参与位置恢复**，官方 `Camera.look(from,to)` 只写入 position 与方向。
因此**没有**为此新增任何薄适配层，也**没有**触碰官方 CameraManager —— 优先级排序中的
「用官方相机状态替代 AABB 估算」在本任务中没有必要（避免为不存在的问题加抽象）。

参考基线（无 authored 相机时官方 `frameScene()` 产物）：位置 `(1.70, 0.35, 1.71)`、
fov 85，场景 AABB `[-1,-1.499,-0.982]..[1,0.499,0.996]`。

---

## 6. 修复内容（按任务 §4 优先级执行）

### 6.1 优先级 1：已保存的用户初始视角最高

| 文件 | 修复 |
| --- | --- |
| `apps/api/app/services/authoring.py` | `update_presentation` 由 `flush()` 改为**返回前 `commit()`** —— 保存对**下一次读**立即可见（消除 §4.1 竞态）。依赖 teardown 的后续 commit 变为 no-op |
| `apps/web/src/features/authoring/useSceneAuthoring.ts` | `savePresentation` 失败时**回滚乐观更新**（重新拉取服务器值再抛出）。此前乐观值会留在面板上，形成「从未持久化的假保存」 |
| `apps/web/src/features/authoring/InitialViewPanel.tsx` | 保存失败**必须可见**（`message.error`），不再静默丢弃异常 |
| `apps/web/src/pages/SceneAuthoringPage.tsx` | 保存后**回读运行时描述符**再宣称成功：只有描述符真的带上该视角才 `message.success`，否则明确报错 |
| `apps/web/src/scene-runtime/initialCameraPolicy.ts` | 新增纯函数 `runtimeInitialCameraUse()`，如实区分 `absent` / `authored` / `ignored` |

现在，用户保存后：`commit` 保证读取一致；`STALE` 或描述符缺失一律**显式告警**
（`data-testid="initial-view-runtime-mismatch"`），绝不把"面板有值"当作"运行时采用"。

### 6.2 优先级 2：自动推荐 —— **有意不做**（见 §7）

### 6.3 优先级 3：官方默认 / `frameScene()`

保持既有语义不变：无 authored 相机 → 官方 `frameScene()` 取景（`shouldFrameSceneOnLoad`）。
行为对存量场景零变化（FIX-02 全绿）。

### 6.4 XR 首帧 Rig 对齐修正

`SuperSplatRuntime.prepareXRSpawn()`：新增 `isTrackedHeadPose()` 判定，**必须等首个有效
tracked head pose** 才做一次性 Rig 对齐；不满足条件时**继续等待**（不再因早期 return
触发 `finally` 注销而丢掉唯一对齐机会）。仍为一次性、不可回退，仍只写 Rig、不写头显
相机（6DoF 不受影响），退出/重进仍清理订阅。

---

## 7. 官方自动初始视角能力调查（为什么不做"自动推荐"）

按任务 §6 逐项检查官方能力后，**没有找到可信的自动推荐来源**：

| 候选来源 | 结论 |
| --- | --- |
| 官方 Environment / Object 默认相机、`defaultSettings()` | 仅按 AABB 生成 `defaultCameraPose(fit)` —— 与 `frameScene()` 同级，是"取景"不是"推荐视角" |
| `CameraManager` / `frameScene()` / `resetCamera()` | 平台已复用；这里没有场景语义信息 |
| SuperSplat Editor 保存的相机 | 本平台不使用 Editor 保存态；无契约 |
| 原始重建资产里的相机轨迹 / 可靠视角元数据 | **不存在**。`workers/pipeline/convert_scene.py:300` 写的是**硬编码常量** `{fov:55, position:[0,1.2,3.5], target:[0,0.8,0]}` —— 163 个历史场景里逐字段完全相同，与场景几何无关 |
| Experience Settings v2 | 承载的是"作者指定的相机"，本身就是优先级 1 的载体，不是自动推荐 |

**决定**：不做「自动推荐初始视角」。按任务约束「不使用来源不明的固定偏移值」「不得宣称
空/地下/墙内位置是安全的」，把那个硬编码常量提升为"推荐出生点"恰恰是制造一个未经验证的
固定偏移。**没有任何自动推荐来源被发明出来，也没有任何固定偏移被硬编码。**

**同时记录的契约不对称**（供后续任务决策，本任务不改）：
`descriptorResolver.resolveFromManifest`（repo 级 dev 场景）**会**采用 `raw.camera`，
而 **DB 合同路径忽略它**。对 dev 夹具是既有设计；对真实场景，该字段正是那个硬编码常量 ——
两条路径都只把它当"种子"，不是"推荐"。

---

## 8. Performance Mode 默认 ON（§5，C 组）

| 规则 | 实现 |
| --- | --- |
| 唯一偏好来源 | 官方 key `performanceMode`（**不新建第二套存储**） |
| 首次打开（无偏好） | **默认 ON**（不再沿用官方桌面端默认 OFF） |
| 显式偏好优先 | 有偏好（含 `'false'`）→ 尊重用户；Desktop / XR 共用同一份 |
| 默认值只施加一次 | 在 `SuperSplatRuntime.create()` 时以 `persist:false` 施加；会话内手动 OFF **不会被重新强制打开** |
| 默认 ≠ 用户偏好 | 默认不写入 `localStorage`；清除 key = 恢复产品默认 ON |
| 不重建 Viewer | 只经官方 `state.performanceMode` 写入 |
| XR 一致性 | `useSuperSplatXR.setPerformanceMode` 改为与 Desktop 一样**持久化**（消除"桌面记得、XR 不记得"） |

新增 `apps/web/src/scene-runtime/performanceModePolicy.ts`（纯函数，可单测）。不触碰官方
Gaussian Budget / LOD / 渲染器。

---

## 9. 验证与数据保护

### 9.1 核心成功标准的真实证据（不是"测试通过"）

在真实浏览器里，**通过创作页 UI**把相机滚轮推近 + 拖拽环绕到一个明显不同的近距离位姿，
点「更新为当前视角」保存，再重新打开场景：

```text
保存（PATCH 后 GET /presentation）: [1.7284634113, 1.5082235336, 2.3685896397] fov 47
出厂 authored 视角          : [2.5, 1.8, 6.0] fov 47   ← 距离 4.1，确实换成了近距离
运行时描述符 /runtime        : 与保存值逐字段一致（无陈旧描述符）
重新打开 /scene 的相机       : [1.7285, 1.5082, 2.3686] fov 47
                              位置误差 < 5e-5，cameraMode = orbit（未被自动取景/动画覆盖）
XR 页进入 VR 前相机          : 0.45, -0.35, 0.6 / fov 74 —— 与 Desktop 同一份已保存视角
非恒等 W（y=90）            : 期望 RUNTIME (2.5, 1.6, -1.5)，实测吻合
无 authored 相机            : 回退官方 frameScene；有限值、离开 authored 视角 > 1.0
保存失败（403）时           : 面板**回滚到服务器值**并显式报错，不残留"假保存"
```

> **这是"用户真正保存一个近距离初始视角后，重新打开场景能够恢复该位置"的直接软件证据。**

### 9.2 测试矩阵

| # | 类别 | 命令 / 范围 | 结果 |
| --- | --- | --- | --- |
| 1 | Web 单元 | `pnpm --filter @gsplatform/web test` | **31 文件 / 303 通过** |
| 2 | Web 类型 | `tsc -b --noEmit` | 通过 |
| 3 | Web Lint | `oxlint src` | 通过 |
| 4 | Web 构建 | `pnpm --filter @gsplatform/web build` | 通过（既有 large chunk 警告） |
| 5 | 新增 E2E | `playwright test e2e/gsnext02-initial-camera.spec.ts` | **7 通过** |
| 6 | FIX-02 回归 | `playwright test e2e/fix02-semantics.spec.ts` | **6 通过** |
| 7 | VR-01C | `playwright test e2e/vr01c-pico.spec.ts` | **4 skipped**（见 §9.4） |
| 8 | 后端 | `pytest tests`（迁移到 head 的隔离库） | **562 collected / 全绿 / exit 0** |
| 9 | 后端 Lint | `ruff check .`（仓库 venv，ruff 0.16.6） | `All checks passed!` |
| 10 | 后端 类型 | `mypy app` | `Success: no issues found in 94 source files` |
| 11 | Workers | `pytest tests`（迁移到 head 的隔离库） | **189 passed / 1 skipped**（190 collected） |

新增测试：`performance-mode-policy.test.ts`（§8 策略）、`initial-camera-policy.test.ts`
（+`runtimeInitialCameraUse` 的 5 例）、`super-splat-runtime.test.ts`（+默认 ON 3 例、
XR tracked-pose 门控 2 例）、`viewer.test.tsx`（默认 ON 契约）、
`tests/test_gsnext02_initial_camera.py`（后端读己之写 2 例）、
`e2e/gsnext02-initial-camera.spec.ts`（7 例）。

### 9.3 数据保护

- **历史 13M 场景 `u-06924576399e`**：仅执行只读查询（`SELECT`）用于取证。未重新转换、
  未重新发布、未覆盖，PLY / SceneVersion / 发布资产**逐字节未变**。
- **2,076 个历史发布资产**：未做任何写操作。
- **dev 库 `gsplatform`**：未迁移、未改结构。本任务的 4 个测试夹具场景（由我此前在后端
  测试中意外写入）已精确删除，未触碰任何既有场景。
- 未使用 `reset --hard` / `git clean` / force push；未触碰其他工作者改动。

### 9.4 诚实边界（未验证项）

| 项 | 状态 |
| --- | --- |
| **PICO Neo3 真实出生点 = 已保存视角** | **`HARDWARE PENDING`**（软件已证 Rig 对齐规则；真机待复测） |
| **XR 零值位姿门控在真机上的行为** | **`HARDWARE PENDING`**（无头显无法产生真实 tracking 时序） |
| **VR-01C 本轮未执行** | 其夹具场景 `u-a68b94d84538`（1788 splats）在当前任何库/资产树中**都不存在**，用例按自身设计 skip（需 `GS_VR01C_BASE_URL`）。**因此不宣称 VR-01C 通过**；其中被本任务修改的那条断言（XR 手动切换现在会持久化）已改由 `super-splat-runtime.test.ts` 与新增 E2E 的 §五 用例在真实浏览器中覆盖 |
| 「无 authored 相机」分支的 E2E | 用**描述符契约夹具**覆盖（DB 侧无法把 `initialCamera` 置空：PATCH 把 `null` 视为"不变"）；DB 侧前置条件由后端测试覆盖。已在用例内注明 |
| 用户 PICO 上的**确切**操作序列 | 无法逐帧回放。根因结论来自机制复现（§4.1/§4.2）+ 全库物证（§4.3），而非对其操作录像的解析 |
| 现有 dev 库落后 2 个迁移 | 未处理（属部署事项）。HEAD 代码在其上会对**任何**场景加载报 `UndefinedTable`；升级前应从 HEAD 重建或迁移 |

---

## 10. 交付物与下一步

**新增文件**

- `apps/web/src/scene-runtime/performanceModePolicy.ts`
- `apps/web/src/__tests__/performance-mode-policy.test.ts`
- `apps/web/e2e/gsnext02-initial-camera.spec.ts`
- `apps/api/tests/test_gsnext02_initial_camera.py`

**修改文件**：`SuperSplatRuntime.ts`、`initialCameraPolicy.ts`、`SceneAuthoringPage.tsx`、
`InitialViewPanel.tsx`、`useSceneAuthoring.ts`、`useSuperSplatXR.ts`、
`apps/api/app/services/authoring.py`、`vr01c-pico.spec.ts`（断言随契约更新）、
两个既有 Web 测试文件。

**下一步（唯一剩余项 = 真机复测）**

1. 在真实 PICO Neo3 上把一个**同时是网页创作页的**场景（非 STALE）保存一个近距离视角，
   然后重新进入 `/xr/:sceneId`：确认出生点 = 已保存视角，且首帧朝向正确。
2. 若此时仍回退到鸟瞰：页面应显示 `initial-view-runtime-mismatch` 告警 —— 请回传该
   告警与诊断 JSON，那表示该场景的空间绑定被判为 STALE，需要按几何变更流程重新校验。
3. 顺带确认 Performance Mode 默认 ON 且手动 OFF 能被记住。
