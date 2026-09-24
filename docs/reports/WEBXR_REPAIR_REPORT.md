# WebXR Repair Report

- 日期：2026-09-24
- 分支：`main`
- 范围：为 GSPlatform 增加一条独立、最小、可调试、可真实进入 VR 的 WebXR 路径；不破坏现有 Desktop Viewer。

---

## 1. Initial findings

修改前审计确认的实际问题（`apps` + `deploy` 全量 rg 扫描）：

| # | file / line | problem | impact |
|---|---|---|---|
| 1 | `apps/viewer/src/embed.ts:113`<br>`apps/viewer/src/main.ts:133` | `xrCompatible: false` | Desktop Viewer 无法用于 WebXR（符合预期：Desktop 是 WebGPU-only 路径，不动） |
| 2 | `apps/viewer/src/embed.ts:109`<br>`apps/viewer/src/main.ts:129` | `deviceTypes: ['webgpu']` | 强制 WebGPU；WebGPU 下 WebXR 需 `XRGPUBinding`，大量头显浏览器不支持 |
| 3 | `apps/viewer/src/pc-app.ts:59,85` | `// XrManager` import 与 `// appOptions.xr = XrManager;` 均被注释 | Desktop Viewer 完全没有 XR 能力 |
| 4 | （全仓 rg） | `startXR` / `endXR` / `isXRSupported` **不存在** | 没有任何进入 immersive-vr 的入口 |
| 5 | `apps/web/src/layouts/ViewerLayout.tsx:14`<br>`apps/web/src/features/viewer/ViewerBottomToolbar.tsx:88` | 仅有 `requestFullscreen()` | "进入全屏"被当作 VR（§17），二者混淆 |
| 6 | `apps/web/src/features/viewer/useViewerLifecycle.ts:118` | 通过 `createViewer(container)` + 事件/回调与 viewer fork 通信；Desktop 场景页是 iframe + postMessage 架构 | Desktop 路径含 iframe/RPC 边界，不适合 XR |
| 7 | iframe allow 属性 | 现有挂载未设置 `xr-spatial-tracking` | 未来若 iframe XR 会被 Permissions-Policy 拒绝（第一阶段不使用 iframe XR） |
| 8 | `deploy/nginx/gsplatform.conf:74` | `add_header Permissions-Policy "camera=(), microphone=(), geolocation=()"` | 缺 `xr-spatial-tracking=(self)`；生产下 XR 会话会被拒绝 |
| 9 | 现有测试（`apps/web/src/__tests__/*`） | 全部基于 jsdom / Playwright 普通浏览器 | 无法验证 XRSession；不存在任何 WebXR 测试 |
| 10 | 全局 401 拦截器 `apps/web/src/services/http.ts:44-57` | 任意 401 → `window.location.href=/login` | 头显直接打开 `/xr/*` 会被跳登录，阻断 §21 真机测试 |

---

## 2. Root cause

### Confirmed root causes

1. **架构层面根本没有 XR 路径**：全仓不存在 `startXR`/`endXR`/`isXRSupported`；Desktop Viewer（`apps/viewer`）是 SuperSplat Editor fork，被裁剪为 WebGPU-only，且 XrManager 被注释。它不可能承担 XR。
2. **Desktop Viewer 强制 WebGPU**：`deviceTypes: ['webgpu']` + `xrCompatible: false` —— 即便只改这两个开关（§3 禁止的做法），也会撞上 WebGPU WebXR 的 `XRGPUBinding` 差异和 Editor-derived camera/render passes 冲突。
3. **官方 supersplat-viewer 明确要求 WebGL 才能 XR**：读 `@playcanvas/supersplat-viewer@1.35.0` 源码确认 `createApp()`：`deviceTypes: useWebGPU ? ['webgpu'] : []` + `xrCompatible: true`，且 `startXR` 在 WebGPU 下抛 `startXR: reload with WebGL to start this session`。
4. **Permissions-Policy 缺 xr-spatial-tracking**：生产 nginx 未授予，头显浏览器会拒绝会话。
5. **401 登录跳转阻断头显直连**：`/xr/*` 是本地自包含页面，不应受登录态影响。

### Potential secondary causes

- supersplat-viewer peerDependency 要求 `playcanvas ^2.22.1`，仓库锁定 `2.22.0` —— 已升级到 `2.22.4` 消除版本风险。
- `createViewer` 的 `settings` 参数是必填类型（`object | Promise<object> | string`），源码 `await options.settings` 对 `undefined` 会走 `importSettings(undefined)`；已显式传入最小 settings 对象。

### Environment-dependent causes

