# Phase 02：Scene Viewer 基础集成

## 阶段目标

把 `apps/viewer` 中的 SuperSplat Viewer fork 通过稳定适配层接入平台全屏路由，使一个来源合法的真实 SOG 场景能够加载、渲染、旋转、缩放、平移、重置、切换 Orbit/Fly，并在离开页面时完整释放资源。

本阶段验证“真实场景能看”，不宣称已实现 Phase 03 的渐进加载或 Phase 04 的 Streamed SOG 分片策略。

## 前置条件

- [ ] `docs/reports/PHASE_01_REPORT.md` 存在且状态为 `PASS`。
- [ ] Viewer fork 来源、许可证和基线 commit 可追踪。
- [ ] 已准备一个项目自有或许可证允许的测试 SOG 场景和来源记录。
- [ ] 测试浏览器支持项目所需的图形能力。
- [ ] 已记录 Phase 02 开始前 commit。

## 禁止事项

- 禁止重写 Gaussian renderer 或绕开 SuperSplat Viewer / PlayCanvas Engine。
- 禁止复制第三方 Viewer 的品牌皮肤、Logo、示例图片或专有文案。
- 禁止使用 Poster、视频或 Canvas 动画冒充真实 3D 渲染。
- 禁止把完整文件下载称为 Streamed SOG；该能力属于 Phase 04。
- 禁止把定时器百分比称为加载进度；真实进度属于 Phase 03。
- 禁止把测试场景大文件提交进 Git。
- 禁止自动 push。

## 纯文本架构草图

```text
React route /scene/:sceneId
            |
            v
+-------------------------------+
| SceneViewerPage               |
| - route lifecycle             |
| - error boundary              |
| - right/bottom UI shell       |
+---------------+---------------+
                | ViewerAdapter contract
                v
+-------------------------------+
| @gsplatform/viewer            |
| create / load / control       |
| resize / stats / destroy      |
+---------------+---------------+
                |
                v
+-------------------------------+
| SuperSplat Viewer fork        |
| PlayCanvas Engine             |
| real SOG asset                |
+-------------------------------+
```

### 全屏 Viewer 页面

```text
+----------------------------------------------------------------------------------------+
| [返回] 场景标题                                          [状态] [进入全屏] [关闭]      |
|                                                                                        |
|                                                                                        |
|                         真实 Gaussian 场景 Canvas                                       |
|                                                                                        |
|                                                                  +------------------+  |
|                                                                  | 作者             |  |
|                                                                  | 收藏（未接后端） |  |
|                                                                  | 分享             |  |
|                                                                  | 问 AI（说明）    |  |
|                                                                  | 详情             |  |
|                                                                  +------------------+  |
|                                                                                        |
|          +------------------------------------------------------------------+          |
|          | Reset | Orbit / Fly | Performance | Quality | Help               |          |
|          +------------------------------------------------------------------+          |
+----------------------------------------------------------------------------------------+
```

## 详细 Checklist

### A. Viewer 适配层

- [ ] `apps/viewer` 导出项目自有、最小且有类型的 Viewer API。
- [ ] API 至少支持 `create`、`loadScene`、`resetCamera`、`setCameraMode`、`resize`、`getStats`、`destroy`。
- [ ] Web 只依赖适配层，不直接散落调用 PlayCanvas 内部对象。
- [ ] 加载参数使用受控 DTO，不把任意 URL 直接交给渲染器。
- [ ] Viewer 初始化失败可返回结构化错误。

### B. 真实场景加载

- [ ] 测试 SOG 的来源、许可证、体积和校验和有记录。
- [ ] 场景放在 Git 忽略的本地资产目录或独立静态服务中。
- [ ] `/scene/:sceneId` 能解析本地开发 manifest 并取得真实资产 URL。
- [ ] 网络请求成功，响应类型、长度和 CORS 符合要求。
- [ ] 首帧确实由真实高斯数据渲染，非 Poster 或录屏。
- [ ] 无效 sceneId、404 资产、损坏文件均显示可恢复错误。

### C. 相机与控制

