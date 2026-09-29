# FIX_03_RUNTIME_PARITY_REPORT：GSPlatform Media & Runtime Parity

- 日期：2026-09-29
- 阶段：FIX-03 — 媒体能力补齐（真实全景 / 自管背景音频 / 碰撞参数真实化）/ 运行时能力对齐
- 前置：FIX-02 完成（HEAD `cd763e0 fix(scene): align camera transforms viewpoints and annotations`，
  FIX_02_SCENE_SEMANTICS_REPORT RESULT=PASS）
- 范围：AnnotationMediaOverlay / PanoramaViewer / BackgroundAudioController + useBackgroundAudio /
  experienceAdapter / CollisionPanel / superSplatUiCompatibility / 依赖锁定 / 单测 + e2e / 报告

---

## RESULT

**PASS** —— 18 个分节全部完成；5 个问题（§1-§5 列出的 PANORAMA 只是 `<img>`、背景音频 volume/loop
未生效、Collision 参数与官方 Walk 不一致、SuperSplat 部分 UI CSS hack 未受管、Runtime UI 展示虚假
可配置能力）全部真实修复并经真实浏览器验证。禁止项（SuperSplat 升级、Video/Duo 模式重写、LOD、
WebXR 产品化、FIX-04）未触碰。

| 问题 | FIX-03 修复 | 真实/自动化验证 |
|---|---|---|
| PANORAMA 只是 `<img>` | 接入 `@photo-sphere-viewer/core`（真实 Equirectangular 360°：拖拽 / FOV zoom / fullscreen） | e2e：`.gs-panorama__stage canvas` 挂载且无 error 态；单测 mount/unmount + destroy |
| 背景音频 volume/loop 未生效 | 弃用官方 `settings.soundUrl`（无 volume/loop/enabled API），GSPlatform 自建 `BackgroundAudioController`（volume 0..1 / loop / enabled / gesture 解锁 / ducking / scene-cleanup） | e2e 实拍 volume=0.6 loop=true、gesture 前 paused、gesture 后播放、AUDIO 标注暂停背景、关闭恢复、切场景 teardown |
| Collision 参数与官方 Walk 不一致 | 官方 Walk 固定物理（§8：gravity 9.8 等无 public API）→ 参数界面移除，Unsupported 提示 + 《不支持》划线（DB 字段仅兼容保留，构建请求不再携带） | 单测：无 spinbutton / 无保存参数 / del×4 / 构建请求仅 `{mode}` |
| SuperSplat partial UI CSS hack 未受管 | 集中进 `superSplatUiCompatibility.ts`（版本横幅 + 全部内部 class 常量 + 契约校验），`.sse-ui`/`.sse-sceneLayer` 不再散落其他文件 | 契约单测（class 变化即 FAIL，§13）+ e2e `ssv06-authoring`（hotspot 5 个、`.sse-ui` 隐藏） |
| Runtime UI 展示虚假可配置 | 物理参数不再可调（§9），只保留真实能力：Collision enabled / INDOOR-OUTDOOR / 构建/重建 / Walk / Scale 校准（§10） | CollisionPanel 单测 + authoring 页面未回归 |

---

## PANORAMA IMPLEMENTATION（§2/§3/§4）

**技术选型（依赖不满足才自写 —— 找到成熟开源库，不手写 WebGL 引擎）：**

- package：`@photo-sphere-viewer/core@5.15.1`（精确锁定，无 `^`）
- license：MIT
- reason：轻量、成熟、天然 2:1 equirectangular 球面映射（默认 `EquirectangularAdapter`）、
  mouse/touch drag + inertia、滚轮/双指 FOV zoom（`minFov..maxFov`）、navbar 全屏；
  与 `three@0.185.1`（其运行时依赖，已精确锁定）对齐，避免两套 WebGL 链。
- rejected：`marzipano@0.10.2`（Apache-2.0、长期未维护）、自写 WebGL 引擎。

`PanoramaViewer.tsx`（React 封装）能力与约束：