- **本机无 VR 头显，无 OpenXR runtime**：`docs/reports/PHASE_13/14_REPORT.md` 已记录 PICO Neo 3 硬件不可得。自动测试只能验证到 `isSessionSupported` 与页面状态机，不能验证真实 XRSession。
- headless Chromium 无 WebXR 设备：`navigator.xr` 存在但 `isSessionSupported('immersive-vr')` 为 false —— 这是环境限制，不是代码缺陷。

---

## 3. Changes

| 文件 | 变更 | 原因 |
|---|---|---|
| `apps/web/package.json` | 新增 `@playcanvas/supersplat-viewer@^1.35.0`、`playcanvas@^2.22.4` | 官方 XR runtime；peer dep 版本满足 |
| `apps/web/src/xr/xrTypes.ts` | **新增**：XRState / XRDiagnostics / XRSceneResolution / XRSceneError | 类型明确（§24），集中 XR 代码 |
| `apps/web/src/xr/XRDiagnostics.ts` | **新增**：`collectDiagnostics()` + `formatDiagnostics()` | §7 诊断面板（console + 页面可视化） |
| `apps/web/src/xr/XRViewerRuntime.ts` | **新增**：`createXRRuntime()` 封装 `createViewer({renderer:'webgl', ui:false, settings})` | §6 强制 WebGL；§9 用户手势直连 `startXR('vr')` |
| `apps/web/src/xr/sceneResolver.ts` | **新增**：复用 `/local-scenes/<id>/manifest.json`；streamed-sog 明确拒绝 | §10 不发明第二套 Scene 模型；§23 不做 LOD |
| `apps/web/src/pages/XRTestPage.tsx` | **新增**：`/xr/test` 诊断页 + Enter VR | §7/§8/§11/§12 |
| `apps/web/src/pages/XRViewerPage.tsx` | **新增**：`/xr/:sceneId` 独立 XR 场景页 | §5 不用 iframe/postMessage |
| `apps/web/src/app/router.tsx` | 新增 `/xr/test`、`/xr/:sceneId` 顶层路由 | 独立于 PlatformLayout / ViewerLayout，无 RPC 边界 |
| `apps/web/src/layouts/ViewerLayout.tsx` | 新增独立"进入 VR"按钮 → `navigate('/xr/:sceneId')` | §16 场景页 VR 入口；§17 与"进入全屏"分开 |
| `apps/web/src/services/http.ts` | 401 拦截器豁免 `/xr/*` | §21 头显可直接打开 XR 页面 |
| `apps/web/src/test/setup.ts` | 补 jsdom 缺失的 `window.isSecureContext = true` | jsdom 不实现该字段，XR 页面依赖它分流 |
| `apps/web/src/__tests__/xr-pages.test.tsx` | **新增**：6 个 XR 自动测试（Test A–F） | §19 |
| `deploy/nginx/gsplatform.conf` | Permissions-Policy 加 `xr-spatial-tracking=(self)` | §13 生产下允许 XR 会话 |

**未改动**：`apps/viewer`（Desktop Viewer）、`apps/web/src/features/viewer/*`、Desktop 的 WebGPU 渲染路径 —— 符合 §15。

---

## 4. Architecture

```text
GSPlatform
│
├── /scene/:sceneId            Desktop（未改动）
│   └── 现有 Desktop Viewer fork
│       └── WebGPU · deviceTypes:['webgpu'] · xrCompatible:false
│       └── iframe + postMessage RPC（保留）
│       └── "进入全屏" = requestFullscreen()（保留）
│       └── "进入 VR"  → 导航到 /xr/:sceneId
│
└── /xr/:sceneId   /xr/test     XR（新增，独立 runtime）
    └── supersplat-viewer@1.35.0 createViewer
        └── renderer:'webgl'  (强制，非 WebGPU)
        └── xrCompatible:true (由 supersplat-viewer 内部设置)
        └── 用户点击 Enter VR → startXR('vr') → immersive-vr XRSession
```

无 iframe、无 postMessage：用户点击与 XRSession 请求之间不存在异步 RPC 边界（§9）。

---

## 5. Tests

真实执行的命令与结果：