- [ ] Orbit 模式支持旋转、缩放与平移。
- [ ] Fly 模式支持键盘与指针导航，并明确显示当前模式。
- [ ] Reset 恢复 manifest 中的初始相机或经过验证的自动取景。
- [ ] 相机 near/far、FOV 和速度适合测试场景，不产生明显裁切。
- [ ] 输入焦点位于表单或对话框时，Viewer 不劫持按键。
- [ ] Help 面板列出鼠标、触控和键盘控制。

### D. 页面集成

- [ ] Canvas 填满挂载区，窗口缩放后分辨率和纵横比正确。
- [ ] 全屏进入和退出行为可用，失败时有提示。
- [ ] 右侧工具和底部工具不阻挡关键 Canvas 输入。
- [ ] `Performance` 显示 Viewer 返回的真实 FPS / splat / frame time 数据。
- [ ] `Quality` 在本阶段只展示真实可用选项；未实现选项明确禁用。
- [ ] 分享使用当前平台 URL，不含本地文件路径和令牌。

### E. 生命周期与性能基线

- [ ] 切换 sceneId 时取消旧请求并销毁旧场景。
- [ ] 离开 Viewer 路由时移除事件监听、ResizeObserver 和动画循环。
- [ ] 释放 object URL、GPU buffer、texture、entity 和应用实例。
- [ ] 连续进入/退出同一场景 10 次无持续增长的 Canvas 或监听器。
- [ ] 浏览器失去 WebGL 上下文时显示可恢复错误或刷新说明。
- [ ] 首帧时间、稳定 FPS、峰值内存作为基线写入报告。

### F. 测试与收尾

- [ ] ViewerAdapter 有单元测试或契约测试。
- [ ] 路由挂载/卸载和错误状态有组件测试。
- [ ] 使用真实小型 SOG 执行浏览器 smoke test。
- [ ] 人工验证 Orbit、Fly、Reset、Resize、Fullscreen 和 Help。
- [ ] lint、typecheck、test、build 全部成功。
- [ ] 生成 `docs/reports/PHASE_02_REPORT.md`。
- [ ] 执行三项 Git 自检并创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### ViewerAdapter 契约

推荐把上游对象封装在 `apps/viewer/src/platform/`，导出类似以下能力，具体名称可调整但语义必须稳定：

```text
createViewer(container, options) -> ViewerHandle
ViewerHandle.loadScene(descriptor, abortSignal)
ViewerHandle.resetCamera()
ViewerHandle.setCameraMode("orbit" | "fly")
ViewerHandle.resize(width, height, devicePixelRatio)
ViewerHandle.getStats() -> fps/frameTime/splatCount
ViewerHandle.destroy()
```

`SceneViewerPage` 不能持有 PlayCanvas 私有实现细节。上游同步造成的变化只应在适配层内消化。

### SceneDescriptor

本阶段可使用本地 manifest，但字段从一开始保持稳定：

```json
{
  "id": "local-garden",
  "title": "示例庭院",
  "format": "sog",
  "assetUrl": "/local-scenes/local-garden/scene.sog",
  "posterUrl": "/local-scenes/local-garden/poster.webp",
  "sha256": "<真实校验和>",
  "camera": {
    "position": [0, 1.2, 3.5],
    "target": [0, 0.8, 0],
    "fov": 55
  }
}
```

`posterUrl` 可以保存但本阶段不以其代替 Canvas。Phase 03 再实现加载层。

### 错误分类

至少区分：`SCENE_NOT_FOUND`、`ASSET_FETCH_FAILED`、`ASSET_INVALID`、`GRAPHICS_UNSUPPORTED`、`VIEWER_INIT_FAILED`、`CONTEXT_LOST`。界面显示用户可理解消息，开发日志保留无秘密的诊断上下文。

### 资源释放

React Strict Mode 在开发环境可能触发重复挂载。创建和销毁必须幂等；异步加载完成时若 signal 已取消，不得再写入已卸载组件或已销毁 Viewer。

## 关键目录 / 文件

