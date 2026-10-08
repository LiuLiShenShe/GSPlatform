# FIX_XR_01_ASYNC_READY_STATE：XR 异步加载状态机修复报告

- 日期：2026-10-08
- 阶段：FIX-XR-01 —— XR Async Loading State Transition（PICO Neo3 真机 WebXR 软件问题；
  **非新 Phase / 无重构 / 未展开无关审计**）
- 基线：`cce169041bb1076bceedd80229b17047c9293275`（FIX-06.2.1a，工作区 clean）
- 前置：FIX-01..06、FIX-06.1、FIX-06.2、FIX-06.2.1、FIX-06.2.1a 全部 PASS（软件侧）

---

## RESULT

**SOFTWARE PASS —— 异步加载后 React 状态 loading → ready 修复，/xr/test 与 /xr/:sceneId
统一生效。**
**PICO NEO3 REAL-DEVICE RETEST: PENDING —— 执行代理无法操作用户手里的 PICO Neo3，
真机复测待用户实际反馈（不得写作 HARDWARE PASS）。**

```text
FIX-XR-01 SOFTWARE:                 PASS
PICO NEO3 REAL-DEVICE RETEST:       PENDING
```

---

## 1. 真实 PICO Neo3 现象

设备 PICO Neo3 · PICO 自带浏览器 · 访问 `/xr/test` 实测：

```text
Secure Context                true
navigator.xr                  true
Immersive VR (browser)        supported
state.loaded                  true
state.canStartVR              true

WebXR state                   LOADING
XR mode                       null

Enter VR                      disabled
Frame Scene                   disabled
Exit VR                       disabled    ← 未进入 XR 时禁用属正常
```

`loaded=true`、`canStartVR=true` 但页面一直 LOADING → Enter VR / Frame Scene 不可用 =
实际故障。

## 2. 根因

- **initial runtime.loaded**：真实 Gaussian 文件加载是异步的 ——
  `SuperSplatRuntime.create()` resolve 时 `runtime.state.loaded === false`。
- **async onLoaded behavior**：资源加载完成 → 官方 `loaded:changed(true)` →
  `runtime.onLoaded(v)` 只 `setLoaded(v)`，随后 `refresh()` 更新 loaded/canStartVR/
  xrMode 等，**从不迁移 status**。
- **old React status**：boot 时 `setStatus('loading')`；唯一置 ready 的是一次性检查
  `if (runtime.state.loaded) setStatus('ready')`，但发生在 create resolve 时
  （loaded 仍 false）→ 检查失败 → 状态永远停留 loading。
- **actual cause**：`onLoaded(true)` 未触发 `loading → ready` 状态迁移；轮询
  `refresh()`（每 1s）也没有基于 `runtime.state.loaded` 的 ready 兜底。

既有单元测试未发现：`makeOfficialHandle()` 直接 `loaded: true`，只测「立即加载」，
从未模拟异步加载（loaded=false → 事件 → true）。

## 3. 修复（`apps/web/src/features/viewer-official/useSuperSplatXR.ts`，最小改动）

- **onLoaded ready transition**：`onLoaded(v)` 且 `v===true` 时调用内部
  `syncReady()`：
  ```ts
  const syncReady = () => {
    if (!runtime.state.loaded) return;
    setStatus((prev) => (prev === 'loading' ? 'ready' : prev));
  };
  ```
- **refresh fallback**：`refresh()` 末尾调用 `syncReady()` —— 轮询观察到
  `runtime.state.loaded=true` 时（即使 loaded 事件未到达组件）也收敛 ready。
- **XR-ACTIVE preserved**：`setStatus((prev) => prev==='loading' ? 'ready' : prev)`
  —— prev 为 `xr-active` 时不改写。
- **XR-ENDED preserved**：同上，prev 为 `xr-ended` 时不改写。
- **error preserved**：prev 为 `error` 时不改写。
- **loaded=false 不提前 ready**：`syncReady` 第一行 `if (!runtime.state.loaded) return;`
  —— 官方加载状态为假时绝不置 ready。
- **lifecycle isolation**：`cancelled` 守卫原样保留 —— 卸载/场景切换后旧 runtime 的
  晚到 `onLoaded` 直接丢弃（`if (cancelled) return`），不重建、不污染新场景。
- **依据 = 官方 runtime 实际加载状态**：ready 只由 `runtime.state.loaded` 驱动，
  **不是**浏览器 WebXR 能力（能力仅作诊断展示，不直接置 ready）。
- boot 一次性检查改为复用 `syncReady()`（同 guard）。

未改动 `canEnter` 判定：

```ts
const canEnter = (state.status === 'ready' || state.status === 'xr-ended') && state.canStartVR;
```

`/xr/test`（XRTestPage）与 `/xr/:sceneId`（XRViewerPage）共用 `useSuperSplatXR`，一次
修复两页统一生效。

## 4. RED → GREEN（`apps/web/src/__tests__/xr-pages.test.tsx`）

可控异步 mock：`createViewer` 返回 `loaded:false` 的 handle（`nextHandleOptions`），
随后 `completeAsyncLoad()` 翻转 `state.loaded=true` 并 fire `loaded:changed(true)`。
**未把 mock 改成初始 loaded=true 绕绿。**