```text
2:1 等距柱状（PSV 默认 adapter，EquirectangularAdapter）
drag / touch / FOV zoom / fullscreen：PSV 内置（mousewheel:true, touchmoveTwoFingers:true,
  navbar:['zoom','fullscreen'], minFov 40 .. maxFov 110）
mediaUrl=null → 不渲染；加载失败（panorama-error 事件）→ 错误占位（不伪造 360°）
unmount → viewer.destroy()（释放 WebGL context / 事件监听 / 纹理）+ 清空容器（§4 资源释放）
```

**Overlay 整合（§4）：** `AnnotationMediaOverlay` 保持统一（IMAGE/VIDEO/AUDIO/PANORAMA），
PANORAMA 分支渲染 `PanoramaViewer`（不再是 `<img>`）；关闭 Overlay（Esc / 背景 / ✕）只调
`onClose`，不触碰官方 selection —— 媒体资源 webgl/audio 随组件卸载释放。

---

## AUDIO STRATEGY（§5/§6/§7）

**固定决策（§5）：GSPlatform 自管 Background Audio**

- 官方仅 `ExperienceSettings.soundUrl`（无 volume/loop/enabled/mute API，AutoplayPolicy 仅
  play 一次且不可撤销 → 无法实现场景切换按配置启停）→ **Experience Adapter 不再设置
  `settings.soundUrl`**（`experienceAdapter.ts` 移除该块 + 旧单测改写为“一律不写”）。
- `BackgroundAudioController` 管理单一 `<audio>`：enabled / url / volume(0..1) / loop 全部真实生效；
  url 变化重建元素，volume/loop 变化即时更新不重建；disabled → 暂停。
- Autoplay 合规（§6）：**不绕过** —— 首次用户 gesture（pointerdown/keydown/touchstart）解锁；
  浏览器仍拒绝 → 挂一次性 gesture 重试；场景切换/unload → `destroy()`（pause + 清 src + load 复位）。
- 页面接入：`useBackgroundAudio(descriptor.backgroundAudio, sceneId)` hook（Desktop +
  XR 页），gesture 解锁监听、sceneId 变化 destroy、descriptor 变化 configure。

**ducking（§7）固定策略 = 「暂停-恢复」**（非音量压低，避免争抢且实现简单）：

```text
标注 AUDIO/VIDEO onPlay            → controller.pause()  （背景暂停，pausedByDuck=true）
标注 onPause/onEnded                → controller.resume()（恢复播放）
Overlay close（卸载不保证触发 pause）→ 父组件 onClose 显式 resume（补齐关闭路径）
```

---

## AUDIO TEST（§6/§15/§16）

真实浏览器（e2e `ssv06-audio.spec.ts`，场景 r-8c4e2264e86a，descriptor
`enabled=true volume=0.6 loop=true`）：

```text
§5 唯一 Audio 实例：window.Audio patch 记录 → 恰 1 个，src = .../presentation/background-audio
§6 volume/loop 真实生效：el.volume≈0.6、el.loop=true
§6 autoplay 政策：无任何用户手势前 el.paused===true
§6 手势解锁：page.mouse.click → 背景开始播放（paused=false）
§7 ducking：点开 AUDIO 标注 → 背景 paused；关闭 Overlay → 背景恢复播放
§6 scene-change cleanup：SPA 切到无背景音频场景 → 旧元素 src 被清 + load 被调 + 暂停，且不新建元素
```

单元测试（mock `window.Audio`）：volume/loop/url 变化重建 / gesture 解锁 / ducking pause-resume /
enabled=false 暂停 / destroy 释放 / play 被拒 → gesture 重试（背景音频控制器 6 用例）。

---

## COLLISION PARAMETER MATRIX（§8/§9/§10）

**真实能力（保留，§10）：**

