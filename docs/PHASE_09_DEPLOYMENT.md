# Phase 09：Ubuntu、Nginx 与 HTTPS 生产部署

## 阶段目标

将通过前八个阶段的 GSPlatform 部署到 Ubuntu：Nginx 提供 HTTPS、Web 静态文件、API 反向代理和 Streamed SOG Range 交付；FastAPI、Celery CPU/GPU worker、PostgreSQL、Redis 以受控服务运行；具备健康检查、日志、指标、备份恢复、发布回滚和安全基线。

## 前置条件

- [ ] `docs/reports/PHASE_08_REPORT.md` 存在且状态为 `PASS`。
- [ ] 已准备 Ubuntu 目标主机、DNS 域名、管理员与非特权运行账户。
- [ ] 已确认 TLS 证书申请/续期方式和对外端口。
- [ ] 已完成容量估算：Web、数据库、Redis、场景、任务、日志、备份、GPU worker。
- [ ] 已准备独立 staging 环境与生产环境配置。
- [ ] 已定义维护窗口、回滚负责人和备份保留策略。
- [ ] 已记录 Phase 09 开始前 commit。

## 禁止事项

- 禁止在未通过 Phase 08 的情况下部署为生产服务。
- 禁止以 root 运行 Web、API、Celery 或重建命令。
- 禁止把数据库、Redis、Flower/监控调试页直接暴露到公网。
- 禁止把秘密写入 Git、构建产物、Nginx 配置、systemd unit 或报告。
- 禁止关闭 TLS 校验、使用永久测试证书或只验证 HTTP。
- 禁止让 Nginx 公开 staging、quarantine、jobs、原始上传或备份目录。
- 禁止破坏 Streamed SOG 的 Range、缓存与内容类型。
- 禁止无备份/回滚方案直接执行数据库迁移。
- 禁止声称备份可用但没有实际恢复演练。
- 禁止自动 push。

## 纯文本部署架构

```text
                           Internet
                              |
                         443 / HTTPS
                              |
                              v
+-------------------------------------------------------------------+
| Ubuntu host / Nginx                                               |
|                                                                   |
| /                 -> apps/web/dist immutable/static               |
| /api/             -> FastAPI on private localhost socket/port     |
| /scene-assets/    -> authorized/internal or public versioned data |
|                      Range 206 + cache + correct MIME              |
+---------------+--------------------------+------------------------+
                |                          |
                v                          v
+---------------------------+   +-------------------------------+
| FastAPI systemd service   |   | Published scene storage       |
| multiple bounded workers  |   | no staging/jobs/backups       |
+-------------+-------------+   +-------------------------------+
              |
       +------+---------------------+
       |                            |
       v                            v
+------------------+        +------------------+
| PostgreSQL       |        | Redis            |
| private/local    |        | private/local    |
+------------------+        +--------+---------+
                                    |
                         +----------+-----------+
                         v                      v
                 +---------------+      +----------------+
                 | Celery CPU    |      | Celery GPU     |
                 | non-root      |      | controlled GPU |
                 +---------------+      +----------------+
```

### 发布与回滚

```text
build release <id>
       |
       v
/opt/gsplatform/releases/<id>  -- migrate check --> smoke test
       |
       +---- atomic symlink ----> /opt/gsplatform/current
                                      |
                               restart/reload services
                                      |
                              health + E2E + metrics
                                /             \
                             PASS              FAIL
                              |                 |
                           retain          previous symlink
                                             + compatible DB rollback plan
```

## 详细 Checklist

### A. 主机与账户基线

- [ ] Ubuntu 安全更新已应用，重启需求已处理。
- [ ] 创建独立的 deploy、app、worker 账户，权限和组最小化。
- [ ] SSH 使用密钥、限制管理来源，并关闭不需要的登录方式。
- [ ] 防火墙仅开放明确需要的 SSH、80、443；数据库/Redis 不公网开放。
- [ ] 系统时间同步、时区显示和 UTC 日志策略已确认。
- [ ] 文件系统为应用、数据、日志、备份预留独立容量与告警阈值。
- [ ] GPU worker 已验证驱动/CUDA，且普通 worker 账户可按最小权限使用设备。

