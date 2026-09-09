# Phase 00：项目骨架与工程约束

## 阶段目标

建立可持续开发的 GSPlatform 单仓库骨架，使 Web、Viewer、API 三个应用能够独立安装、启动、检查和构建，并建立统一脚本、环境变量示例、许可证记录和 Git 忽略规则。

## 前置条件

- [ ] 已阅读 `docs/00_GLOBAL_RULES.md`。
- [ ] 当前目录是目标 GSPlatform Git 仓库，且已记录开始前 commit。
- [ ] 已安装 Git、Node.js LTS、pnpm、Python 3.11。
- [ ] 已准备可访问的 SuperSplat Viewer 自有 fork 地址。
- [ ] 已确认目标端口 5173、5174、8000 可用。

> 上述条目同样遵守强制勾选规则；未实际检查不得画勾。

## 禁止事项

- 禁止重新实现 Gaussian renderer。
- 禁止把 `apps/viewer` 做成来源不明的代码副本；必须记录 fork 上游、许可证和具体 commit。
- 禁止在此阶段接入业务数据库、上传和重建逻辑。
- 禁止提交 `.env`、场景大文件、构建目录、虚拟环境或依赖缓存。
- 禁止因为目录已创建就把“服务可用”类任务画勾。
- 禁止自动 push。

## 纯文本架构草图

```text
                         GSPlatform repository
                                  |
          +-----------------------+-----------------------+
          |                       |                       |
          v                       v                       v
+-------------------+   +-------------------+   +-------------------+
| apps/web          |   | apps/viewer       |   | apps/api          |
| React + Vite      |   | Viewer fork       |   | FastAPI           |
| localhost:5173    |   | localhost:5174    |   | localhost:8000    |
+-------------------+   +-------------------+   +-------------------+
          |                       |                       |
          +-----------------------+-----------------------+
                                  |
                       root scripts / docs / CI
```

## 详细 Checklist

### A. 仓库目录

- [ ] 创建 `apps/web`、`apps/viewer`、`apps/api`。
- [ ] 创建 `workers`、`scenes`、`scripts`、`deploy/nginx`、`tests`。
- [ ] 创建 `docs/reports`、`docs/decisions`，并保证空目录有可追踪说明文件。
- [ ] 根目录存在 `README.md`、`.gitignore`、`.editorconfig`、`.env.example`。
- [ ] 根目录存在 `package.json`、`pnpm-workspace.yaml` 和锁文件。
- [ ] `.gitignore` 覆盖 Node、Python、IDE、系统、环境变量、日志、模型和场景产物。

### B. Web 应用

- [ ] 使用 Vite 创建 React + TypeScript 应用。
- [ ] 安装并实际导入 Ant Design、React Router、Zustand、Axios。
- [ ] 配置严格 TypeScript、ESLint、格式检查与测试脚本。
- [ ] `/health-ui` 或等价开发页可显示 Web 构建信息。
- [ ] `pnpm --filter @gsplatform/web dev` 实际启动成功。
- [ ] `pnpm --filter @gsplatform/web build` 实际构建成功。

### C. Viewer 应用

- [ ] 在代码托管平台创建 SuperSplat Viewer 自有 fork。
- [ ] 将 fork 以团队选定的可维护方式引入 `apps/viewer`，不保留意外嵌套 `.git`。
- [ ] 在 `apps/viewer/UPSTREAM.md` 记录上游 URL、fork URL、基线 commit、同步方法。
- [ ] 保留原项目许可证，并在根目录第三方声明中登记。
- [ ] 为 Viewer 设置独立包名、开发端口和构建命令。
- [ ] Viewer 开发服务在 5174 端口实际启动并显示其自带可验证场景或启动页。
- [ ] Viewer 构建命令实际成功。

### D. API 应用

- [ ] 创建 Python 3.11 虚拟环境与可锁定依赖文件。
- [ ] 安装 FastAPI、Uvicorn、Pydantic v2、SQLAlchemy 2.x、Alembic 的兼容版本。
- [ ] 创建 `app/main.py` 和配置模块。
- [ ] 实现 `GET /health/live`，返回稳定 JSON 和 200。
- [ ] OpenAPI 文档在 `/docs` 可打开。
- [ ] `python -m uvicorn app.main:app --reload --port 8000` 实际启动成功。
- [ ] API lint、typecheck、pytest 实际执行成功。

### E. 根级工程命令

- [ ] 根脚本可分别执行 Web 与 Viewer 的 dev、lint、typecheck、test、build。
- [ ] 根脚本能执行 API 检查，且 Windows/Ubuntu 使用说明清晰。
- [ ] `pnpm install --frozen-lockfile` 在干净依赖环境成功。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部成功。
- [ ] 三个服务可同时运行，端口无冲突。

### F. 收尾

- [ ] 实际执行 `git status`、`git diff --stat`、`git diff`。
- [ ] 检查仓库中没有密钥、`.env`、场景和依赖目录。
- [ ] 生成 `docs/reports/PHASE_00_REPORT.md`。
- [ ] 报告结论为 `PASS` 后创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### Monorepo 约定

- 根包设为 `private: true`，工作区至少包含 `apps/web` 与 `apps/viewer`。
- 建议包名为 `@gsplatform/web`、`@gsplatform/viewer`。
- API 使用自己的 Python 环境，但根级脚本提供一致入口。
- 所有端口通过环境变量覆盖；默认值只用于开发。
- Vite 的浏览器环境变量只使用 `VITE_` 前缀，且绝不包含服务端秘密。

### Viewer fork 引入

优先使用可追踪的 subtree 或保留独立仓库并由部署流程构建。若将源码纳入单仓库，必须删除嵌套 Git 元数据并保留 `UPSTREAM.md`。上游同步必须在后续独立提交进行，不能与业务改动混合。

