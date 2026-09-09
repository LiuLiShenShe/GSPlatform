# GSPlatform 全局开发与验收规则

> 本文件对全部 Phase、全部执行 Agent 和全部提交生效。任何阶段文档与本文件冲突时，以本文件为准。

## 1. 固定技术栈

除非项目负责人书面批准并记录 ADR，不得替换下列核心技术。

### Web 前端

- React
- TypeScript
- Vite
- Ant Design
- React Router
- Zustand
- Axios

### 3D Scene Viewer

- SuperSplat Viewer（维护自有 fork，保留开源许可证和上游来源）
- PlayCanvas Engine
- SOG / Streamed SOG
- splat-transform

### API 与数据层

- Python 3.11
- FastAPI
- SQLAlchemy 2.x
- Pydantic v2
- PostgreSQL
- Alembic

### 异步计算与重建

- Redis
- Celery
- FFmpeg
- COLMAP
- gsplat
- splat-transform

### 部署

- Ubuntu
- Nginx
- HTTPS

## 2. 仓库边界

```text
GSPlatform/
|-- apps/
|   |-- web/                  React 平台前端
|   |-- viewer/               自有 fork 的 Viewer 源码
|   `-- api/                  FastAPI 服务
|-- workers/                  Celery 任务与重建流水线
|-- scenes/                   本地开发场景；大文件不进入 Git
|-- scripts/                  发布、转换、巡检脚本
|-- deploy/                   Compose、systemd、Nginx 配置
|-- docs/                     开发计划、阶段报告、ADR
|-- tests/                    跨应用验收测试
|-- .env.example              只含变量名和安全示例
|-- .gitignore
|-- README.md
`-- pnpm-workspace.yaml
```

规则：

- `apps/web` 负责产品页面与业务状态，不实现高斯渲染器。
- `apps/viewer` 负责渲染、相机、性能和 Viewer UI 接口，不直接访问数据库。
- `apps/api` 负责鉴权、元数据、上传会话、作品与任务 API。
- `workers` 负责耗时任务；Web 请求不得同步执行 FFmpeg、COLMAP、gsplat 或格式转换。
- `scenes`、上传文件、训练输出、SOG 分片、日志、数据库备份不得提交到 Git。
- 密钥只能通过环境变量或部署系统注入；禁止写入代码、文档、截图和日志。

## 3. 强制 Checklist 规则：自行核验后才画勾

所有任务初始状态均为：

```markdown
- [ ] 未完成
```

只有该任务同时满足下列条件，执行 Agent 才能将其改为：

```markdown
- [x] 已完成
```

强制条件：

1. 代码、配置或文档已真实存在于预期路径。
2. 依赖已真实安装，安装命令成功结束。
3. 对应服务或命令已真实运行，不以静态阅读代替运行。
4. 本阶段规定的 build、lint、typecheck、test、smoke test 已真实执行。
5. 页面、API、Viewer 或任务流水线已在真实运行环境中验证成功。
6. 验证结果符合明确的验收标准，且日志中没有被忽略的错误。
7. 使用的测试数据可追溯，不以假输出、伪日志或定时器冒充真实进度。

以下情况一律不得画勾：

- 代码存在但没有运行。
- 仅凭“理论上可用”“编译应该能过”或代码审查结论。
- 命令失败、测试失败、页面白屏、控制台报错或 API 返回不符合约定。
- 依赖外部服务但外部服务未启动或未验证。
- 使用 mock、placeholder、硬编码成功状态或伪造百分比冒充完成。
- 无法访问所需环境、GPU、域名或证书，因而无法核验。

失败或无法验证时：

1. 保持 `- [ ]`。
2. 在本阶段 `Known Issues` 记录任务、命令、实际结果、原因与下一步。
3. 在 Phase Report 中将阶段状态标为 `FAIL` 或 `BLOCKED`，不得标为 `PASS`。

## 4. 阶段门禁

```text
Phase 00 -> 01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 07 -> 08 -> 09
    PASS     PASS     PASS     PASS     PASS     PASS     PASS     PASS     PASS
```