```text
apps/viewer/src/
|-- platform/
|   |-- index.ts
|   |-- ViewerAdapter.ts
|   |-- SceneDescriptor.ts
|   `-- ViewerError.ts
`-- upstream/                  fork 原有实现或清晰边界

apps/web/src/
|-- pages/SceneViewerPage.tsx
|-- features/viewer/
|   |-- ViewerCanvas.tsx
|   |-- ViewerToolbar.tsx
|   |-- ViewerStats.tsx
|   |-- ViewerErrorState.tsx
|   `-- useViewerLifecycle.ts
`-- services/scenes.local.ts

scenes/local-garden/            Git 忽略
|-- scene.sog
|-- poster.webp
`-- manifest.json
```

## 运行命令

```bash
pnpm install --frozen-lockfile
pnpm --filter @gsplatform/viewer build
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
```

启动本地场景静态服务或使用项目已配置的 Vite 静态目录后访问：

```text
http://localhost:5173/scene/local-garden
```

## 验收标准

- 真实 SOG 场景在平台全屏页中形成可辨识的高斯首帧。
- Orbit、Fly、Reset、Resize、Fullscreen 可实际操作。
- Performance 数据来自 Viewer 实时统计，不是固定值。
- 404 与损坏资产显示明确错误并允许返回或重试。
- 路由进入/退出 10 次无重复 Canvas、重复动画循环或明显持续内存增长。
- Viewer 与 Web 构建成功，测试和类型检查通过。
- 测试资产来源合法且不进入 Git。

## 自测命令

```bash
pnpm --filter @gsplatform/viewer lint
pnpm --filter @gsplatform/viewer typecheck
pnpm --filter @gsplatform/viewer test --run
pnpm --filter @gsplatform/viewer build
pnpm --filter @gsplatform/web lint
pnpm --filter @gsplatform/web typecheck
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
pnpm test
pnpm build
git status
git diff --stat
git diff
```

若有浏览器自动化：

```bash
pnpm --filter @gsplatform/web test:e2e --grep "scene viewer"
```

## 必须产物

- 稳定、类型化的 ViewerAdapter。
- 平台全屏路由中的真实 SOG 渲染。
- 相机、全屏、统计、错误和 Help 交互。
- 真实场景 smoke test 与生命周期测试。
- 测试场景来源及校验和记录，但不提交场景大文件。
- `docs/reports/PHASE_02_REPORT.md`。
- 一个仅包含 Phase 02 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 场景 / 浏览器 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P02-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_02_REPORT.md`：

```markdown
# Phase 02 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：

## 环境与真实测试资产

- OS / Browser / GPU：
- Viewer fork commit：
- Scene ID / size / SHA-256：
- 资产来源与许可证记录：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 真实渲染与交互结果

| 项目 | PASS/FAIL | 测量 / 说明 |
|---|---|---|
| 首帧 |  |  |
| Orbit / Fly / Reset |  |  |
| Resize / Fullscreen |  |  |
| 错误恢复 |  |  |
| 10 次挂载卸载 |  |  |

## 性能基线

- 首帧时间：
- 稳定 FPS / frame time：
- splat 数：
- 峰值内存：

## 自动测试与构建

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 03 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 02 的独立执行 Agent。先阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md、docs/PHASE_02_SCENE_VIEWER.md，并确认 docs/reports/PHASE_01_REPORT.md 为 PASS。门禁不满足时不得继续。

只完成 Scene Viewer 的真实基础集成。必须使用 apps/viewer 中可追踪的 SuperSplat Viewer fork 与 PlayCanvas Engine，不重写 Gaussian renderer。通过类型化 ViewerAdapter 将 create/load/reset/orbit-fly/resize/stats/destroy 暴露给 React。使用来源合法且有 SHA-256 记录的真实小型 SOG 场景验证，不把场景大文件提交 Git。

真实测试 Orbit、Fly、Reset、Resize、Fullscreen、Performance、错误状态、切换 sceneId 和 10 次挂载卸载。Poster、录屏、Canvas 动画、固定性能数字都不能作为 3D 成功证据。本阶段不要宣称已完成渐进加载或 Streamed SOG。

只有真实运行、测试和页面验证成功后才把 [ ] 改为 [x]。失败或无法验证保持 [ ] 并写 Known Issues。执行本文自测命令，生成 docs/reports/PHASE_02_REPORT.md，再运行 git status、git diff --stat、git diff。PASS 后创建 Phase 02 独立 commit，不 push。最终汇报真实资产、交互结果、性能基线、未完成项、报告路径和 commit hash。
```

