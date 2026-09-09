# Phase 06：安全上传、校验与原子发布

## 阶段目标

实现用户上传已有 3DGS 作品的完整闭环：创建上传会话、分块/断点续传到本地磁盘暂存区、服务端验证、异步转换为平台流式资产、生成或校验 Poster、原子发布新版本、更新数据库，并在“我的作品”和 Scene Viewer 中真实可见。

第一阶段存储使用服务器本地磁盘，接口和 storage key 设计保持未来迁移到对象存储的可能性。

## 前置条件

- [ ] `docs/reports/PHASE_05_REPORT.md` 存在且状态为 `PASS`。
- [ ] PostgreSQL 迁移和身份权限边界可复现。
- [ ] Redis 可启动，Celery 与 FastAPI 使用兼容的锁定版本。
- [ ] 已定义允许上传的格式、大小、文件数量和配额。
- [ ] 已准备独立的 staging、published、quarantine 绝对目录。
- [ ] 已记录 Phase 06 开始前 commit。

## 禁止事项

- 禁止把用户文件名直接作为服务端路径。
- 禁止信任扩展名或浏览器提供的 MIME；必须验证文件头和结构。
- 禁止解压包含绝对路径、`..`、符号链接逃逸或超限膨胀的归档。
- 禁止在 FastAPI 请求线程同步运行大文件转换。
- 禁止在校验完成前把暂存文件暴露为公开场景。
- 禁止覆盖当前已发布版本；新版本必须使用不可变目录。
- 禁止把 Celery 任务 ID 当作授权凭据。
- 禁止伪造上传、处理或发布百分比。
- 禁止自动 push。

## 纯文本架构草图

```text
UploadPage
   |
   | 1. create session
   | 2. chunk upload + checksum + offset
   v
+-----------------------+       +---------------------------+
| FastAPI               |------>| local staging/<upload-id> |
| auth / limits / locks |       | non-public, random names  |
+-----------+-----------+       +-------------+-------------+
            | enqueue                         |
            v                                 v
+-----------------------+       +---------------------------+
| Redis + Celery        |------>| validate / convert       |
| durable job state     |       | build Streamed SOG       |
+-----------+-----------+       +-------------+-------------+
            |                                 |
            | DB transaction                  | atomic rename
            v                                 v
+-----------------------+       +---------------------------+
| PostgreSQL            |<------| published/<scene>/<ver>  |
| scene/version/assets  |       | manifest/poster/assets   |
+-----------------------+       +---------------------------+
            |
            v
 My Works -> Scene Viewer
```

### 上传页状态

```text
+----------------------------------------------------------------------------------------+
| 上传作品                                                                               |
|                                                                                        |
| 标题 [________________________]    可见性 (o) 公开 ( ) 私有                             |
| 场景文件 +-------------------------------------------+                                  |
|          | scene.sog  1.24 GB                       |                                  |
|          | [##############------] 68%  842 MB/1.24GB| [暂停] [取消]                    |
|          +-------------------------------------------+                                  |
| Poster   [poster.webp] [预览]                                                            |
|                                                                                        |
| 状态：上传中 -> 服务端校验 -> 转换 -> 发布 -> Viewer 验证                               |
|                                             [保存草稿] [校验并发布]                     |
+----------------------------------------------------------------------------------------+
```

## 详细 Checklist

### A. 存储抽象与目录安全

- [ ] 定义 `Storage` 接口：写入暂存、读取范围、原子发布、删除、存在性、校验和。
- [ ] 实现 LocalDiskStorage，所有 storage key 由服务端 UUID/版本生成。
- [ ] staging、published、quarantine 不位于 Web 源码或默认公开根目录。
- [ ] 每次路径解析后验证最终绝对路径仍在配置根目录内。
- [ ] 禁止跟随用户可控符号链接。
- [ ] 文件与目录使用最小权限，API 和 worker 账户权限有记录。
- [ ] 磁盘空间不足时提前拒绝或安全失败，不产生半发布版本。

### B. 上传会话 API

- [ ] `POST /api/v1/uploads` 验证身份、配额、声明大小和格式。
- [ ] 返回 uploadId、服务端 offset、chunk 上限、过期时间，不返回绝对路径。
- [ ] `HEAD /api/v1/uploads/{id}` 返回所有者可见的真实 offset/status。
- [ ] `PATCH /api/v1/uploads/{id}` 或等价端点按 offset 写入分块。
- [ ] offset 不一致返回 409 和服务端真实 offset。
- [ ] 分块请求有大小上限、超时、锁和内容校验。
- [ ] `POST /api/v1/uploads/{id}/complete` 只有总长度与摘要符合时入队。
- [ ] `DELETE /api/v1/uploads/{id}` 请求取消并按策略清理暂存文件。
- [ ] 过期会话由真实周期任务清理。

### C. 服务端文件验证