### B. 发布目录与依赖

- [ ] 发布产物使用不可变 release ID，保留来源 commit 与构建元数据。
- [ ] Web 使用锁文件在受控环境构建，发布目录只含构建产物。
- [ ] Python 依赖从锁定版本安装到 release 专属虚拟环境或等价不可变环境。
- [ ] 外部工具 FFmpeg、COLMAP、gsplat、splat-transform 版本与 Phase 07 一致。
- [ ] `/opt/gsplatform/current` 以原子方式指向有效 release。
- [ ] 配置与秘密位于 release 之外，权限仅运行账户可读。
- [ ] 部署脚本支持 dry-run、preflight 和明确非零失败。

### C. systemd 服务

- [ ] FastAPI 使用专用 unit，绑定 localhost 或 Unix socket。
- [ ] API unit 配置非 root 用户、工作目录、环境文件、重启与资源限制。
- [ ] Celery CPU 与 GPU worker 使用不同 unit、队列、并发和资源策略。
- [ ] 定时清理/维护使用 systemd timer 或等价调度，避免重复运行。
- [ ] 服务启动依赖只表达必要关系，不因 Redis 短暂不可用形成无限重启风暴。
- [ ] stop timeout 足够让任务安全 checkpoint/重排，kill 策略有记录。
- [ ] `systemctl status`、journal 与实际任务执行均验证成功。

### D. PostgreSQL 与 Redis

- [ ] PostgreSQL 仅监听私有接口，应用使用最小权限数据库角色。
- [ ] 连接池总量不超过数据库安全上限。
- [ ] 自动 vacuum、统计、慢查询和磁盘增长监控已设置。
- [ ] Redis 仅监听私有接口，启用认证/ACL 或私有 socket，并设置内存/淘汰策略。
- [ ] Redis 持久化策略与“broker/backend 不是唯一业务真相”的设计一致。
- [ ] API/worker 暂时失去 DB/Redis 时错误可恢复且不产生假成功。

### E. Nginx 与 HTTPS

- [ ] 80 仅用于 ACME challenge/重定向到 HTTPS。
- [ ] 443 使用有效域名证书、完整链和现代安全配置。
- [ ] 证书自动续期已配置并用 dry-run/等价方式验证。
- [ ] Web SPA 路由刷新可回退到 `index.html`，资产文件 404 不误回退 HTML。
- [ ] `/api/` 反向代理保留 request ID、真实客户端协议和受信代理边界。
- [ ] API 设置请求体、连接、读取和发送超时；上传路径采用适合大文件的独立限制。
- [ ] SSE/流式响应路径关闭会破坏流式行为的缓冲。
- [ ] `/scene-assets/` 支持 206/Content-Range/416 与正确 MIME。
- [ ] 版本化资产具有长期 immutable 缓存；manifest/权限响应采用正确缓存策略。
- [ ] staging、quarantine、jobs、source、logs、backups 的 HTTP 访问返回拒绝/不存在。
- [ ] 添加 CSP、HSTS、X-Content-Type-Options、Referrer-Policy 等经验证的响应头。
- [ ] CORS 只允许生产 Web 来源，凭据设置与 Cookie 策略一致。

### F. 上传与数据目录

- [ ] staging、quarantine、published、jobs、logs、backups 的所有者和 mode 正确。
- [ ] published 与临时目录在支持原子 rename 的文件系统边界内，或实现等价提交协议。
- [ ] 磁盘配额/水位会在耗尽前阻止新任务并保留现有服务可读。
- [ ] 临时/失败/过期数据清理先 dry-run，路径根校验且不会跨 Scene 删除。
- [ ] Nginx 只对授权资源执行内部交付或读取公开版本。
- [ ] 大文件上传真实通过 Nginx -> API -> staging，不被默认 body 限制误杀。

