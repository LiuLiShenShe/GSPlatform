# Phase 05：FastAPI、PostgreSQL 与持久化数据模型

## 阶段目标

建立可迁移、可测试、事务边界清晰的后端数据层，为场景目录、资产版本、上传、异步任务和用户归属提供真实 PostgreSQL 持久化；实现公共场景读取、我的作品读取、健康检查和稳定错误协议。所有数据库结构变更统一由 Alembic 管理。

## 前置条件

- [ ] `docs/reports/PHASE_04_REPORT.md` 存在且状态为 `PASS`。
- [ ] 已安装并可连接 PostgreSQL 测试实例。
- [ ] 已确认 Python 3.11、FastAPI、SQLAlchemy 2.x、Pydantic v2、Alembic 版本锁定。
- [ ] 已定义开发、测试、生产配置隔离方式。
- [ ] 已记录 Phase 05 开始前 commit。

## 禁止事项

- 禁止使用 SQLite 通过本阶段 PostgreSQL 验收。
- 禁止在应用启动时使用 `create_all()` 替代生产迁移。
- 禁止在路由函数中堆叠原始 SQL 和业务事务。
- 禁止返回 ORM 对象的未筛选字段或泄露内部路径。
- 禁止把数据库口令、真实连接串或访问令牌写进仓库。
- 禁止使用开发身份旁路在生产配置中冒充认证。
- 禁止在列表 API 产生未控制的 N+1 查询。
- 禁止自动 push。

## 纯文本架构草图

```text
React / Viewer
      |
      | JSON over /api/v1
      v
+----------------------------+
| FastAPI routers            |
| validation / auth boundary |
+-------------+--------------+
              |
              v
+----------------------------+
| application services       |
| transaction / permissions  |
+-------------+--------------+
              |
              v
+----------------------------+
| repositories               |
| SQLAlchemy 2.x             |
+-------------+--------------+
              |
              v
+----------------------------+      +----------------------+
| PostgreSQL                 |<-----| Alembic migrations   |
| constraints / indexes      |      | upgrade / downgrade  |
+----------------------------+      +----------------------+
```

### 核心关系

```text
users 1 -------- N scenes 1 -------- N scene_versions 1 -------- N assets
                       |
                       +------------- N jobs
                       |
                       `------------- N upload_sessions

scenes
  id, owner_id, slug, title, description, category, visibility, status,
  current_version_id, created_at, updated_at, published_at, deleted_at

jobs
  id, scene_id, owner_id, kind, status, progress, stage,
  error_code, error_message_safe, attempt, celery_task_id, timestamps