- **test name**：`Test 1: onLoaded(true) 后 loading → ready，Enter VR / Frame Scene 可用`
- **before fix**：`AssertionError: expected 'WebXR state: LOADING | XR mode: null' to contain 'READY'`
  （6/7 新测试失败 —— Test 2 为能力守卫、立即加载场景本应通过）
- **after fix**：7/7 通过；完整 xr-pages.test.tsx 21 passed

## 5. 异步加载状态机测试矩阵（真实异步 mock）

| # | 场景 | 断言 | 结果 |
|---|---|---|---|
| Test 1 | 初始 loaded=false → onLoaded(true) | READY / loaded=true / canStartVR=true / Frame Scene enabled / Enter VR enabled / Exit VR disabled | ✅ PASS |
| Test 2 | loaded=true, canStartVR=false | READY / Frame Scene enabled / **Enter VR disabled**（不绕过官方能力） | ✅ PASS |
| Test 3 | 加载事件未触发、仅轮询观察到 loaded（fake timers 1.1s） | refresh 兜底 READY / Enter VR enabled | ✅ PASS |
| Test 4 | READY → Enter → XR-ACTIVE → 再 onLoaded(true)/refresh | 仍 XR-ACTIVE、xrMode=vr（不覆盖） | ✅ PASS |
| Test 5 | XR-ACTIVE → 系统退出 → XR-ENDED → 再 refresh | 仍 XR-ENDED、可再次 Enter | ✅ PASS |
| Test 6 | 场景 A 加载中 → 卸载 → A 的 onLoaded(true) 晚到 | 不重建 viewer、不污染新场景 B、B 正常异步 READY | ✅ PASS |
| §8 | 正式页 /xr/:sceneId 异步加载 | Loading 覆盖层 → diag loaded=true / ov-xr-diagnostics status=ready / Enter VR enabled | ✅ PASS |

## 6. 完整 Web 门禁（真实运行值）

| 门禁 | 命令 | 结果 |
|---|---|---|
| targeted | `vitest run src/__tests__/xr-pages.test.tsx` | **21 passed**（14 旧 + 7 新） |
| typecheck | `pnpm typecheck`（tsc -b --noEmit） | **exit 0（0 errors）** |
| lint | `pnpm lint`（oxlint） | **exit 0** |
| 全量 Vitest | `pnpm test` | **235 passed / 26 files**（228 + 7 新增） |
| build | `pnpm build` | **exit 0** |
| 相关 E2E（真浏览器） | `playwright test` —— ssv06-media XR hotspot / ssv07-collision XR / fix02 XR camera pose | **3 passed**（`/xr/r-8c4e2264e86a` 加载→loaded=true→交互全通） |

## 7. SCOPE（人工 diff 审核）

- 修改文件：仅 `apps/web/src/features/viewer-official/useSuperSplatXR.ts`（状态迁移 +
  docstring）与 `apps/web/src/__tests__/xr-pages.test.tsx`（异步 mock + 7 测试 + 只读
  state 受控转写 helper）。
- **未修改**：SuperSplat 包版本 / PlayCanvas 版本 / GPU reconstruction runtime /
  backend / workers / deploy / Nginx / FIX-05C cache / scene access control /
  DB schema / Alembic / XR renderer 选择 / LOD / Gaussian 数据格式。
- **保留**：`shouldFrameSceneOnLoad(desc)` 现有逻辑（未重复调用 frameScene、未重复
  订阅事件）；`startXR('vr')` / `endXR()` 调用链路未改；`applyWorldTransform` /
  buildExperienceSettings / descriptor / worldTransform / initial camera / collision /
  annotations / media overlay 均未触碰。

## 8. PICO Neo3 真机复测（待用户执行，**NOT EXECUTED**）

- Secure Context：待真机（自动化无法验证真机 HTTPS 上下文，既有诊断在真机为 true）
- navigator.xr：待真机
- immersive-vr：待真机
- manual Enter VR：待用户手持 PICO Neo3 控制器点击
- stereo / 6DoF：待真机
- **actual hardware acceptance：NOT EXECUTED**（执行代理无法操作用户手里的 PICO Neo3；
  自动化模拟 ≠ 真机验收，不得写作 HARDWARE PASS）

更新测试服务后预期诊断（同 §1 现象段 + 修复项）：

```text
WebXR state             READY     ← 由 LOADING 修复
Frame Scene             enabled
Enter VR                enabled
```

用户点击 Enter VR 后续预期：`XR mode = vr` / `WebXR state = XR-ACTIVE`；退出后
`XR mode = null` / `WebXR state = XR-ENDED`；可再次进入。

## 9. FINAL ACCEPTANCE STATUS

```text
FIX-XR-01 SOFTWARE:           PASS
  async loaded → READY:       PASS (onLoaded(true) + refresh 轮询兜底；仅从 loading
                              迁移，不覆盖 xr-active/xr-ended/error)
  官方能力不绕过:              PASS (canStartVR 仍为 Enter VR 唯一放行依据)
  /xr/test 与 /xr/:sceneId:   PASS (共用 useSuperSplatXR)
PICO NEO3 REAL-DEVICE RETEST: PENDING (等待用户真机复测)
```

**FIX-XR-01 SOFTWARE: PASS**
**PICO NEO3 REAL-DEVICE RETEST: PENDING**