### G. 数据库迁移与发布

- [ ] 每次发布前执行备份、磁盘、配置、依赖和迁移 preflight。
- [ ] `alembic upgrade head` 在 staging 从生产结构副本真实执行。
- [ ] 迁移与前后一个应用版本满足明确的兼容窗口。
- [ ] 破坏性迁移使用扩展/迁移/收缩多发布策略。
- [ ] release 切换、服务 reload/restart、健康检查步骤可重复。
- [ ] smoke test 失败时自动或人工按手册切回上一 release。
- [ ] 数据库不可逆变化有单独恢复方案，不伪称代码回滚等于数据回滚。

### H. 健康、日志、指标与告警

- [ ] 外部监测检查首页、`/health/live`、`/health/ready` 和一个公开 Scene manifest。
- [ ] API、Nginx、worker 日志包含 request/job ID，可跨服务追踪。
- [ ] 日志脱敏、限长、轮转和保留策略已验证。
- [ ] 监控 CPU、RAM、磁盘/inode、GPU/VRAM、DB 连接、Redis、队列深度、任务失败。
- [ ] 监控 API 延迟/错误率、上传失败、Viewer 资产 4xx/5xx、Range 成功率。
- [ ] 证书到期、备份失败、磁盘水位和 worker 离线有告警。
- [ ] 用测试事件实际触发至少一个告警并确认恢复通知。

### I. 备份与恢复

- [ ] 数据库执行自动备份，备份加密、校验并复制到故障域之外。
- [ ] published 资产、关键配置和资产数据库版本关系有一致备份策略。
- [ ] staging、可再生中间文件与缓存是否备份有明确决定。
- [ ] 备份保留和删除遵守隐私/产品策略。
- [ ] 在隔离环境真实恢复 PostgreSQL。
- [ ] 在隔离环境真实恢复一个 Scene 的 manifest、Poster、Streamed SOG 并由 Viewer 打开。
- [ ] 记录 RPO、RTO 实测值和恢复手册修订。

### J. 安全与上线验收

- [ ] 依赖、系统包和容器/主机配置完成安全扫描或清单检查。
- [ ] 生产 `.env`/secret 文件权限正确且不在 Git。
- [ ] 登录、CSRF、CORS、分享、私有资产、上传恶意输入在生产拓扑复测。
- [ ] TLS、HTTPS 重定向、安全头和 Cookie 在真实域名复测。
- [ ] 首页 5 列布局、我的作品、免费计算、上传、Viewer 全流程在真实域名复测。
- [ ] Poster、0~100%、低 LOD、Streamed SOG、右侧和底部工具在冷缓存复测。
- [ ] 执行一次受控发布与一次受控回滚演练。
- [ ] 生成 `docs/reports/PHASE_09_REPORT.md` 与运维 Runbook。
- [ ] 执行三项 Git 自检并创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### 推荐目录