```

## 详细 Checklist

### A. 配置与连接

- [ ] 使用 Pydantic v2 Settings 或等价方式集中读取配置。
- [ ] `.env.example` 只含安全变量名和本地示例，不含真实秘密。
- [ ] SQLAlchemy 2.x engine、session factory 和依赖注入边界明确。
- [ ] 每个请求拥有独立 session，成功提交、异常回滚并最终关闭。
- [ ] 配置连接池大小、超时、连接回收与应用名。
- [ ] 测试使用独立 PostgreSQL 数据库，不复用开发或生产数据。

### B. 数据模型与约束

- [ ] 实现 User、Scene、SceneVersion、Asset、Job、UploadSession 模型。
- [ ] 主键统一使用 UUID；时间统一保存带时区 UTC。
- [ ] Scene slug、状态、可见性、owner 关系有数据库约束。
- [ ] SceneVersion 使用不可变 asset version 和唯一约束。
- [ ] Asset 记录 kind、storage key、byte size、MIME、SHA-256。
- [ ] Job 状态、进度范围 0~100、attempt 和 Celery task ID 有约束/索引。
- [ ] UploadSession 记录 owner、offset/size、expiry、status，不保存客户端绝对路径。
- [ ] 为公开列表、owner 列表、状态筛选和任务查询建立有效索引。
- [ ] 软删除记录不会出现在默认公共查询中。

### C. Alembic

- [ ] 初始化 Alembic 并从应用 metadata 读取模型。
- [ ] 创建首个显式迁移，人工审阅升级和降级脚本。
- [ ] 空数据库执行 `alembic upgrade head` 成功。
- [ ] 执行 `alembic downgrade base` 后再 `upgrade head` 成功。
- [ ] CI 检查模型变化是否缺少迁移。
- [ ] 迁移不读取 Web 请求配置，不在导入时连接外部服务。

### D. Pydantic v2 DTO 与错误协议

- [ ] 为列表、详情、创建/更新内部命令建立独立 DTO。
- [ ] 响应 DTO 使用显式字段，不暴露 storage key、内部错误和秘密。
- [ ] 分页参数、排序字段、分类和状态使用强校验。
- [ ] 错误响应至少包含 `code`、`message`、`requestId`。
- [ ] 422、404、409、401/403 与 500 有稳定语义。
- [ ] OpenAPI 中包含主要响应模型和错误示例。

### E. API

- [ ] `GET /api/v1/scenes` 仅返回可见且已发布的公共场景。
- [ ] `GET /api/v1/scenes/{sceneId}` 正确区分不存在、无权限和可见。
- [ ] `GET /api/v1/me/scenes` 通过身份依赖返回当前用户作品。
- [ ] `GET /api/v1/jobs/{jobId}` 只允许任务所有者读取。
- [ ] `GET /health/live` 不依赖数据库。
- [ ] `GET /health/ready` 实际探测 PostgreSQL，失败时非 200 或明确 not ready。
- [ ] 列表支持稳定游标或有边界的分页，不允许无限 `limit`。
- [ ] 响应返回 manifest 的业务 URL，不泄露服务器绝对路径。

### F. 身份边界

- [ ] 建立可替换的 `get_current_user` 依赖与 `RequestIdentity` 类型。
- [ ] 自动测试覆盖未认证、无权限和资源所有者。
- [ ] 若保留开发身份注入，只在显式 development 配置启用。
- [ ] production 配置启动时检测并拒绝开发身份旁路。
- [ ] 日志只记录 user ID，不记录凭据或 Cookie。
- [ ] Phase 08 接入正式登录后无需改写服务层权限逻辑。

### G. 测试与性能

- [ ] repository 测试使用真实 PostgreSQL 事务或隔离 schema。
- [ ] API 测试覆盖正常、校验失败、404、409、401/403。
- [ ] 测试唯一约束、外键、软删除和事务回滚。
- [ ] 查询日志或分析证明场景列表没有 N+1。
- [ ] 并发更新用 version/锁或明确冲突策略返回 409。
- [ ] 测试结束清理测试数据，不触碰开发/生产库。

### H. 收尾

- [ ] ruff、mypy、pytest 和迁移测试全部成功。
- [ ] Web 的 Axios DTO 已接入真实读取 API，不再把 fixture 当生产数据。
- [ ] 首页和我的作品读取状态在真实 API 上验证。
- [ ] 生成 `docs/reports/PHASE_05_REPORT.md`。
- [ ] 执行 `git status`、`git diff --stat`、`git diff`。
- [ ] 创建仅包含 Phase 05 的独立 commit。
- [ ] 未执行 push。

## 实现细节

### 分层边界

```text
router       HTTP、DTO、身份依赖、状态码
service      用例、权限、事务编排、领域冲突
repository   SQLAlchemy 查询，不返回 HTTP 概念
model        表结构与约束
schema       Pydantic v2 输入输出
```

路由不得直接执行 `commit`。建议在请求级 Unit of Work 或服务层事务中完成用例，异常统一映射到稳定错误码。

### 建议枚举

```text
SceneStatus: DRAFT, VALIDATING, PROCESSING, READY, PUBLISHED, FAILED, ARCHIVED
Visibility: PRIVATE, UNLISTED, PUBLIC
JobKind: VALIDATE_UPLOAD, BUILD_STREAMED_SOG, RECONSTRUCT, PUBLISH, DELETE_ASSETS
JobStatus: QUEUED, RUNNING, SUCCEEDED, FAILED, CANCEL_REQUESTED, CANCELLED
AssetKind: SOURCE, POSTER, MANIFEST, SOG, STREAM_INDEX, STREAM_CHUNK, LOG_SUMMARY
```

数据库枚举或约束的演进要谨慎；如果使用字符串 + check constraint，应让迁移显式更新允许值。

### 游标分页

公共场景列表建议使用 `(published_at, id)` 稳定游标。排序列和 ID 必须共同组成唯一顺序，避免同一发布时间造成重复或遗漏。限制 `limit` 的默认值与最大值。

### 身份策略

本阶段建立权限边界，不强制选择外部身份提供方。若为了本地上传闭环提供开发身份，必须同时满足：

- 仅 `APP_ENV=development`。
- 默认关闭，需要显式变量开启。
- 生产启动检查直接拒绝该配置。
- 测试验证拒绝行为。

正式会话、登录和账户 UI 在 Phase 08 完成。

## 关键目录 / 文件

```text
apps/api/
|-- alembic.ini
|-- migrations/
|   |-- env.py
|   `-- versions/0001_initial_schema.py
|-- app/
|   |-- api/v1/
|   |   |-- router.py
|   |   |-- scenes.py
|   |   |-- me.py
|   |   `-- jobs.py
|   |-- core/
|   |   |-- config.py
|   |   |-- errors.py
|   |   `-- identity.py
|   |-- db/
|   |   |-- base.py
|   |   |-- session.py
|   |   `-- models/
|   |-- repositories/
|   |-- schemas/
|   |-- services/
|   `-- main.py
|-- tests/
|   |-- integration/
|   `-- api/
`-- pyproject.toml
```