- 前一 Phase 的报告不是 `PASS`，不得进入下一 Phase。
- 若负责人明确要求跳过，必须在 `docs/decisions/` 新建 ADR，写明 `PHASE_DEPENDENCY_OVERRIDE`、跳过项、风险、补验日期和批准人。
- 跳阶段不改变 Checklist 规则；未验证项仍保持 `[ ]`。
- 阶段状态只有 `PASS`、`FAIL`、`BLOCKED` 三种。
- 只有必做 Checklist 全部 `[x]` 且验收全部通过，阶段才能 `PASS`。

## 5. 每阶段结束的固定流程

### 5.1 重新核对清单

- 从第一项开始逐条检查证据。
- 只更新已实际验证的复选框。
- 把命令、时间、环境和结果写入阶段报告。

### 5.2 执行质量检查

至少执行本阶段列出的：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

后端阶段还必须执行：

```bash
cd apps/api
python -m ruff check .
python -m mypy app
python -m pytest -q
```

具体阶段可以增加检查，不得减少全局底线；不存在的命令必须先在项目脚本中实现，不能直接略过。

### 5.3 Git 自检

每个阶段结束必须真实执行：

```bash
git status
git diff --stat
git diff
```

逐项确认：

- 没有超出当前 Phase 的意外修改。
- 没有 `.env`、令牌、口令、私钥和真实连接串。
- 没有上传源文件、模型权重、训练输出、SOG 大文件和数据库备份。
- 没有临时文件、调试输出、系统文件和未解释的二进制文件。
- 第三方开源代码保留许可证、NOTICE 和来源记录。

### 5.4 生成 Phase Report

每阶段结束生成：

```text
docs/reports/PHASE_<N>_REPORT.md
```

例如 Phase 03 使用 `docs/reports/PHASE_03_REPORT.md`。报告必须使用对应阶段文档中的模板，并附真实命令结果摘要。

### 5.5 单独提交，不推送

阶段通过后执行一次独立提交：

```bash
git add <仅本阶段文件>
git commit -m "phaseNN: <简短结果>"
```

禁止：

- 自动执行 `git push`。
- 把多个 Phase 混在一个提交。
- 用 `git add .` 掩盖未审查的文件范围。
- 为得到干净状态而删除或覆盖用户的既有改动。

## 6. UI、内容与品牌规则

- 页面结构和交互以本套文档中的 ASCII 线框图为准。
- 不复制第三方品牌、Logo、图片、图标组合、产品名称或专有文案。
- 产品名称、色彩、图标和示例内容使用项目自有或明确授权的素材。
- Ant Design 仅作为组件库；必须用项目主题 Token 形成独立视觉风格。
- 演示场景必须为项目自有、用户上传或许可证允许的资产，并记录来源。
- 所有主要交互支持键盘操作，按钮有可访问名称，颜色对比满足 WCAG AA 目标。
- 桌面端 5 列卡片是明确验收项；窄屏允许响应式降列，但不得破坏信息层级。

## 7. API 与安全底线

- API 统一前缀 `/api/v1`，响应错误使用稳定错误码与可读信息。
- Pydantic v2 负责输入输出校验；SQLAlchemy 2.x 使用显式事务边界。
- Alembic 是唯一数据库结构变更渠道；禁止在启动时隐式建表用于生产。
- 上传必须校验扩展名、MIME、文件头、大小、文件数量和归属。
- 文件名由服务端生成；不得把用户提供路径直接拼入文件系统路径。
- 下载与场景资源使用授权检查或短期签名地址。
- Celery 任务必须可重试、可追踪、尽量幂等，并保存机器可读状态。
- 日志不得包含访问令牌、Cookie、密码、上传文件内容和完整连接串。

## 8. 环境与版本记录

每份 Phase Report 至少记录：

```text
OS:
Node:
pnpm:
Python:
Browser:
PostgreSQL:
Redis:
GPU / Driver / CUDA（涉及重建时）:
Commit before:
Commit after:
```

依赖版本由 lockfile 固定。升级核心依赖需单独提交，并在报告中写明兼容性验证。

## 9. 完成定义

“阶段完成”只表示：必做任务全部真实完成、自动检查通过、人工验收通过、报告已生成、Git 自检已执行且阶段提交已创建。它不等于“代码已写完”。

