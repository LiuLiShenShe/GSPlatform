# Phase 08：账户、作品、收藏、分享、问 AI 与详情

## 阶段目标

把已有 Viewer、上传与重建能力连接成完整产品：实现正式账户会话、我的作品管理、收藏、受控分享、场景详情、Viewer 右侧操作以及真正可用的“问 AI”服务。所有权限由后端执行，前端状态刷新后仍与数据库一致。

## 前置条件

- [ ] `docs/reports/PHASE_07_REPORT.md` 存在且状态为 `PASS`。
- [ ] 上传、重建、发布、我的作品读取和 Viewer 真实闭环可复现。
- [ ] 已选择并批准正式身份策略与 AI 模型服务，秘密仅由服务端持有。
- [ ] 已定义隐私条款、内容权利提示、分享与删除保留策略。
- [ ] 已记录 Phase 08 开始前 commit。

## 禁止事项

- 禁止仅隐藏按钮代替后端权限校验。
- 禁止把访问令牌放在 URL、localStorage、日志或前端构建变量中。
- 禁止把私有场景的直接资产 URL暴露给未授权用户。
- 禁止分享链接永久绕过撤销、过期和可见性规则。
- 禁止在浏览器中放置 AI 服务密钥或直接发送内部存储路径。
- 禁止把固定文本、关键词模板或随机内容称为 AI 回答。
- 禁止 AI 回答虚构场景事实；无法从允许上下文得出时必须说明。
- 禁止删除仍被运行任务使用的资产或越过保留期规则。
- 禁止自动 push。

## 纯文本页面草图

### 我的作品

```text
+----------------------------------------------------------------------------------------+
| Sidebar      | 我的作品                  [搜索] [状态 v] [排序 v] [+ 上传作品]          |
|              +-------------------------------------------------------------------------+
|              | [全部] [草稿] [处理中] [已发布] [失败] [已归档]                         |
|              |                                                                         |
|              | +---------------------------+ +---------------------------+             |
|              | | Poster        PUBLISHED   | | Poster        PROCESSING  |             |
|              | | 标题 / 可见性 / 更新时间 | | 标题 / 真实阶段与进度    |             |
|              | | [查看] [编辑] [更多 v]   | | [查看任务] [请求取消]    |             |
|              | +---------------------------+ +---------------------------+             |
|              |                                                                         |
|              | 更多：复制分享链接 / 设为私有 / 归档 / 删除（确认）                     |
+--------------+-------------------------------------------------------------------------+
```

### Viewer 详情与问 AI

```text
+----------------------------------------------------------------------------------------+
| 真实 Scene Viewer                                                                      |
|                                                                                        |
|                                                         +----------------------------+ |
|                                                         | 作者头像/名称              | |
|                                                         | [收藏] [分享]              | |
|                                                         | [问 AI] [详情]             | |
|                                                         +----------------------------+ |
|                                                         | 问 AI 面板                 | |
|                                                         | 场景可见信息摘要           | |
|                                                         | [输入问题____________] [发] | |
|                                                         | 回答 / 来源字段 / 风险提示 | |
|                                                         +----------------------------+ |
| Reset | Orbit/Fly | Performance | Quality | Help                                      |
+----------------------------------------------------------------------------------------+
```

### 分享访问

```text
Owner 创建分享 -> 随机 token 的 hash 入库 -> 返回一次可复制 URL
                                         |
访客打开 URL -> 检查撤销 / 过期 / Scene 状态 / 权限 -> Viewer 或明确错误
                                         |
Owner 撤销 ----> 旧 URL 立即失效，不影响 Scene 自身数据
```

## 详细 Checklist

### A. 正式账户与会话

- [ ] 实现注册/邀请、登录、登出、当前用户和会话撤销的批准方案。
- [ ] 密码方案使用成熟库与强哈希；若使用外部身份则验证 issuer/audience/signature/expiry。
- [ ] 浏览器会话使用 Secure、HttpOnly、SameSite 合适的 Cookie。
- [ ] 状态修改请求有 CSRF 防护或等价安全设计。
- [ ] 登录和敏感动作有服务端速率限制与审计事件。
- [ ] 会话过期时 Axios 统一处理，保留可恢复页面状态。
- [ ] 删除所有开发身份旁路，或 production 启动严格拒绝。
- [ ] 日志、错误和前端状态不含凭据。

### B. 我的作品管理

- [ ] `/works` 使用真实分页 API、URL 筛选和排序。
- [ ] 显示 DRAFT/PROCESSING/PUBLISHED/FAILED/ARCHIVED 的真实状态。
- [ ] 编辑标题、简介、分类、可见性使用 schema 校验和冲突控制。
- [ ] 归档、恢复、删除均有二次确认和后端权限校验。
- [ ] 删除采用可恢复/延迟清理策略，不在请求中递归删除大目录。
- [ ] 处理中作品可查看真实 job、请求取消和失败重试资格。
- [ ] 多标签页更新发生冲突时显示 409 并允许重新加载。

### C. 收藏