```text
/opt/gsplatform/
|-- releases/<release-id>/
|-- current -> releases/<release-id>
`-- shared/
    |-- config/
    `-- venv-or-runtime-cache/

/srv/gsplatform-data/
|-- staging/
|-- quarantine/
|-- published/
|-- jobs/
|-- logs/
`-- backups-local-buffer/
```

`published` 可以位于独立数据盘，但 Phase 06 的原子发布假设必须重新验证。数据备份还要进入另一故障域，不能只保存在同一主机。

### Nginx 路由原则

```text
/assets/<content-hash>.*             public immutable Web assets
/api/v1/*                            FastAPI
/scene-assets/public/<version>/*     public versioned Scene data
/scene-assets/private/*              internal authorization path only
/*                                   SPA navigation fallback, not asset fallback
```

对 Range 资源禁止会改变字节偏移的动态压缩。通过内容哈希版本化 URL，实现发布新版本后不必清除旧缓存。

### systemd 约束

建议启用非特权用户、私有临时目录、NoNewPrivileges、受控写目录、打开文件和内存限制。具体 hardening 选项必须在 staging 验证，不得开启后导致 GPU、上传或原子发布无法工作却仍画勾。

### 部署顺序

```text
1. preflight 与备份
2. 上传不可变 release
3. 安装锁定依赖并构建/校验
4. staging/生产兼容迁移
5. 原子切换 current
6. reload/restart API 与 worker
7. reload Nginx
8. health + API + Viewer smoke
9. 观察错误率、队列、资源
10. 确认或回滚
```

### 回滚边界

应用回滚通过切回 previous release。数据库若只做向后兼容的扩展迁移，通常无需立即 downgrade；若存在不可逆数据变化，必须按发布前写好的恢复手册处理。不得在紧急情况下盲目执行 `alembic downgrade`。

## 关键目录 / 文件

```text
deploy/
|-- nginx/
|   |-- gsplatform.conf
|   |-- proxy-params.conf
|   `-- scenes-streaming.conf
|-- systemd/
|   |-- gsplatform-api.service
|   |-- gsplatform-celery-cpu.service
|   |-- gsplatform-celery-gpu.service
|   |-- gsplatform-cleanup.service
|   `-- gsplatform-cleanup.timer
|-- scripts/
|   |-- preflight.sh
|   |-- deploy_release.sh
|   |-- smoke_test.sh
|   |-- rollback.sh
|   |-- backup.sh
|   `-- restore_drill.sh
`-- env/production.env.example

docs/operations/
|-- DEPLOYMENT_RUNBOOK.md
|-- ROLLBACK_RUNBOOK.md
|-- BACKUP_RESTORE_RUNBOOK.md
|-- INCIDENT_RUNBOOK.md
`-- CAPACITY_PLAN.md
```

## 运行命令

以下命令必须在 staging 先执行。域名与路径使用受控配置替换：

```bash
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl restart gsplatform-api
sudo systemctl restart gsplatform-celery-cpu
sudo systemctl restart gsplatform-celery-gpu
sudo systemctl reload nginx
sudo systemctl --no-pager --full status gsplatform-api
sudo systemctl --no-pager --full status gsplatform-celery-cpu
sudo systemctl --no-pager --full status gsplatform-celery-gpu
```

部署与冒烟使用仓库脚本：

```bash
./deploy/scripts/preflight.sh --environment staging
./deploy/scripts/deploy_release.sh --release <release-id> --environment staging
./deploy/scripts/smoke_test.sh --base-url https://staging.example.invalid
```

`.invalid` 仅为文档占位，执行时必须使用真实受控域名。

## 验收标准

- 真实生产域名只通过有效 HTTPS 提供服务，HTTP 重定向与证书续期验证通过。
- Web SPA、API、上传、SSE/轮询、public/private Scene 资产均在 Nginx 后真实工作。
- Streamed SOG Range 返回正确 206/416；冷缓存渐进加载和 LOD 按 Phase 04 标准工作。
- PostgreSQL、Redis、内部服务未暴露公网；进程均以非 root 运行。
- 首页、我的作品、免费计算、上传、Viewer、收藏、分享、问 AI、详情完成生产拓扑 E2E。
- 监控、日志、轮转和至少一个测试告警真实验证。
- 数据库和一个完整 Scene 已在隔离环境真实恢复并由 Viewer 打开。
- 受控发布与回滚演练成功，记录实测 RPO/RTO。
- 任何未验证的证书、备份、GPU 或外部服务项都保持 `[ ]`，阶段不得 PASS。

## 自测命令

```bash
sudo nginx -t
systemctl is-active gsplatform-api
systemctl is-active gsplatform-celery-cpu
systemctl is-active gsplatform-celery-gpu
curl -fsS https://<真实域名>/health/live
curl -fsS https://<真实域名>/health/ready
curl -I https://<真实域名>/
curl -i -H "Range: bytes=0-1023" https://<真实域名>/<真实流式资产路径>
curl -i -H "Range: bytes=999999999999-" https://<真实域名>/<真实流式资产路径>
./deploy/scripts/smoke_test.sh --base-url https://<真实域名>
./deploy/scripts/restore_drill.sh --environment isolated-restore
pnpm test
pnpm build
python -m pytest -q apps/api/tests workers/tests
git status
git diff --stat
git diff
```

## 必须产物

- Ubuntu 主机、账户、目录、权限与容量基线。
- Nginx HTTPS、API、SPA、SSE、Range、缓存、安全头配置。
- FastAPI、Celery CPU/GPU、维护 timer 的 systemd units。
- 可重复的 preflight、deploy、smoke、rollback、backup、restore 脚本。
- 部署、回滚、备份恢复、事故、容量 Runbook。
- 真实域名 E2E、告警、发布/回滚与隔离恢复证据。
- `docs/reports/PHASE_09_REPORT.md`。
- 一个仅包含 Phase 09 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 主机 / 域名 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P09-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_09_REPORT.md`：

```markdown
# Phase 09 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：
- Release ID：
- 生产域名：

## 环境

- Ubuntu / kernel：
- CPU / RAM / disks / inodes：
- GPU / Driver / CUDA：
- Nginx / PostgreSQL / Redis：
- Node / Python / FFmpeg / COLMAP / gsplat / splat-transform：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## HTTPS / Nginx / Range

## systemd / DB / Redis / Worker

## 生产拓扑 E2E

| 流程 | 结果 | 证据 |
|---|---|---|
| 首页与 5 列 | PASS/FAIL |  |
| Viewer 渐进与 Streamed SOG | PASS/FAIL |  |
| 上传发布 | PASS/FAIL |  |
| 免费计算 | PASS/FAIL |  |
| 收藏/分享/问 AI/详情 | PASS/FAIL |  |

## 监控、日志与告警

## 备份恢复

- DB 恢复：
- Scene 恢复与 Viewer：
- 实测 RPO：
- 实测 RTO：

## 发布与回滚演练

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 最终结论

只有全部生产验收真实成功时，状态才能填写 PASS。
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 09 的独立部署 Agent。完整阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md、docs/PHASE_09_DEPLOYMENT.md 与已有运维文档，确认 docs/reports/PHASE_08_REPORT.md 为 PASS。门禁未通过不得部署生产。

在 Ubuntu 上以非 root 运行 API、Celery CPU/GPU 和重建工具。建立不可变 release + current 原子指针、受控数据目录、最小权限、preflight/deploy/smoke/rollback 脚本。Nginx 必须提供真实域名 HTTPS、SPA fallback、/api 代理、上传超时、SSE/流式响应、公开/私有 Scene 授权交付、Streamed SOG Range 206/416、版本缓存和安全头。PostgreSQL/Redis 不得公网暴露。

建立日志、指标、告警、磁盘/GPU/队列/证书监控。真实执行证书续期测试、生产拓扑 E2E、一个测试告警、一次受控发布/回滚。备份数据库与 published 资产，并在隔离环境真实恢复数据库和至少一个 Scene，由 Viewer 打开，记录 RPO/RTO。代码回滚不能替代数据库恢复计划。

秘密不得进入仓库、命令记录或报告。只有真实 HTTPS、服务、Range、E2E、告警、回滚和恢复成功后才勾选；失败或无法验证保持 [ ]，阶段不得 PASS。生成 docs/reports/PHASE_09_REPORT.md，执行 git status、git diff --stat、git diff。PASS 后创建独立 Phase 09 commit，不 push。最终汇报域名验收、服务状态、E2E、告警、恢复、RPO/RTO、未完成项、报告路径和 commit hash。
```