| 能力 | 状态 | 机制 |
|---|---|---|
| Collision enabled | ✅ 真实 | `collisionEnabled` → descriptor `collision.enabled` → runtime 加载碰撞网格 |
| INDOOR / OUTDOOR 构建策略 | ✅ 真实 | 构建/重建任务参数 |
| Collision asset（voxel/网格） | ✅ 真实 | runtime 消费 |
| Walk 模式 / Scale 校准 | ✅ 真实 | 官方 Walk + scale 告警（SSV-07） |
| 物理参数 | ❌ 不支持 | 见下 |

**官方 Walk 固定物理（§8，public API 审计）：** `gravity=9.8`、`capsuleHeight=1.5`、`eyeHeight=1.3`、
`moveGroundSpeed=7` —— 官方无任何重力/坡度/台阶/高度可调接口，**不支持用户覆盖**。

| 废弃参数 | 状态 | 处置 |
|---|---|---|
| gravity | UNSUPPORTED | DB 字段保留（backward compat）；UI 移除可调控件；构建请求不再发送 |
| slopeLimitDegrees | UNSUPPORTED | 同上 |
| stepOffset | UNSUPPORTED | 同上 |
| playerHeight | UNSUPPORTED | 同上 |

`CollisionPanel` 现在：Unsupported Alert（列出 4 参数并标注删除线《不支持》）+ 模式 Select +
启用碰撞 Switch（切换即保存）+ 构建/重建。**不再出现“看起来能配、实际无效”的控件**
（无 InputNumber / 无“保存参数”按钮）。

---

## SUPERSPLAT UI COMPATIBILITY（§11/§12/§13）

- **集中管理：** 所有针对官方 viewer 内部 DOM class 的 hack 收敛到
  `scene-runtime/superSplatUiCompatibility.ts`（唯一依赖侧入口）：
  ```text
  ⚠️ Pinned to @playcanvas/supersplat-viewer@1.35.0
  ⚠️ Internal CSS/DOM dependency —— 官方不保证 .sse-* class 是稳定公开 API
  ⚠️ 升级依赖前必须重新验证（e2e ssv06-authoring + 契约单测）
  ```
- **单一来源：** `SUPERSPLAT_UI_PINNED_VERSION` / `OFFICIAL_UI_CHROME_CLASS(.sse-ui)` /
  `OFFICIAL_SCENE_LAYER_CLASS(.sse-sceneLayer)` / `OFFICIAL_HOTSPOTS_CONTAINER_CLASS(.sse-annotation-hotspots)` /
  `OFFICIAL_HOTSPOT_CLASS(.sse-annotation-hotspot)` + `buildUiScopeCss()` / `applyUiScopeStyles()`；
  `SuperSplatRuntime` 中原散落的内联实现删除，改为导入。
- **契约验证（§13）：** `validateUiCompatibility(root)` → `{hotspotsContainer, hotspotCount,
  chromeCount, pinnedVersionMatches}`；单测覆盖“class 变化即 FAIL”；e2e 断言官方 hotspots 容器真实
  存在（5 个）且 `.sse-ui` 隐藏（display:none）。
- **annotation overlay 重写不属本阶段**（§11 明确不要求）。

---

## DEPENDENCY VERSION（§3/§14）

| package | version | 锁定方式 | 用途 |
|---|---|---|---|
| `@photo-sphere-viewer/core` | **5.15.1** | 精确（无 `^`） | PANORAMA 360° |
| `three` | **0.185.1** | 精确（无 `^`） | PSV 运行时依赖，防漂移 |
| `@playcanvas/supersplat-viewer` | **1.35.0** | 精确（保持） | 官方 viewer —— **本阶段不升级（§14）** |
| `playcanvas` | **2.22.4** | 精确（保持） | 官方 runtime |

---

## TESTS（§16）