- [ ] 数据库建立 Favorite(user_id, scene_id) 唯一约束。
- [ ] 收藏/取消 API 幂等且校验 Scene 可见性。
- [ ] Viewer 与 SceneCard 的收藏状态来自同一 API/缓存策略。
- [ ] 乐观更新失败时回滚并提示，不显示错误成功状态。
- [ ] 刷新、重新登录和多标签页后状态与数据库一致。
- [ ] 私有化或删除后的场景不会通过收藏列表泄露。

### D. 分享

- [ ] 公共 Scene 分享使用规范平台 URL，不暴露 storage key。
- [ ] 私有/未列出 Scene 的分享由 owner 显式创建可撤销、可过期 token。
- [ ] 数据库只存 token hash、权限、expiry、revoked_at 和审计时间。
- [ ] 原始 token 只在创建响应返回，不写日志。
- [ ] 分享访问再次校验 Scene 状态与资产版本。
- [ ] 撤销和过期在 API 与静态资产访问层真实生效。
- [ ] Web Share API 不可用时提供安全复制链接回退。

### E. 场景详情与作者

- [ ] 右侧作者入口展示允许公开的作者信息与作品列表。
- [ ] 详情面板展示标题、简介、分类、发布日期、可见统计、当前版本和允许的技术信息。
- [ ] 不展示内部绝对路径、原始上传文件名、任务日志或私有 EXIF。
- [ ] 详情加载有真实 loading/empty/error/retry 状态。
- [ ] Scene 更新后 Viewer 标题、详情和列表保持一致。

### F. 问 AI

- [ ] 定义服务端 `SceneAssistantService`，前端不直接调用模型服务。
- [ ] 模型密钥、endpoint 和模型标识只存在服务端可信配置。
- [ ] 上下文只包含用户有权看到的 Scene 元数据、公开描述、技术统计和明确允许的文本。
- [ ] 不向模型发送场景文件、私有路径、令牌、Cookie 或其他用户信息。
- [ ] 请求有身份/分享权限校验、长度限制、速率限制、超时和取消。
- [ ] 回答是真实模型响应；未配置或调用失败时明确不可用，不用固定文本冒充。
- [ ] 回答区标明基于哪些场景字段，并在信息不足时承认无法判断。
- [ ] 防止场景描述中的文本覆盖系统安全规则，输入输出经过安全策略处理。
- [ ] 若采用流式回答，断线、重连和取消不会生成重复消息。
- [ ] 保存对话前取得明确产品决策；默认最小化保留。

### G. 统计与一致性

- [ ] 浏览、收藏等统计使用可解释口径，防止刷新无限累加。
- [ ] 计数更新有幂等 key 或异步聚合策略。
- [ ] SceneCard、详情和 Viewer 显示同一后端字段语义。
- [ ] 缓存失效包含 visibility、currentVersion 和删除状态。
- [ ] 公开列表不会读取到未提交事务或未发布版本。

### H. 测试与收尾

- [ ] 测试登录、过期、撤销、CSRF、速率限制和未认证状态。
- [ ] 测试 owner/非 owner 对编辑、归档、删除、任务、资产的权限矩阵。
- [ ] 测试收藏唯一性、乐观回滚和私有化后的不可见。
- [ ] 测试分享创建、访问、撤销、过期和 token 不入日志。
- [ ] 使用真实批准模型服务验证问 AI 正常、超时、失败、取消和越权上下文。
- [ ] E2E 覆盖登录 -> 我的作品 -> Viewer -> 收藏 -> 分享 -> 问 AI -> 详情。
- [ ] API、Web、Viewer 的 lint/typecheck/test/build 全部成功。
- [ ] 生成 `docs/reports/PHASE_08_REPORT.md`。
- [ ] 执行三项 Git 自检并创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### 数据表增量

```text
sessions
  id, user_id, secret_hash/identifier, expires_at, revoked_at, created_at, last_seen_at

favorites
  user_id, scene_id, created_at
  UNIQUE(user_id, scene_id)

share_links
  id, scene_id, owner_id, token_hash, expires_at, revoked_at, created_at

assistant_threads / assistant_messages（仅在批准保存对话时）
  owner_id, scene_id, role, content, model_metadata, created_at
```

全部结构变化使用新的 Alembic migration，升级/降级与既有数据迁移必须测试。

### 资产授权

API 返回业务 manifest 地址。对于非公开场景，可由 API 鉴权后返回短期签名的同源资源路径，或让 Nginx 通过内部重定向交付；浏览器不能通过猜测静态目录绕过权限。签名至少绑定 asset version、expiry 和权限范围。

### 问 AI 上下文

```text
允许：标题、公开简介、分类、作者公开名、发布日期、Viewer 可见技术统计、用户本轮问题
默认不允许：原始文件、EXIF、内部路径、原始日志、他人私有信息、密钥、隐藏审核字段
```

服务端固定安全指令与上下文边界。Scene 文本作为不可信数据包裹，不能当作系统指令。UI 显示模型回答可能不准确，并提供重新提问/报告问题。

