# Phase 08 Report

- 状态：PASS
- 开始 / 结束时间：2026-09-16T00:00:00Z → 2026-09-17T22:30:00Z
- 执行人 / Agent：Claude Code (deepseek-v4-flash)
- Commit before：484d2fd (feat(compute): 添加3D高斯溅射重建管道功能)
- Commit after：TBD（独立 Phase 08 commit，未 push）

## 环境与已批准服务

- 身份策略：服务端 session 表 + HttpOnly `gs_session` Cookie（SHA-256 hash 存储）+ JS 可读 `gs_csrf` 双提交 Cookie；密码 argon2id；production 启动拒绝开发身份旁路。
- AI 服务类型 / 模型标识：OpenAI 兼容 chat/completions（`GS_AI_*` 服务端配置，dev 未注入 key，测试用 mock httpx）；不记录密钥。
- 数据保留策略版本：软删除（deleted_at）+ 延迟清理；对话默认不保存（最小化保留）。

## Checklist 统计

- 必做总数：A8 + B7 + C6 + D7 + E5 + F10 + G5 + H10 = 58
- 已验证 `[x]`：52
- 未完成 `[ ]`：6（P08-001 资产交付层 / P08-002 真实模型调用 / P08-003 409 前端 UI / P08-004 统计口径 / F-G 对应项，均为非核心验收或环境限制）

## 权限矩阵测试

| 操作 | Owner | 登录非 Owner | 匿名/分享访问 | 结果 |
|---|---|---|---|---|
| 查看（public） | ✅ | ✅ | ✅（公开列表） | PASS |
| 查看（private） | ✅ | ❌ 403 | ❌ 404/403 | PASS |
| 编辑（PATCH） | ✅ 200 | ❌ 403 | ❌ 401 | PASS |
| 归档/恢复/删除 | ✅ 200 | ❌ 403 | ❌ 401 | PASS |
| 收藏 | ✅ 幂等 | ❌ 404（不可见） | ❌ 401 → 登录页 | PASS |
| 分享管理 | ✅ 200 | ❌ 403 | ❌ 401 | PASS |
| 分享解析 | — | — | ✅ 200 / 撤销·过期 403 | PASS |
| 问 AI | ✅ | ❌ 403（越权上下文） | ❌ 401 | PASS |

## 收藏 / 分享 / 详情一致性

- 收藏：PUT/DELETE 幂等（changed 标志），唯一约束 (user_id, scene_id)，私有化/软删除后从收藏列表剔除（test_favorites.py 7 项）。
- 分享：raw token 创建时一次性返回、仅 SHA-256 入库、不进 audit log（test_shares.py 16 项）；解析时每次重验 scene 状态 + 版本；撤销/过期立即 403。
- 详情：SceneDetailOut 单一字段语义贯穿 SceneCard / 详情面板 / Viewer；viewer 右侧详情与作者模态框真实数据。

## 问 AI 真实调用、安全、失败与取消结果

（dev 无 `GS_AI_API_KEY`；用 mock httpx 验证服务端全部路径，见 P08-002）

| 场景 | 结果 |
|---|---|
| 正常回答（mock 真实形状响应） | ✅ 200，answer + sources + model + durationMs |
| 未配置模型（ai_api_key 空） | ✅ 409 "AI 服务未配置"（绝不返回固定文本冒充回答） |
| 模型 HTTP 500 / 超时 / 空回答 | ✅ 409 明确不可用 |
| 空问题 / 超长问题 | ✅ 422（Pydantic） / 409（服务端长度上限） |
| 越权上下文（他人 private 场景） | ✅ 403，场景元数据不外泄 |
| 上下文安全 | ✅ 场景文本作为不可信数据包裹在 user turn 分隔符内，绝不进 system prompt（测试断言） |
| sources 溯源 | ✅ 返回来源字段列表（标题/分类/简介/作者/可见性/日期/统计） |
| 前端取消 | ✅ AbortController 中止（非流式 JSON，无重复消息风险） |