- [ ] 验证扩展名、声明 MIME、探测 MIME/魔数三者的一致性。
- [ ] 验证实际字节数与声明大小。
- [ ] 计算并保存 SHA-256，支持客户端摘要比对。
- [ ] 使用锁定版本工具解析 SOG/允许格式，解析失败即隔离。
- [ ] 若接受归档，限制条目数、展开后总大小、压缩比和路径。
- [ ] Poster 只允许明确的图片格式、尺寸和像素上限，并重新解码/编码。
- [ ] 日志不包含文件内容、用户本地路径或敏感元数据。

### D. Celery 发布任务

- [ ] Redis broker/backend 连接配置不写入仓库。
- [ ] Celery task 使用数据库 job ID 关联，不以 task ID 作为业务主键。
- [ ] 任务阶段至少为 VALIDATING、CONVERTING、VERIFYING、PUBLISHING、SUCCEEDED/FAILED。
- [ ] 进度来自实际读写字节、工具阶段和校验结果，不由定时器生成。
- [ ] 任务在重复投递时幂等：同一 job 不产生多个当前版本。
- [ ] 外部命令使用 argv 列表、固定可执行路径、超时和资源限制。
- [ ] 捕获 stdout/stderr 到受限日志，数据库只保存安全摘要。
- [ ] 失败时保留足够诊断信息并按保留策略清理/隔离产物。

### E. 原子发布与数据库一致性

- [ ] 转换先写临时版本目录，校验所有必需资产、哈希和 manifest。
- [ ] 发布目录使用 scene ID + content/version hash，不使用标题或客户端文件名。
- [ ] 同一文件系统内原子 rename 后才允许数据库指向新版本。
- [ ] 数据库事务创建 SceneVersion/Assets 并更新 currentVersion。
- [ ] 数据库失败时不暴露孤立版本；文件失败时不提交数据库状态。
- [ ] 旧版本不被覆盖，回滚可重新指向上一版本。
- [ ] 公开路径只允许读取 PUBLISHED/有权限版本。

### F. Web 上传体验

- [ ] 上传页调用真实会话 API，不再以本地表单状态冒充上传。
- [ ] 显示真实字节、总字节、速度、offset 和错误。
- [ ] 支持暂停、刷新后查询 offset、继续上传和取消。
- [ ] 完成上传后显示服务端校验/转换/发布的真实 job 阶段。
- [ ] 页面轮询或 SSE 断开后可重连，不把断连视为任务失败。
- [ ] 失败显示安全错误与可执行的重试/重新上传建议。
- [ ] 成功后跳转“我的作品”，并能打开真实 Viewer。

### G. 测试与收尾

- [ ] 测试未认证、跨用户、超配额、错误 offset、超大 chunk。
- [ ] 测试伪扩展、错误魔数、截断 SOG、坏摘要和恶意归档路径。
- [ ] 测试断点续传、重复 complete、Celery 重复投递和取消。
- [ ] 测试磁盘不足、转换失败、数据库提交失败和发布回滚。
- [ ] 使用一个真实允许格式场景完成上传到 Viewer 的端到端验收。
- [ ] 暂存过期清理任务在测试时真实清理目标测试目录。
- [ ] API、worker、Web 的 lint/typecheck/test/build 全部成功。
- [ ] 生成 `docs/reports/PHASE_06_REPORT.md`。
- [ ] 执行三项 Git 自检并创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### 上传协议

可以采用简化且有文档的 offset 协议：

```text
POST   /api/v1/uploads
HEAD   /api/v1/uploads/{uploadId}
PATCH  /api/v1/uploads/{uploadId}
POST   /api/v1/uploads/{uploadId}/complete
DELETE /api/v1/uploads/{uploadId}
```

每次 PATCH 在事务/文件锁保护下验证 `Upload-Offset`。写入成功后持久化新 offset。断电一致性策略必须记录：先安全写入与 flush，再更新数据库；恢复任务对文件长度和数据库 offset 做协调。

### 发布状态机

```text
CREATED -> UPLOADING -> UPLOADED -> QUEUED
   |           |            |          |
   |           `-> CANCELLED|          v
   |                        VALIDATING -> CONVERTING -> VERIFYING
   |                                                     |
   `-----------------------------------------------------+-> FAILED
                                                         |
                                                         v
                                                     PUBLISHING
                                                         |
                                                         v
                                                     SUCCEEDED
```

### 原子目录布局

```text
/srv/gsplatform-data/
|-- staging/<upload-id>/
|-- quarantine/<upload-id>/
`-- published/<scene-id>/
    |-- versions/<asset-version>/
    |   |-- manifest.json
    |   |-- poster.webp
    |   `-- <真实流式资产>
    `-- current.json             小型指针元数据或由 DB 决定当前版本
```

Nginx 不直接暴露 staging/quarantine。published 资源路径必须版本化；manifest 访问仍需遵守 Scene 可见性。

### 真实进度

- Upload：浏览器 XHR/stream 的实际上传字节与服务器 offset。
- Validation：已读取字节与确定的校验步骤。
- Conversion：包装工具输出的可验证阶段；无法得出百分比时显示阶段型不确定进度。
- Publish：校验、rename、数据库事务各自的真实完成事件。

## 关键目录 / 文件

```text
apps/api/app/
|-- api/v1/uploads.py
|-- schemas/uploads.py
|-- services/upload_service.py
|-- services/publish_service.py
|-- storage/
|   |-- base.py
|   |-- local_disk.py
|   `-- paths.py
`-- repositories/uploads.py