### 前端数据策略

Zustand 继续只承载会话概要和必要 UI 状态；服务端资源以请求缓存/显式 service 层管理。收藏乐观更新包含 snapshot 和 rollback。过滤、排序和分页写入 URL，刷新可恢复。

## 关键目录 / 文件

```text
apps/api/app/
|-- api/v1/
|   |-- auth.py
|   |-- favorites.py
|   |-- shares.py
|   `-- assistant.py
|-- core/
|   |-- security.py
|   |-- csrf.py
|   `-- rate_limit.py
|-- services/
|   |-- auth_service.py
|   |-- favorite_service.py
|   |-- share_service.py
|   `-- scene_assistant.py
`-- db/models/
    |-- session.py
    |-- favorite.py
    `-- share_link.py

apps/web/src/features/
|-- auth/
|-- works/
|-- favorites/
|-- share/
|-- scene-details/
`-- scene-assistant/
```

## 运行命令

```bash
cd apps/api
source .venv/bin/activate
alembic upgrade head
python -m uvicorn app.main:app --reload --port 8000

cd ../..
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
```

Redis、Celery 和 Viewer 资产服务按 Phase 06/07 的开发运行方式启动。AI 模型配置通过服务端环境变量注入，不写在命令历史或文档报告中。

## 验收标准

- 正式会话在登录、刷新、过期、登出和撤销后行为正确，production 无开发旁路。
- “我的作品”能真实编辑、筛选、归档、恢复、删除/延迟清理和查看任务。
- 收藏在 SceneCard 与 Viewer 一致，失败可回滚，私有化后不泄露。
- 私有分享可创建、访问、撤销和过期；原始 token 不入库明文、不入日志。
- 右侧作者、收藏、分享、问 AI、详情均连接真实服务。
- 问 AI 返回批准模型的真实响应，严格限制上下文；失败不以模板回答冒充。
- 完整 E2E 在刷新与多标签页条件下保持数据库一致。
- 所有权限不仅在前端隐藏，还由 API 与资产交付层验证。

## 自测命令

```bash
cd apps/api
python -m ruff check .
python -m mypy app
python -m pytest -q
alembic downgrade -1
alembic upgrade head
alembic check

cd ../..
pnpm --filter @gsplatform/web lint
pnpm --filter @gsplatform/web typecheck
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
pnpm --filter @gsplatform/web test:e2e --grep "platform features"
git status
git diff --stat
git diff
```

## 必须产物

- 正式身份/会话、CSRF、速率限制与权限矩阵。
- 我的作品管理、收藏、分享、作者与详情真实 API/UI。
- 服务端 SceneAssistantService 和真实模型调用的安全边界。
- 相关 Alembic 迁移、API/安全测试和完整 E2E。
- `docs/reports/PHASE_08_REPORT.md`。
- 一个仅包含 Phase 08 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 用户 / 场景 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P08-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_08_REPORT.md`：

```markdown
# Phase 08 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：

## 环境与已批准服务

- 身份策略：
- AI 服务类型 / 模型标识：不记录密钥
- 数据保留策略版本：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 权限矩阵测试

| 操作 | Owner | 登录非 Owner | 匿名/分享访问 | 结果 |
|---|---|---|---|---|
| 查看 |  |  |  |  |
| 编辑 |  |  |  |  |
| 收藏 |  |  |  |  |
| 分享管理 |  |  |  |  |
| 资产读取 |  |  |  |  |

## 收藏 / 分享 / 详情一致性

## 问 AI 真实调用、安全、失败与取消结果

## E2E 与自动测试结果

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 09 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 08 的独立执行 Agent。先阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md、docs/PHASE_08_PLATFORM_FEATURES.md，并确认 docs/reports/PHASE_07_REPORT.md 为 PASS。否则停止。

完成正式账户会话、我的作品管理、收藏、可撤销/过期分享、作者与详情、Viewer 右侧真实操作和服务端问 AI。所有写操作和资产访问必须由后端检查身份/分享权限；会话使用安全 Cookie 与 CSRF 防护，production 删除或拒绝开发身份旁路。token 仅存 hash，原始值不入日志。

问 AI 必须通过服务端 SceneAssistantService 调用已批准模型，密钥不得进入浏览器。只发送用户有权看到的场景元数据和允许文本；把场景文字当作不可信数据。真实测试回答、信息不足、超时、失败、取消、速率限制和越权。固定文本或随机内容不能作为 AI 成功证据。

执行登录 -> 我的作品 -> Viewer -> 收藏 -> 分享 -> 问 AI -> 详情 E2E，并覆盖 owner/非 owner/匿名权限矩阵、刷新、多标签页、撤销和过期。只有真实成功后才勾选；失败或无法验证保持 [ ] 并记录。生成 docs/reports/PHASE_08_REPORT.md，执行 git status、git diff --stat、git diff。PASS 后创建独立 Phase 08 commit，不 push。最终汇报权限、状态一致性、AI 真实证据、未完成项、报告路径和 commit hash。
```

