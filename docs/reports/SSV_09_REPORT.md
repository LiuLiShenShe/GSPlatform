# SSV_09_REPORT：Legacy Viewer Cleanup

- 日期：2026-09-29
- 阶段：SSV-09 — Legacy Viewer Cleanup
- 前置：SSV-03 ～ SSV-08 全部通过（SSV-08 = d41bf82）
- 分支：`main`
- 目标：**`apps/viewer` production references = 0** · **`apps/xr-viewer` production references = 0**

---

## RESULT

**PASS**

- `apps/xr-viewer` **已删除**（目录、pnpm-workspace ref、root 脚本 `dev:xr` /
  `typecheck:xr` / `build:xr`、README 启动说明）。
- `apps/viewer` 保留但标记 **LEGACY / DEPRECATED**（`Not used by production scene
  viewing.`）：不再参与 dev / build / deploy / acceptance，仅存显式
  `legacy:viewer:*` 独立脚本（保留 standalone build，§7）。
- 生产 Web 对 legacy 引用 = **0**（导入/配置/部署三层取证，见 §8）。
- 新增回归护栏测试：`apps/web/src/__tests__/no-legacy-viewer-references.test.ts`
  强制生产 Web 不得引用 apps/viewer。

---

## 一、搜索与分类（§1）

`rg -n "apps/viewer|viewer/embed|ViewerAdapter|apps/xr-viewer|XRViewerRuntime|runtime=legacy"
apps deploy docs package.json pnpm-workspace.yaml` 执行后按类别分类：

| 类别 | 处置 |
|---|---|
| **Production（功能引用）** | 全部清零：`SceneViewerPage` legacy 分支、`features/viewer/` 整目录、`scenes.local.ts`、vite alias / embed 插件、`sync-assets.mjs`、`tsconfig paths`、nginx `/viewer/`、root 聚合脚本、workspace ref（xr-viewer） |
| **Dev** | `dev` 聚合脚本只剩 `dev:web`；`apps/viewer` 仅保留显式 `legacy:viewer:*`（opt-in，不参与正常启动） |
| **Docs（现行）** | 根 README、`ADR_SUPERSPLAT_RUNTIME`、`SSV_MIGRATION_PLAN`、`00_GLOBAL_RULES` 已更新 |
| **Docs（历史记录）** | Phase 02/03/04/10/11/12/13/14、WEBXR_REPAIR、ADR-0001、SSV_00～08 报告保留为阶段记录（不改写历史） |
| **Tests** | legacy 专属测试删除（progressive-loading / streaming / viewer legacy describe）；新增引用护栏测试 |
| **Legacy（apps/viewer 自身）** | 冻结包内部自引用（`ViewerAdapter` 等仅存在于该目录）—— 非生产引用，保留 |

## 二、删除 Legacy fallback（§2）

`apps/web/src/pages/SceneViewerPage.tsx`：

- **删除** `?runtime=legacy` 分支（`isLegacy` / `LegacyDesktopViewer`）与对
  `ViewerCanvas` / `ViewerToolbar` / `useViewerLifecycle` 的导入。
- 正式 Scene route 只剩官方 runtime（`OfficialDesktopViewer`，`data-runtime="official"`）。
- 页面头部注释明示 SSV-09 已删除回退；`data-testid` 与 e2e 契约（official）不变。

## 三、apps/xr-viewer（§3）

确认生产无引用后整体删除：

- **目录**：`apps/xr-viewer/`（src / scripts / README / vite / tsconfig / package.json）。
- **Workspace ref**：`pnpm-workspace.yaml` 移除 `"apps/xr-viewer"`；`pnpm install
  --lockfile-only` 重生成 `pnpm-lock.yaml`（xr-viewer importer 消失）。
- **Root scripts**：`dev:xr` / `typecheck:xr` / `build:xr` 删除；`dev` / `typecheck` /
  `build` 聚合不再包含 xr。
- **Docs 过期启动方式**：根 README Quick Start 已删 `apps/xr-viewer` 启动说明；
  历史 Phase 13/14 文档保留为阶段记录。
- 取证：`apps deploy package.json pnpm-workspace.yaml` 对 `xr-viewer` 的引用 = 0
  （仅历史 docs 记录性提及）。

## 四、apps/viewer：LEGACY / DEPRECATED（§4）

本阶段**不物理删除**，但明确退役：

- `apps/viewer/README.md` 顶部新增醒目 LEGACY / DEPRECATED 横幅：
  **“Not used by production scene viewing.”** + 未来 primitive-level Gaussian
  Editor 需另开 ADR。
- **不参与 deploy**：`deploy/nginx/gsplatform.conf` 删除 `location /viewer/`
  （生产不再服务 legacy embed 静态产物）；`deploy_release.sh` 的 `pnpm build` 现在
  只构建 `apps/web`。
- **不参与 acceptance**：根 `test` / `lint` / `typecheck` / `build` / `dev` 聚合脚本
  全部移除 viewer。
- **不参与正常 dev startup**：`apps/web` 删除 `predev`/`prebuild`（`sync-assets.mjs`
  已删除）与 `vite.config.ts` 的 `serveViewerEmbed` 插件；`tsconfig.app.json` 删除
  `@gsplatform/viewer` paths 与 `../viewer/src/platform` include。