workers/
|-- celery_app.py
|-- tasks/
|   |-- publish_scene.py
|   `-- cleanup_uploads.py
`-- pipeline/
    |-- validate_scene.py
    |-- convert_scene.py
    `-- verify_publish.py

apps/web/src/features/upload/
|-- UploadForm.tsx
|-- ResumableUploader.ts
|-- UploadProgress.tsx
`-- ProcessingStatus.tsx

scripts/
|-- publish_scene.sh
`-- verify_published_scene.sh
```

## 运行命令

```bash
# 终端 1：API
cd apps/api
source .venv/bin/activate
alembic upgrade head
python -m uvicorn app.main:app --reload --port 8000

# 终端 2：Celery worker
cd workers
python -m celery -A celery_app worker --loglevel=INFO --concurrency=1

# 终端 3：Web
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
```

Redis 使用仓库记录的本地启动方式，连接信息通过环境变量注入。

## 验收标准

- 一个真实 SOG/允许格式场景能分块上传、暂停、刷新、续传、完成。
- 服务端真实验证类型、长度、结构与 SHA-256；坏文件不会发布。
- Celery 真实执行验证、转换、校验、发布，进度来自实际阶段。
- 重复 complete 和重复任务投递不产生重复版本。
- 发布使用不可变版本目录与原子切换；失败不会破坏上一版本。
- 上传成功后在“我的作品”显示，并能由 Scene Viewer 打开 Streamed SOG。
- 跨用户读取/续传/取消均被拒绝，Nginx 不暴露 staging/quarantine。
- 暂存清理、磁盘不足、转换失败与 DB 失败路径均有测试证据。

## 自测命令

```bash
cd apps/api
python -m ruff check .
python -m mypy app
python -m pytest -q

cd ../../workers
python -m ruff check .
python -m mypy .
python -m pytest -q

cd ..
pnpm --filter @gsplatform/web lint
pnpm --filter @gsplatform/web typecheck
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
pnpm --filter @gsplatform/web test:e2e --grep "upload publish"
./scripts/verify_published_scene.sh <测试发布 manifest 路径>
git status
git diff --stat
git diff
```

## 必须产物

- LocalDiskStorage、路径安全和容量检查。
- 分块/断点上传 API、Web uploader 与真实状态 UI。
- Redis + Celery 发布任务、校验、转换和原子发布。
- 上传、任务、版本与资产数据库状态的一致性实现。
- 安全/故障/幂等测试和真实上传到 Viewer 的 E2E 证据。
- `docs/reports/PHASE_06_REPORT.md`。
- 一个仅包含 Phase 06 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 上传 / 任务 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P06-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_06_REPORT.md`：

```markdown
# Phase 06 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：

## 环境与配额

- PostgreSQL / Redis / Celery：
- storage roots：仅写逻辑名称，不记录敏感绝对路径
- 允许格式 / 大小 / chunk 上限：
- 测试资产 size / SHA-256：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 端到端上传与发布

| 步骤 | 实际结果 | 耗时 | PASS/FAIL |
|---|---|---:|---|
| 创建会话 |  |  |  |
| 暂停/续传 |  |  |  |
| 服务端校验 |  |  |  |
| Celery 转换 |  |  |  |
| 原子发布 |  |  |  |
| My Works / Viewer |  |  |  |

## 安全、失败、幂等与清理测试

## 自动测试命令与结果

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 07 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 06 的独立执行 Agent。阅读全局规则、总计划与 docs/PHASE_06_UPLOAD_PUBLISH.md，确认 docs/reports/PHASE_05_REPORT.md 为 PASS。门禁不满足不得执行。

使用服务器本地磁盘实现 Storage 接口和安全 staging/quarantine/published 目录。实现有身份与配额控制的创建会话、HEAD offset、分块 PATCH、complete、cancel 和过期清理。服务端生成所有路径，验证最终路径不逃逸；真实验证扩展名、MIME/魔数、字节数、SHA-256、SOG 结构和安全归档规则。

通过 Redis + Celery 异步执行 VALIDATING/CONVERTING/VERIFYING/PUBLISHING。外部命令使用 argv、固定路径、超时和资源限制。进度只能来自真实字节或阶段。发布到 scene/version 不可变目录，完整校验后原子切换，并在数据库事务中更新 current version。重复 complete/任务投递必须幂等。

Web 必须真实显示上传字节、offset、暂停/续传、服务端处理和错误。用一个真实场景完成 UploadPage -> Celery -> published -> My Works -> Viewer 的闭环，并覆盖跨用户、坏文件、恶意路径、断点、磁盘不足、转换/数据库失败。只有真实通过项才改 [ ] 为 [x]；否则保持 [ ] 并记录。

生成 docs/reports/PHASE_06_REPORT.md，执行 git status、git diff --stat、git diff。PASS 后创建独立 Phase 06 commit，不 push。最终汇报端到端结果、安全/故障测试、未完成项、报告路径和 commit hash。
```