| 测试 | 类型 | 覆盖 |
|---|---|---|
| `panorama-viewer.test.tsx` | 单测（mock PSV Viewer） | 构造配置（2:1/minFov/maxFov/navbar）、ready → 隐藏 loading、error → 错误态、卸载 → destroy、null 不渲染（5 用例） |
| `background-audio-controller.test.ts` | 单测（mock Audio） | volume/loop/url 重建/gesture 解锁/ducking/enabled=false 暂停/destroy 释放/play 拒绝 → gesture 重试（6 用例） |
| `super-splat-ui-compatibility.test.ts` | 单测（jsdom） | 版本声明、作用域 CSS 引用内部 class、applyUiScopeStyles 幂等、契约报告、FAIL 条件（5 用例） |
| `collision-panel.test.tsx` | 单测（mock collisionApi） | 无物理参数控件/del×4/无保存参数/构建请求仅 `{mode}`/Switch 为真实能力（3 用例） |
| `annotation-media-overlay.test.tsx`（改） | 单测 | PANORAMA → PanoramaViewer（非 img）、AUDIO/VIDEO 播放态 → onPlaybackChange（+2 用例） |
| `super-splat-runtime.test.ts`（改） | 单测 | §5：任何 backgroundAudio 态一律不写官方 soundUrl |
| `ssv06-media.spec.ts`（改） | e2e 真实浏览器 | VIDEO→AUDIO→PANORAMA 切换 + **PANORAMA 真实 canvas 挂载且无 error** |
| `ssv06-audio.spec.ts`（重写） | e2e 真实浏览器 | §5/§6/§7/§15 全部音频行为（见 AUDIO TEST） |
| `ssv06-authoring.spec.ts` | e2e | 官方 hotspots 层存在、`.sse-ui` 隐藏（UI 兼容契约） |

门禁：web vitest **24 files / 197 tests 全部通过**；`pnpm typecheck` / `pnpm lint` / `pnpm build`
干净（仅既有 chunk-size 告警）；Playwright e2e **17/17 通过**（SSV-07 walk 距离阈值 1 次并行抖动
重跑复现通过，与 FIX-03 无因果）。

---

## FILES

新增：
- `apps/web/src/features/media/PanoramaViewer.tsx` — 真实 360°（PSV）React 封装
- `apps/web/src/features/media/BackgroundAudioController.ts` — 自管背景音频控制器
- `apps/web/src/hooks/useBackgroundAudio.ts` — 控制器 React hook（页面接入/gesture/清理）
- `apps/web/src/scene-runtime/superSplatUiCompatibility.ts` — UI 兼容层（§12 专属模块）
- 测试：`panorama-viewer.test.tsx`、`background-audio-controller.test.ts`、
  `collision-panel.test.tsx`、`super-splat-ui-compatibility.test.ts`

修改：
- `AnnotationMediaOverlay.tsx`（PANORAMA → PanoramaViewer；AUDIO/VIDEO 播放态回调）
- `experienceAdapter.ts`（**移除 soundUrl 写入**，§5）
- `CollisionPanel.tsx`（移除物理参数可调 UI；Unsupported 提示；构建仅 mode；Switch 切换即保存）
- `SceneViewerPage.tsx` / `XRViewerPage.tsx`（useBackgroundAudio + ducking + 关闭恢复）
- `index.css`（`.gs-panorama` 2:1 舞台 + loading/error 态）
- `super-splat-runtime.test.ts`、`annotation-media-overlay.test.tsx`、`ssv06-audio.spec.ts`（重写）、
  `ssv06-media.spec.ts`（PANORAMA canvas 断言）
- `SuperSplatRuntime.ts`（内联 UI hack → 导入兼容模块；行为不变）
- `package.json` / `pnpm-lock.yaml`（`@photo-sphere-viewer/core@5.15.1` + `three@0.185.1`）

---

## NEXT PHASE

- 全景资产管线：作者化上传 2:1 等距柱状图校验 + 上传超采样/优化（当前仅透传 URL）。
- 背景音频扩展：渐入渐出 / 多音源混音 / 音量记忆持久化（当前 controller 已具备扩展点）。
- Video/Duo 渲染模式、LOD 预算、WebXR 产品页美化 —— 仍属后续阶段（本阶段禁止项）。
- 官方依赖升级（SuperSplat / PSV / three）：升级前必须重跑 `superSplatUiCompatibility` 契约
  单测 + `ssv06-authoring`/`ssv06-media` e2e。