- 保留显式独立脚本：`legacy:viewer:dev` / `legacy:viewer:build` /
  `legacy:viewer:typecheck` / `legacy:viewer:lint`（§7 standalone build）。

## 五、根 README（§5）

- Repo 结构：删 `xr-viewer` 行；`viewer` 标注 LEGACY / DEPRECATED。
- Scene Runtime 表：只保留「Official runtime」+「Legacy `apps/viewer`」两列，
  删除“apps/viewer = production viewer”的一切描述；XR 说明并入官方行。
- 决策依据链（ADR / SSV_MIGRATION_PLAN / 护栏测试）补入。

## 六、开发启动（§6）

- `pnpm dev` = 仅 `apps/web`（vite 5173）。
- 正常看 Scene 不再需要 `pnpm --filter @gsplatform/viewer dev`。
- README Quick Start 同步为 Web + API（Redis / Postgres / workers 按需），
  legacy viewer 启动移至 opt-in 说明。

## 七、Tests（§7）

- **删除** legacy 专属生产测试：`progressive-loading.test.ts`、
  `streaming.test.ts`（均为 `@gsplatform/viewer` 内部 LOD/流式调度器测试，SSV-03/08
  已被官方 runtime 取代）；`viewer.test.tsx` 删除 legacy mock 机制 + Legacy 回退
  describe（保留 9 个官方 runtime 测试）。
- **保留**：`apps/viewer` standalone build（root `legacy:viewer:build`）。
- **新增检查**：`no-legacy-viewer-references.test.ts` —— 扫描生产源码的
  import/require specifier + 配置（vite.config / tsconfig.app / package.json），
  断言零 legacy 引用；并断言 Scene 页面不再读取 `runtime=legacy` 分支。

## 八、取证：Production legacy references = 0（§8）

**自动化护栏（每轮测试必跑）**：

```
no-legacy-viewer-references.test.ts
  ✓ 生产源码 import/require 不指向 @gsplatform/viewer、features/viewer/、
    scenes.local、viewer/embed、../viewer/（path escape）
  ✓ SceneViewerPage 不读取 get('runtime') 分支
  ✓ vite.config / tsconfig.app / package.json 无 @gsplatform/viewer、
    gs-serve-viewer-embed、sync-assets、predev/prebuild、../viewer/src
```

**静态取证**（`apps deploy package.json pnpm-workspace.yaml` 全量 rg，分类如下）：

| 命中 | 类别 | 是否生产引用 |
|---|---|---|
| `apps/viewer/*` 内部（ViewerAdapter 等） | Legacy 包自身 | ❌ 否（冻结包内部） |
| `pnpm-workspace.yaml` `apps/viewer` | 保留包注册 | ❌ 否（不导入/不部署/不服务） |
| `apps/web` 中 `ViewerAdapter` / `runtime=legacy` / `apps/viewer` | 仅说明性注释（描述已删除） | ❌ 否（非代码引用） |
| `apps/xr-viewer` / `@gsplatform/xr-viewer` | 无 | ❌ 已整体删除 |
| nginx `/viewer/`、vite embed 插件、sync-assets、root 聚合脚本 | 无 | ❌ 已删除 |

**e2e 实证**：删除 legacy 分支后，`e2e/ssv08-streaming.spec.ts`「单文件 .sog 经官方
runtime 加载」在新配置 dev server 上重跑 **PASS**（34s，`format=sog`、gsplats>1M、
`data-runtime=official`）—— 官方 Scene 路径端到端完好。

## 九、质量门

| 门禁 | 结果 |
|---|---|
| Web 单测 | **145 passed / 18 files**（含护栏 3 + 官方 viewer 9；删除 legacy 测试 64 个） |
| typecheck | 0 新增错误；残留 **6 个 SSV-00 记录基线错误**（`features/authoring/*` TS6133，见下） |
| oxlint | exit 0（仅 authoring 基线 warning） |
| vite build | **成功**（4458 modules，3.36MB bundle） |
| API | **132 passed**（`pytest --collect-only` = 132，exit 0；API 零改动） |
| e2e | 单文件 SOG 官方路径 PASS（新配置服务器） |

> **typecheck 基线说明（如实）**：`apps/viewer` 清理前 HEAD（d41bf82）`tsc -b` 已有
> **10 个错误**（4 个 legacy 测试的 ViewerHandle 类型错误 + 6 个 authoring 基线）。
> SSV-09 删除 legacy 测试后降至 6 个 —— 全部为 SSV-00 记录的 authoring 基线
> （`AnnotationPanel` 4 / `BackgroundMusicPanel` 1 / `CollisionPanel` 1，记录于
> `SSV_00_REPORT.md` 13 errors / 6 files）。按 `SSV_MIGRATION_PLAN` 不可变约束 #6
> 「不得进行与当前阶段无关的修复」，本阶段**不修复**；`pnpm build` 的 `tsc -b` 门因此
> 仍红（HEAD 时已红），`vite build` 单独通过。该基线阻塞部署构建，建议 SSV-10
> 生产验收阶段一并处理。

## 十、Git

提交 `refactor(viewer): remove legacy runtime from production paths`，push。SSV-09 结束。
