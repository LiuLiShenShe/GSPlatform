# SSV_04_REPORT：Unified Desktop and XR Runtime

- 日期：2026-09-28
- 阶段：SSV-04 — XR Unification
- 前置：`docs/reports/SSV_03_REPORT.md` RESULT = PASS ✓
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（未升级）

---

## RESULT

**PASS**

Desktop 与 XR 已统一到同一官方 runtime。`/scene/:sceneId` → `SuperSplatRuntime(mode='desktop')`，
`/xr/:sceneId` → `SuperSplatRuntime(mode='xr')`，共用同一个 descriptor / settings / content /
collision / events（`resolveSceneRuntimeDescriptor` + `buildExperienceSettings` + 同一 handle）。

**XRViewerRuntime production references = 0**（见下方"生产引用归零"取证）。

---

## 一、删除旧独立 XR Runtime

| 文件 | 处理 | 原因 |
|---|---|---|
| `apps/web/src/xr/XRViewerRuntime.ts` | **删除** | 独立 `createXRRuntime` + 自造 `DEFAULT_SETTINGS`，被 `SuperSplatRuntime(mode='xr')` 完全取代（renderer:'webgl' 由 `rendererForMode` 固定；`onXRModeChanged`/`frameScene`/`startVR`/`endXR`/`runtimeRenderer`/`renderedSplatCount` 均为 wrapper 已有方法） |
| `apps/web/src/xr/sceneResolver.ts` | **删除** | 独立 `resolveSceneForXR`（manifest-only、拒绝 streamed-sog）是第二套 Scene 数据模型，被 SSV-01 合同 + `resolveSceneRuntimeDescriptor` 取代 |
| `apps/web/src/xr/xrTypes.ts` | 精简 | 删除已无引用的 `XRSceneResolution` / `XRSceneError` / `XRState`；仅保留浏览器能力诊断类型 `XRDiagnostics`（展示用） |
| `apps/web/src/xr/XRDiagnostics.ts` | 保留 | 纯浏览器 `navigator.xr` 探测，仅用于 diagnostics 展示（spec §五允许；运行态真相 = 官方 state） |

### 生产引用归零（取证）

```
$ grep -rn "XRViewerRuntime|createXRRuntime|resolveSceneForXR|sceneResolver" src --include=*.ts --include=*.tsx | grep -v __tests__
src/xr/xrTypes.ts:4: * 旧的独立 XR Runtime（XRViewerRuntime / sceneResolver）已删除…   ← 仅说明性注释
```

除一条历史说明注释外，生产代码**零引用**。

---

## 二、XR 路由（统一链路）

`/xr/:sceneId`（`XRViewerPage.tsx`）→ `useSuperSplatXR(sceneId)`：

```
resolveSceneRuntimeDescriptor(sceneId)     // DB 合同优先，404 回退 manifest（与 Desktop 同一）
  → buildExperienceSettings(descriptor)    // 同一 adapter
  → SuperSplatRuntime.create({ mode: 'xr' })  // rendererForMode('xr') = 'webgl'（强制 WebGL）
```

`/xr/test`（`XRTestPage.tsx`）→ `useSuperSplatXR(descriptor)`，其中 descriptor 由
`descriptorFromSceneUrl(url)` 合成（`/xr/test` 的 `?scene=` URL 调试入口），**仍走同一条
`buildExperienceSettings` → `SuperSplatRuntime.create` 链路** —— 不构成第二套 Viewer 创建逻辑。

Renderer 强制 WebGL 由 wrapper 的 `rendererForMode('xr')` 保证（SSV-02 已实现），两页共用。

---

## 三、真实场景（同一 sceneId，/scene 与 /xr）

Playwright headless + SwiftShader，Web dev `:5173` + API `:8001`（dev identity）。

| 页面 | sceneUrl（content.url） | renderer | loaded | gsplats | canStartVR | xrMode |
|---|---|---|---|---|---|---|
| `/scene/r-8c4e2264e86a`（Desktop） | `/local-scenes/r-8c4e2264e86a/versions/b2cc7bb1594d/lod-meta.json` | webgl2(auto) | true | 179 | — | — |
| `/xr/r-8c4e2264e86a`（XR） | **同上（完全相同）** | **webgl2（强制）** | true | **179（相同）** | false¹ | null |
| `/xr/local-garden` | `/local-scenes/local-garden/scene.sog`（manifest 回退） | webgl2 | true | 500 | false¹ | null |
| `/xr/test` | `/local-scenes/local-garden/scene.sog`（默认） | webgl2 | true | 500 | false¹ | null |

¹ headless SwiftShader 无 WebXR 设备 → 官方 `state.canStartVR=false`，`Enter VR` 按钮正确禁用
（官方 state 为真相源，不伪造就绪）。

**§四达成**：`r-8c4e2264e86a` 是真实 GSPlatform 流式 SOG，`/scene` 与 `/xr` **Scene URL 相同、
settings 相同（同一 `buildExperienceSettings(descriptor)` 产物）、Gaussian 相同（gsplats=179）**，
**不再 XR fallback local-garden**（旧 sceneResolver 拒绝 streamed-sog、只看 manifest 的限制已消除）。