| 命令 | 结果 |
|---|---|
| `pnpm --filter @gsplatform/web test` | **PASS** — 12 files / 121 tests（115 原有 + 6 新增） |
| `pnpm --filter @gsplatform/web test xr-pages` | **PASS** — 6/6（Test A–F） |
| `pnpm --filter @gsplatform/web lint` | **PASS** — 0 error（8 warning，全部为预存在 authoring 文件） |
| `cd apps/web && npx vite build` | **PASS** — built in 9.07s，4472 modules，supersplat-viewer 正确打包 |
| `pnpm --filter @gsplatform/web typecheck` | **13 error，全部预存在**（基线 stash 验证同样 13）；XR 相关文件 0 error |
| `pnpm --filter @gsplatform/viewer build` | **PASS** — created dist in 22.8s（Desktop Viewer 未破坏） |
| `pnpm --filter @gsplatform/viewer typecheck` | 1 预存在错误（`src/embed.ts:679`），非本次改动 |

预存在错误基线验证方式：`git stash -u` → typecheck → 13 → `git stash pop`（已确认数量一致，非本次引入）。

### 实际页面验证（Playwright headless，web dev server :5173）

| 检查项 | 结果 |
|---|---|
| `/xr/test` 加载 | **PASS** — 显示诊断面板：Secure Context / navigator.xr / Immersive VR / UA / Protocol / Origin / Top-level / Renderer |
| `/xr/test` 不再跳登录 | **PASS** — 401 豁免生效，URL 保持 `/xr/test` |
| `/xr/local-garden` 场景加载 | **PASS** — 请求 `manifest.json` → `scene.sog`，状态 **`VIEWER-READY`** |
| supersplat-viewer 版本 | **PASS** — console 输出 `SuperSplat Viewer v1.35.0 \| Engine v2.22.4` |
| Desktop Viewer 路由未被破坏 | **PASS** — `/scene/:sceneId`、`/login` 等路由仍注册（Test E/F + 全量 121 测试） |

headless 下 `Immersive VR: unsupported` 是环境限制（无头显/OpenXR），非代码缺陷。

---

## 6. Hardware verification

**REAL XR HARDWARE TEST: NOT EXECUTED**

本机无 Quest / PICO 头显、无 OpenXR runtime（`docs/reports/PHASE_13_REPORT.md`、`PHASE_14_REPORT.md` 已记录 PICO Neo 3 不可得）。
自动测试与 Playwright **不能**证明真实进入头显；本报告不伪造真机 PASS。

### 真机测试步骤（Quest / PICO standalone Browser）

前置：XR 页面必须走 HTTPS（§12），头显访问 `http://192.168.x.x` 不是 secure context。

1. 打开 `https://<DOMAIN>/xr/test`
2. 确认页面显示：
   - `Secure Context = true`
   - `navigator.xr = true`
   - `Immersive VR = supported`
   - `Renderer = webgl2`
   - `Viewer = READY`
3. 点击 **Enter VR**
4. 预期：`WebXR state: XR-ACTIVE`，并进入双眼沉浸模式
5. 头部旋转上下左右 → 6DoF positional tracking
6. 点 **Exit VR** → `XR SESSION ENDED`，再点 **Enter VR** 重新进入
7. 通过后再测 `https://<DOMAIN>/xr/local-garden`（小 SOG，18KB）

### 失败分类处理（§22）

- `Secure Context = false` → 处理 HTTPS（自签证书或真实证书）
- `navigator.xr = false` → 浏览器 / secure context / 设备环境，不改 renderer
- `navigator.xr = true` 但 `immersive-vr = false` → 检查头显浏览器 / OpenXR runtime / 设备能力
- `immersive-vr = true` + `SecurityError` → 检查 user activation / Permissions-Policy / iframe / 页面焦点
- XRSession 创建成功但黑屏 → 才进入 renderer 排查（WebGL context / XR framebuffer / camera / stereo）
- 小 SOG 正常、大 SOG 卡顿 → WebXR 已通过，属下一阶段性能问题

---

## 7. Remaining issues

**本阶段明确未做（§23）**：Streamed SOG / LOD / 大规模流式 / XR annotation / collision / locomotion / controller interaction / XR UI / skybox / audio / teleport / 场景编辑 / Unity / EXE / OpenXR native app。

**已知限制**：
- `/xr/:sceneId` 对 streamed-sog 场景（如 `r-8c4e2264e86a`）会明确报错 `STREAMED_SOG_UNSUPPORTED`，而不是静默失败 —— 符合第一阶段边界。
- `apps/web` 的 13 个 typecheck 预存在错误（authoring 相关）会阻塞 `pnpm build`（该脚本为 `tsc -b && vite build`）；本次未修（属无关重构，§0 原则 3）。已用 `npx vite build` 单独验证打包正确。
- `/xr/*` 豁免了 401 登录跳转；若未来 XR 页面需要后端数据（annotations 等），需重新设计认证方式。
- 生产 nginx 的 `add_header` 继承规则需注意：`add_header` 在子 location 重新声明时会覆盖父级 —— 部署后必须用 `curl -I https://DOMAIN/xr/test` 与 `curl -I https://DOMAIN/` 确认 `Permissions-Policy` 实际响应头包含 `xr-spatial-tracking=(self)`，不能仅凭配置文件判断。