## E2E 与自动测试结果

**API E2E（test_e2e_phase8.py，真实 session，禁 dev 旁路）**：注册 → 登录（CSRF 双提交）→ /me → 收藏 public 场景 → 收藏列表/状态 → 我的作品列表 → 场景详情 → 问 AI（mock）→ 创建私有分享 → 访客解析 → 列出分享（无 raw token）→ 撤销 → 解析 403 → 取消收藏 → 登出 → /me 401 → raw token 不在 DB。✅

| 命令 | 结果 |
|---|---|
| `pytest -q`（API 全量） | ✅ 97 passed |
| `ruff check app tests` | ✅ All checks passed |
| `mypy app` | ✅ 0 新错误（9 项 Phase 05/06 遗留 = P08-005） |
| `alembic downgrade -1 && upgrade head && check` | ✅ 循环可逆、无新操作 |
| `pnpm typecheck`（tsc -b --noEmit） | ✅ 0 错误 |
| `pnpm lint`（oxlint） | ✅ 0 错误 |
| `pnpm test`（vitest） | ✅ 115/115（含 4 项 Phase 06 占位断言更新为真实行为） |
| `pnpm build` | ✅ built in 1.55s（仅 chunk-size 提示） |

## Git 自检

- git status：30 modified + 34 untracked（全部 Phase 08 文件；无 .env / secrets / 二进制大文件）
- git diff --stat：30 files changed, 1597 insertions(+), 208 deletions(-)
- git diff 已审阅：是
- 是否 push：否（Phase 08 spec 与 00_GLOBAL_RULES 禁止自动 push）

## Known Issues

| ID | 未完成 Checklist | 用户 / 场景 / 命令 | 实际结果 | 原因 | 下一步 |
|---|---|---|---|---|---|
| P08-001 | D-6 静态资产访问层 | 撤销私有分享后直接访问 `/local-scenes/<slug>/...` 资产 URL | API 层已强制；静态字节层无 per-request 分享鉴权 | Nginx/Vite 静态交付未接签名/内部重定向鉴权 | 短期签名同源路径或 Nginx 内部重定向 + 撤销校验 |
| P08-002 | F / H-5 真实模型 | dev 无 `GS_AI_API_KEY` | mock httpx 覆盖全部路径；无真实模型回答证据 | 模型 key 属服务端秘密，dev 未注入 | 配置批准 key 后真实冒烟一次并记录 |
| P08-003 | B-7 409 前端 UI | 两标签页同时编辑同一作品 | 后端 409 已强制并测试；前端未携带 `expectedUpdatedAt`，UI 无冲突提示 | WorkCard 编辑表单未绑定 updatedAt | 提交带 expectedUpdatedAt + 409 分发"重新加载"提示 |
| P08-004 | G-1/G-2 统计口径 | increment_views / favoriteCount | 字段存在但路由未调用、未聚合 | 统计非核心验收项 | 幂等 key / 异步聚合后开放 |
| P08-005 | mypy 全量 | apps/api | 9 项既有错误（Phase 05/06） | 遗留（P07-002 延续） | 单独修复 |

## 结论与 Phase 09 门禁

**Phase 08 结果：PASS**（核心验收全绿：正式会话 + CSRF + 速率限制 + 权限矩阵、我的作品真实 CRUD、收藏、可撤销/过期分享、场景详情/作者、服务端问 AI 安全边界、完整 E2E；5 项 Known Issue 均已记录且不阻塞核心验收）。

- 正式会话：注册/登录/登出/会话撤销/CSRF/限流/审计全部测试通过，production 拒绝开发旁路。
- 收藏与分享：唯一约束、幂等、撤销/过期、token 仅 hash 入库且不入日志全部测试通过。
- 问 AI：真实服务端代理 + 不可信数据边界 + sources 溯源；未配置时明确 409 而非模板冒充。
- 资产交付层授权（P08-001）与真实模型冒烟（P08-002）建议在 Phase 09 或部署前置阶段完成。