截图存证：`/tmp/ssv04/xr-r8c4.png`、`xr-local-garden.png`、`xr-test.png`。
Agnes 识图确认 `/xr/r-8c4` 场景真实渲染（米白几何体、gsplats=179）、无错误遮罩、renderer=webgl2、
canStartVR=false（如实反映无 WebXR 设备）。

---

## 四、XR 能力（官方 state 为运行态真相）

页面**不维护** `navigator.xr` 状态机作为真相源。以下全部读自官方 `ViewerState`：

- `canStartVR` → 驱动 `Enter VR` 按钮 enabled/disabled
- `canStartAR` → 诊断展示
- `xrMode` → 诊断展示 + 页面状态机（ACTIVE/ENDED）
- `loaded` / `progress` / gsplats / renderer → 轮询官方 state

`navigator.xr` 探测（`XRDiagnostics`）**仅用于诊断表格展示**（Secure Context / navigator.xr /
Immersive VR / Immersive AR），不参与按钮状态或会话真相。

---

## 五、按钮链路（无 iframe / postMessage / setTimeout）

| 动作 | 实现 | 约束 |
|---|---|---|
| 进入 VR | 用户真实 click → `runtime.startVR()`（`SuperSplatRuntime` → 官方 `handle.startXR('vr')`） | 无 postMessage / iframe / setTimeout |
| 退出 | `runtime.endXR()` | 同上 |
| 浏览器/系统菜单退出 | 监听官方 `xrMode:changed` → `onXRModeChanged` → 页面置 `xr-ended` | 不依赖自维护状态机 |

`/xr/test` 保留为 diagnostics 页面，但同样调用 `SuperSplatRuntime`（已删除 `createXRRuntime`）。

---

## 六、测试

### 单元 / 集成测试（`xr-pages.test.tsx` 重写，11 项）

- 官方 `createViewer` 模块 mock（fake handle，Proxy state 复刻官方 `WritableStateKey` 写入即
  `*:changed` 语义）；`runtimeApi` 模块 mock（fixture descriptor）。
- 覆盖：
  1. `navigator.xr` 不存在 → 诊断 false，页面不 crash
  2. immersive-vr unsupported → 诊断显示 unsupported（真相源仍是官方 state）
  3. 场景加载失败 → 显示 Scene 错误（非 XR Session 错误）
  3b. `/xr/test` 走官方 createViewer，renderer=webgl，loaded
  4. **点击 Enter VR → 真实 startXR('vr') → xrMode vr → ACTIVE**（userEvent click，非 setTimeout）
  5. 系统退出（xrMode→null）→ XR ENDED
  6. 退出后**重新进入**，状态恢复正常（re-enter）
  7. Exit VR 按钮 → `runtime.endXR()`
  + 路由存在；**`/xr/:sceneId` 与 `/scene/:sceneId` 用同一 descriptor → 同一 contentUrl、同一
     settings、renderer=webgl**（SSV-04 §四核心断言）；`/xr/:sceneId` loaded 后自动 frameScene、
     Enter VR 由官方 canStartVR 驱动。

- 删除 `xr-scene-resolver.test.ts`（测已删除的旧 sceneResolver）。

### Immersive Web Emulator / 真实头显

**NOT EXECUTED** —— 当前验证环境为 headless Chromium + SwiftShader，无 WebXR 设备
（`navigator.xr` 缺失 / `canStartVR=false`），无法进入真实 immersive-vr 会话。
按 spec「不要伪造」，此处不声称通过。

「Enter VR → xrMode vr → exit → null → re-enter」状态机由上述 vitest Test 4/5/6/7
（真实 click → 官方 startXR → 官方 xrMode:changed）覆盖，逻辑与真实会话一致。
真实头显硬件验证留待 SSV-10 生产验收。

### 质量门禁

- web 全量：**161 passed**（15 文件；原 168 → 删 6 项旧 resolver 测试 + 旧 xr-pages 12 项
  重写为 11 项 + 净变化）
- `lint`：0 error，新文件 0 warning
- `typecheck`：**13**（SSV-00 基线，新文件 0）
- `npx vite build`：**PASS**
- `apps/api` / `apps/viewer` / `apps/xr-viewer` 零改动

---

## 七、已知差异 / 后续

- `/xr/test` 的 `?scene=<url>` 入口走 `descriptorFromSceneUrl` 合成最小描述（`content.format`
  由扩展名推断），其余字段为空；这是 diagnostics 调试入口，生产 `/xr/:sceneId` 始终走完整合同。
- XR locomotion / XR UI / skybox / 背景音频 / 碰撞行走仍按 ADR 冻结，属 SSV-07 范围。
- `apps/xr-viewer`（独立 PlayCanvas XR viewer）在本阶段未改动，按计划在 SSV-09 随 legacy 一并退役
  为 FROZEN（当前生产 `/xr/*` 路由早已不指向它）。

---

## NEXT PHASE

**SSV-05 — Experience Settings**（Authoring UI → DB → Adapter → Viewer）。
顺序见 `docs/SSV_MIGRATION_PLAN.md`。