## 运行命令

```bash
cd apps/api
source .venv/bin/activate
alembic upgrade head
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

开发 PostgreSQL 可由仓库约定的本地服务启动方式提供，连接串通过环境变量注入。另一个终端运行 Web：

```bash
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
```

## 验收标准

- 空 PostgreSQL 可从 base 迁移到 head，降级后可再次升级。
- `/health/live` 和 `/health/ready` 正确区分进程存活与数据库就绪。
- 真实数据库 seed 的公开场景能在首页读取，私有/软删除场景不会泄露。
- 当前身份只能读取自己的 `/me/scenes` 与 job。
- 422、404、409、401/403 的错误结构稳定且 OpenAPI 可见。
- repository/API 测试真实使用 PostgreSQL，事务和约束按预期工作。
- production 配置无法启用开发身份旁路。
- Web 生产数据路径不再依赖 fixture。

## 自测命令

```bash
cd apps/api
python -m ruff check .
python -m mypy app
python -m pytest -q
alembic downgrade base
alembic upgrade head
alembic check
curl -fsS http://localhost:8000/health/live
curl -fsS http://localhost:8000/health/ready
curl -fsS "http://localhost:8000/api/v1/scenes?limit=20"

cd ../..
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
git status
git diff --stat
git diff
```

## 必须产物

- SQLAlchemy 2.x 模型、约束、索引、repositories 和 services。
- 首个可升级/降级的 Alembic 迁移。
- Pydantic v2 DTO、统一错误和 `/api/v1` 读取 API。
- live/ready 健康检查与身份权限边界。
- PostgreSQL 集成测试和 Web 真实读取接入。
- `docs/reports/PHASE_05_REPORT.md`。
- 一个仅包含 Phase 05 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | DB / API / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P05-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_05_REPORT.md`：

```markdown
# Phase 05 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：

## 环境

- Python：
- FastAPI / SQLAlchemy / Pydantic / Alembic：
- PostgreSQL：
- 测试数据库标识：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 迁移结果

| 操作 | 退出码 | 结果 |
|---|---:|---|
| upgrade head |  |  |
| downgrade base |  |  |
| re-upgrade head |  |  |
| alembic check |  |  |

## API / 权限 / 数据隔离结果

## 测试和查询性能结果

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 06 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 05 的独立执行 Agent。阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md、docs/PHASE_05_BACKEND_DATABASE.md，并确认 docs/reports/PHASE_04_REPORT.md 为 PASS。未通过门禁不得继续。

严格使用 Python 3.11 + FastAPI + SQLAlchemy 2.x + Pydantic v2 + PostgreSQL + Alembic。实现 User、Scene、SceneVersion、Asset、Job、UploadSession，包含 UUID、UTC 时间、状态约束、外键、索引和软删除规则。路由/服务/repository 分层，事务明确。实现 /api/v1/scenes、/api/v1/scenes/{id}、/api/v1/me/scenes、/api/v1/jobs/{id}、/health/live、/health/ready，并让 Web 读取真实 API。

必须用真实 PostgreSQL 测试；SQLite 不能作为通过证据。Alembic 必须真实完成空库 upgrade、downgrade base、再次 upgrade 和 check。建立可替换身份依赖；任何开发身份旁路只能显式在 development 开启，production 必须拒绝。

只有真实迁移、测试、API 和页面验证成功后才将 [ ] 改为 [x]。失败或无法验证保持 [ ] 并写 Known Issues。生成 docs/reports/PHASE_05_REPORT.md，执行 git status、git diff --stat、git diff。PASS 后创建独立 Phase 05 commit，不 push。最终汇报模型/迁移、API、权限、测试数据库证据、未完成项、报告路径和 commit hash。
```