---

# Second-round fixes（第二轮修复）

日期：2026-09-24 · 基于 commit `38ab32c`

## 1. XR system-exit state synchronization（§3/§4/§5）

**问题**：第一轮 `XRTestPage` / `XRViewerPage` 在用户点击 Enter VR 后直接把 React state 设为 `xr-active`。若用户通过 Quest/PICO 系统菜单、浏览器系统 UI 退出 XR，`startXR()` 的 promise 早已 resolve，页面仍会停留在 `xr-active` —— 状态与真实 session 不一致。

**根因审计**（读 `@playcanvas/supersplat-viewer@1.35.0` dist 源码确认，非猜测）：
- `dist/viewer.js:10383` — `state.xrMode = xr.type === 'immersive-ar' ? 'ar' : 'vr'`（绑定 PlayCanvas XrManager 的 `'start'` 事件）
- `dist/viewer.js:10397` — `state.xrMode = null`（绑定 XrManager 的 `'end'` 事件，**包含系统菜单退出路径**）
- `dist/viewer.js:1641` — `events.fire(\`${property}:changed\`, value, prev)`，因此 `events.on('xrMode:changed', cb)` 会在上述两种情况下触发

**修复**：
- `XRViewerRuntime.ts` 新增 `onXRModeChanged(callback: (mode: XRMode) => void): () => void`（返回 unsubscribe），内部绑定 `xrMode:changed`，归一化 `'vr' | 'ar' | null`。
- `XRTestPage` / `XRViewerPage` 组件 mount 时订阅；`mode === 'vr' | 'ar'` → `xr-active`；`mode === null` 且曾进入过 XR（`hadXRRef`）→ `xr-ended`。组件卸载时调用 unsubscribe（`unsubRef`），不产生 listener leak。
- 保留 `startXR()` resolve 后的兜底置 active（极少数浏览器事件不触发的情况）。

**结果**：系统退出后页面自动变 `xr-ended`，再次点击 Enter VR 可重新进入，无需刷新页面。

## 2. Test scene URL resolution（§6/§7）

**问题**：`const TEST_SOG = '/local-scenes/local-garden/scene.sog'` 硬编码。部署到服务器后 `scenes/` 是 git-ignored 本地数据，该路径可能 404；且场景 404 会被误判为 WebXR 失败。

**修复**：`resolveTestScene()` 三级优先级：
```
URL query ?scene=<url>  ??  env VITE_XR_TEST_SCENE_URL  ??  /local-scenes/local-garden/scene.sog
```
用法：`/xr/test?scene=/local-scenes/local-garden/scene.sog` 或 `/xr/test?scene=https://domain/path/test.sog`。

## 3. Scene loading diagnostics（§8/§9/§13）

**修复**：
- `XRTestPage` 诊断面板新增 `Test Scene URL`、`Scene`（`LOADING` / `READY` / `FAILED — <error>`）、`Last XR error`（含 `kind :: name: message`）三行。
- 场景加载完成（`runtime.loadedPromise` resolve）才置 `Scene: READY`。
- 错误分类显示，三者互不混淆：
  - `SCENE LOAD ERROR`（`createXRRuntime` 失败，如 HTTP 404）
  - `WebXR support failure`（secure context / immersive-vr 不支持）
  - `XR SESSION START FAILED`（`startVR()` 抛错，含 Error name + message）
- Enter VR 按钮启用条件收紧为 `viewer-loaded && scene-ready`（§15），否则 disabled。

## 4. sceneResolver fix（§10/§11）

**问题**：`raw.format === 'streamed-sog' || raw.schemaVersion === 1` —— `schemaVersion` 只是 manifest schema 版本，与是否流式无关，误杀所有 schema v1 的单文件场景。

**审计**（`rg` 全部真实 manifest）：
```
scenes/local-garden/manifest.json      {"format": "sog"}
scenes/progressive-test/manifest.json  {"format": "sog"}
scenes/r-8c4e2264e86a/current/...       {"schemaVersion": 1, "format": "streamed-sog", "stream": {...}}
scenes/stream-{small,medium,large}/...  {"schemaVersion": 1, "format": "streamed-sog", "stream": {...}}
```
流式场景同时具备 `format === 'streamed-sog'` 与 `stream` 对象两个真实标识。