### API 最小边界

`GET /health/live` 只表达进程存活，不探测尚未接入的 PostgreSQL 或 Redis。返回示例：

```json
{
  "status": "ok",
  "service": "gsplatform-api"
}
```

### 测试基线

- Web 和 Viewer 至少各有一个真实渲染/启动测试。
- API 至少使用 TestClient 对 `/health/live` 做状态码与 JSON 断言。
- 构建产物目录不进入 Git。

## 关键目录 / 文件

```text
GSPlatform/
|-- apps/
|   |-- web/
|   |   |-- src/
|   |   |-- package.json
|   |   `-- vite.config.ts
|   |-- viewer/
|   |   |-- src/
|   |   |-- UPSTREAM.md
|   |   `-- package.json
|   `-- api/
|       |-- app/
|       |   |-- __init__.py
|       |   |-- config.py
|       |   `-- main.py
|       |-- tests/test_health.py
|       `-- pyproject.toml
|-- docs/reports/
|-- docs/decisions/
|-- deploy/nginx/
|-- scenes/.gitkeep
|-- scripts/
|-- workers/
|-- .env.example
|-- .gitignore
|-- package.json
|-- pnpm-lock.yaml
`-- pnpm-workspace.yaml
```

## 运行命令

以下命令以 Ubuntu/bash 为标准；Windows 开发者使用等价的 PowerShell 激活命令。

```bash
corepack enable
pnpm install
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
pnpm --filter @gsplatform/viewer dev --host 0.0.0.0 --port 5174
```

API 在另一个终端运行：

```bash
cd apps/api
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## 验收标准

- `http://localhost:5173` 显示 Web 应用，浏览器控制台无未处理错误。
- `http://localhost:5174` 显示 Viewer 应用或其可验证启动页，控制台无未处理错误。
- `http://localhost:8000/health/live` 返回 HTTP 200 与预期 JSON。
- `http://localhost:8000/docs` 可加载 OpenAPI UI。
- Web、Viewer、API 三个服务同时运行至少 3 分钟，互不占用端口。
- 根级 lint、typecheck、test、build 全部退出码为 0。
- Viewer 的许可证与 fork 来源可追踪。
- Git 检查没有发现密钥、大文件、缓存和阶段外改动。

## 自测命令

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build

cd apps/api
python -m ruff check .
python -m mypy app
python -m pytest -q
curl -fsS http://localhost:8000/health/live

cd ../..
curl -I http://localhost:5173
curl -I http://localhost:5174
git status
git diff --stat
git diff
```

## 必须产物

- 可安装的单仓库骨架与锁文件。
- 可独立启动、测试和构建的 Web、Viewer、API。
- `apps/viewer/UPSTREAM.md` 与第三方许可证声明。
- 安全的 `.env.example` 和完整 `.gitignore`。
- `docs/reports/PHASE_00_REPORT.md`。
- 一个仅包含 Phase 00 的本地 commit；不得 push。

## Known Issues 记录区

> 执行时追加记录；没有问题时写“无”，不得删除本节。

| ID | 未完成 Checklist | 环境 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P00-001 |  |  |  |  |  |  |

## Phase Report 模板

将以下内容复制到 `docs/reports/PHASE_00_REPORT.md`：

```markdown
# Phase 00 Report

- 状态：PASS / FAIL / BLOCKED
- 开始时间：
- 结束时间：
- 执行人 / Agent：
- Commit before：
- Commit after：

## 环境

- OS：
- Node / pnpm：
- Python：
- Browser：

## Checklist 结果

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 实际执行命令与结果

| 命令 | 退出码 | 结果摘要 | 证据位置 |
|---|---:|---|---|
|  |  |  |  |

## 人工验收

| 项目 | 结果 | 说明 |
|---|---|---|
| Web 5173 | PASS/FAIL |  |
| Viewer 5174 | PASS/FAIL |  |
| API 8000 | PASS/FAIL |  |

## Git 自检

- `git status`：
- `git diff --stat`：
- `git diff` 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与下一阶段门禁

只有全部必做项验证通过时，状态才能填写 PASS。
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 00 的独立执行 Agent。只执行项目骨架与工程约束，不进入 Phase 01。

开始前必须完整阅读：
1. docs/00_GLOBAL_RULES.md
2. docs/DEVELOPMENT_PLAN.md
3. docs/PHASE_00_BOOTSTRAP.md

固定技术栈不可替换。建立 apps/web、apps/viewer、apps/api 及根级工程结构。Web 使用 React + TypeScript + Vite，并接入 Ant Design、React Router、Zustand、Axios。Viewer 必须来自 SuperSplat Viewer 的自有 fork，保留许可证，并在 apps/viewer/UPSTREAM.md 记录来源与基线 commit；不得重写 Gaussian renderer。API 使用 Python 3.11、FastAPI、Pydantic v2，并为后续 SQLAlchemy 2.x 与 Alembic 建立依赖基线。

必须让 Web 5173、Viewer 5174、API 8000 三个服务真实启动，执行本文全部自测命令。不要用静态阅读、伪输出或“应该可用”作为证据。只有真实运行和验证成功的 Checklist 才能从 [ ] 改为 [x]。失败或无法验证的项保持 [ ]，写入 Known Issues。

结束时生成 docs/reports/PHASE_00_REPORT.md，执行 git status、git diff --stat、git diff，审查密钥、大文件和阶段外修改。仅在报告为 PASS 时创建一个 Phase 00 独立 commit，不 push。最终汇报已验证项、未完成项、命令结果、报告路径和 commit hash。
```
