# GSPlatform 分阶段 Agent 提示词索引

## 1. 使用方式

每个 Phase 文档末尾都有一段可直接复制给独立 Agent 的执行提示词。执行顺序必须是 00 到 09；不要把多个 Phase 合并给同一个 Agent 一次完成。

```text
选择当前 Phase
    |
    v
检查上一 Phase Report 是否 PASS
    | 否
    +------> 停止，报告门禁失败
    |
   是
    v
复制该 Phase 的“独立 Agent 执行提示词”
    |
    v
Agent 实现 -> 真实运行 -> 真实测试 -> 人工验收
    |
    v
仅成功项 [ ] -> [x]
    |
    v
生成 PHASE_<N>_REPORT.md
    |
    v
git status / git diff --stat / git diff
    |
    v
PASS 后单独 commit，不 push
```

## 2. Phase 提示词入口

| Phase | 执行文档 | 核心目标 | 前置报告 |
|---|---|---|---|
| 00 | [PHASE_00_BOOTSTRAP.md](PHASE_00_BOOTSTRAP.md#独立-agent-执行提示词) | 三应用工程骨架 | 无 |
| 01 | [PHASE_01_FRONTEND_UI.md](PHASE_01_FRONTEND_UI.md#独立-agent-执行提示词) | 五个产品页面与 5 列首页 | Phase 00 PASS |
| 02 | [PHASE_02_SCENE_VIEWER.md](PHASE_02_SCENE_VIEWER.md#独立-agent-执行提示词) | 真实 SOG Viewer | Phase 01 PASS |
| 03 | [PHASE_03_PROGRESSIVE_LOADING.md](PHASE_03_PROGRESSIVE_LOADING.md#独立-agent-执行提示词) | Poster 与真实渐进进度 | Phase 02 PASS |
| 04 | [PHASE_04_STREAMED_SOG_LOD.md](PHASE_04_STREAMED_SOG_LOD.md#独立-agent-执行提示词) | Streamed SOG / LOD | Phase 03 PASS |
| 05 | [PHASE_05_BACKEND_DATABASE.md](PHASE_05_BACKEND_DATABASE.md#独立-agent-执行提示词) | PostgreSQL 持久化 API | Phase 04 PASS |
| 06 | [PHASE_06_UPLOAD_PUBLISH.md](PHASE_06_UPLOAD_PUBLISH.md#独立-agent-执行提示词) | 上传、校验、原子发布 | Phase 05 PASS |
| 07 | [PHASE_07_RECONSTRUCTION.md](PHASE_07_RECONSTRUCTION.md#独立-agent-执行提示词) | 真实 3DGS 重建 | Phase 06 PASS |
| 08 | [PHASE_08_PLATFORM_FEATURES.md](PHASE_08_PLATFORM_FEATURES.md#独立-agent-执行提示词) | 账户与平台业务功能 | Phase 07 PASS |
| 09 | [PHASE_09_DEPLOYMENT.md](PHASE_09_DEPLOYMENT.md#独立-agent-执行提示词) | Ubuntu 生产部署 | Phase 08 PASS |

## 3. 所有提示词的不可省略要求

无论复制哪个 Phase 的提示词，以下规则始终生效：

1. 固定技术栈不可擅自替换。
2. 不重新实现 Gaussian renderer，Viewer 使用可追踪的 SuperSplat Viewer fork 和 PlayCanvas Engine。
3. 不复制第三方品牌、Logo、图片、专有文案。
4. 只有代码/配置真实存在、依赖真实安装、命令真实运行、测试真实通过、页面/API/Viewer 真实验证成功，才能把 `[ ]` 改成 `[x]`。
5. 代码存在但未运行不得勾选。
6. 失败或无法验证保持 `[ ]`，在 Known Issues 和报告中写明原因。
7. 前一 Phase 报告不是 `PASS`，不得开始下一 Phase。
8. 每阶段生成 `docs/reports/PHASE_<N>_REPORT.md`。
9. 每阶段结束必须执行 `git status`、`git diff --stat`、`git diff`。
10. 自检后每阶段单独 commit，绝不自动 push。

## 4. 通用执行前缀

如果执行环境需要额外强调规则，可把下面内容放在任一 Phase 提示词之前：

```text
你正在执行 GSPlatform 的单一开发阶段。你必须先完整阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md 和指定 Phase 文档。严格遵守阶段门禁，不得扩展到下一阶段。

Checklist 是验收记录，不是愿望清单。只有真实运行、真实测试、真实页面/API/Viewer 验证成功后，才允许 [ ] 改为 [x]。代码存在但未运行不得勾选；失败或无法验证保持 [ ]，写入 Known Issues 和 Phase Report。不得伪造命令输出、日志、百分比、渲染或成功状态。

保护用户已有改动，不覆盖阶段外文件，不提交密钥和大场景。阶段末执行 git status、git diff --stat、git diff，生成规定的 PHASE Report。报告为 PASS 后只做本阶段 commit，不执行 git push。
```

## 5. 通用核验 Agent 提示词

该提示词用于让另一个 Agent 独立复核已经实现的单一 Phase。核验 Agent默认只读；除非负责人明确要求修复，否则不得改代码。

```text
你是 GSPlatform 的独立验收 Agent。要核验的阶段是 Phase <NN>。

完整阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md、对应 Phase 文档、docs/reports/PHASE_<NN>_REPORT.md。逐项检查所有已勾选 [x] 是否拥有真实证据：文件存在、依赖安装、命令退出码、自动测试、真实页面/API/Viewer/任务验证。不要相信报告里的结论，必须在当前环境重新运行风险相称的自测和抽样人工验收。

重点查找：
- 代码存在但未运行就勾选；
- mock、placeholder、硬编码、定时器、伪日志或旧产物冒充完成；
- 前一 Phase 非 PASS 仍继续；
- 第三方品牌/素材复制或许可证缺失；
- 密钥、大文件、内部路径、权限绕过；
- Git 中混入阶段外修改；
- 报告与当前 commit 不一致。

默认不要修改代码。输出每个失败项的文档路径、Checklist 原文、复现命令、预期、实际和严重性。任何一项必做内容不能复现，就建议把对应 [x] 恢复为 [ ]，并将阶段结论改为 FAIL/BLOCKED。最后执行并报告 git status、git diff --stat、git diff 的只读结果，不 commit，不 push。
```

## 6. 通用修复提示词

当验收报告指出具体失败时，使用下面的提示词修复当前 Phase，不进入下一 Phase：

```text
你是 GSPlatform Phase <NN> 的修复 Agent。只修复验收报告中列出的失败项，不进入下一 Phase，不重构无关模块。

先阅读全局规则、当前 Phase 文档、当前 Phase Report 和独立验收报告。逐个复现问题，保留用户已有改动。修复后运行对应单元、集成、E2E、页面/API/Viewer/任务真实验收。只有重新验证成功的项才可 [ ] -> [x]；其余保持 [ ] 并更新 Known Issues。

更新 docs/reports/PHASE_<NN>_REPORT.md，明确旧失败、修复、真实命令与新结果。执行 git status、git diff --stat、git diff。只有全部必做项通过且报告为 PASS，才创建一个修复 commit。不要 push。
```

## 7. 交接信息最小格式

每个执行 Agent 的最终回复至少包含：

```text
Phase:
状态: PASS / FAIL / BLOCKED
已验证 Checklist 数:
未完成 Checklist 数:
真实运行服务:
真实测试命令与退出码:
人工验收:
Known Issues:
Report:
Commit:
Push: 未执行
下一阶段是否解锁: 是 / 否
```