**修复**：`isStreamed = raw.format === 'streamed-sog' || typeof raw.stream === 'object'` —— 只依据真实字段，`schemaVersion` 不再参与判断。

## 5. Tests

| 命令 | 结果 |
|---|---|
| `pnpm --filter @gsplatform/web test` | **PASS** — 13 files / **131 tests**（第一轮 121 + 本轮 10） |
| `pnpm --filter @gsplatform/web lint` | **PASS** — 0 error（仅 warning，预存在 authoring 文件） |
| `cd apps/web && npx vite build` | **PASS** — built in 11.29s |
| `pnpm --filter @gsplatform/viewer build` | **PASS** — created dist in 41.7s（Desktop Viewer 未破坏） |
| `pnpm --filter @gsplatform/web typecheck` | 13 error，**全部预存在**（基线 stash 验证一致）；本轮 XR 文件 0 error |

新增测试：
- `apps/web/src/__tests__/xr-scene-resolver.test.ts`（6 例）— Case A `schemaVersion:1 + format:sog` 允许；Case B `format:streamed-sog` → `STREAMED_SOG_UNSUPPORTED`；Case C legacy 正常；Case D `stream` 字段存在 → 流式；Case E 404 → `SCENE_NOT_FOUND`；Case F 缺 assetUrl → `ASSET_FETCH_FAILED`
- `apps/web/src/__tests__/xr-pages.test.tsx`（重写，10 例）— Test 1 `navigator.xr` 缺失不 crash；Test 2 immersive-vr unsupported；Test 3 scene load failed 显示 `SCENE LOAD ERROR` 且不显示 session error；Test 4 `xrMode → 'vr'` → XR-ACTIVE；Test 5 `xrMode → null` → XR-ENDED；Test 6 退出后重新进入状态恢复；Test 7/8 路由 + sceneResolver 关联；Test A 诊断面板；Test D SecurityError 归类到 session error

## 6. Runtime startup

web dev server 常驻运行（setsid 脱离 harness，重启会话不退出）：

```bash
setsid nohup pnpm --filter @gsplatform/web dev --host 0.0.0.0 > /tmp/gs-web-dev.log 2>&1 &
```

- **Port**: 5173（`vite.config.ts` 固定 `port: 5173`）
- **PID**: 2502721（`node .../vite.js --host 0.0.0.0`）
- **LAN IP**: `10.121.2.78`（eno1 /24，`hostname -I` 实测）
- API 8001 在回环监听（`python`, PID 2042875）— `/xr/*` 不依赖 API

## 7. URLs

| 用途 | 地址 | 说明 |
|---|---|---|
| PC 本机 | `http://localhost:5173/xr/test`<br>`http://127.0.0.1:5173/xr/test` | PC 浏览器调试 UI（localhost 是 secure context） |
| LAN 页面连通性 | `http://10.121.2.78:5173/xr/test`<br>`http://10.121.2.78:5173/xr/local-garden` | **仅用于检查头显能否连到电脑、页面能否打开。HTTP + 非 localhost 不是 secure context，不能保证创建 WebXR immersive-vr session。** |
| Quest/PICO WebXR | **NOT AVAILABLE YET** | `apps/web` 无 HTTPS dev 配置，且 `deploy/nginx/gsplatform.conf` 的 `<DOMAIN>` 是占位符、尚未部署到真实域名。要做真机 WebXR 需：把当前 build 部署到现有 HTTPS 域名（`https://DOMAIN/xr/test`），或为 dev server 配置证书被头显浏览器信任的 HTTPS。 |

> 注意：`apps/xr-viewer/.certs/` 下的自签证书只服务于第一轮那个独立 xr-viewer（端口 5180），`apps/web` 的 dev server 未启用 HTTPS。自签证书在 Quest/PICO 内置浏览器上默认不受信任，**不能**仅因为 URL 是 `https://` 就认为 Secure Context 有效。

## 8. Hardware test status

**XR HARDWARE TEST: NOT EXECUTED** —— 本机无 Quest/PICO 头显、无 OpenXR runtime（`docs/reports/PHASE_13_REPORT.md`、`PHASE_14_REPORT.md` 已记录 PICO Neo 3 不可得）。不伪造真机 PASS。

真机测试需在 HTTPS 环境打开 `/xr/test`，预期诊断：
```
Secure Context: true
navigator.xr: true
Immersive VR: supported
Viewer: READY
Renderer: webgl2
Scene: READY
XR state: viewer-ready
```
点击 Enter VR → `XR state: xr-active`；**用头显系统菜单退出**（而非页面上的 Exit VR 按钮）→ 页面应自动变 `xr-ended`；再次 Enter VR 可重新进入。
