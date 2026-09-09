# GSPlatform 分阶段开发总计划

## 1. 产品目标

GSPlatform 是一个面向 3D Gaussian Splatting 场景的 Web 平台。用户可以浏览公开场景、管理自己的作品、上传已经生成的场景、提交免费计算任务，并在全屏 Viewer 中以渐进方式查看低 LOD 到高质量高斯结果。

第一条端到端主路径：

```text
浏览首页
  -> 打开作品
  -> Poster 加载页显示真实进度
  -> 低 LOD 尽早可交互
  -> Streamed SOG 持续细化
  -> 收藏 / 分享 / 查看详情
```

第二条端到端主路径：

```text
登录
  -> 上传作品或提交免费计算
  -> API 创建记录
  -> Celery 执行处理 / 重建
  -> 产物发布
  -> 在“我的作品”查看
  -> 打开 Viewer 验证
```

## 2. 固定技术架构

```text
+------------------------------ Browser -------------------------------+
| React + TypeScript + Vite                                             |
| Ant Design | React Router | Zustand | Axios                           |
|                                                                         |
| /                 首页                   /works      我的作品           |
| /compute          免费计算               /upload     上传作品           |
| /scene/:sceneId   全屏 Scene Viewer                                 |
+----------------------+--------------------------+----------------------+
                       | REST / SSE               | Viewer integration
                       v                          v
+-----------------------------+      +-------------------------------+
| FastAPI /api/v1             |      | SuperSplat Viewer fork        |
| Pydantic v2                 |      | PlayCanvas Engine             |
| SQLAlchemy 2.x + Alembic    |      | SOG / Streamed SOG            |
+--------------+--------------+      +---------------+---------------+
               |                                     |
               v                                     v
+-----------------------------+      +-------------------------------+
| PostgreSQL                  |      | Scene asset storage           |
| users/scenes/assets/jobs    |      | poster/manifest/lod/chunks    |
+-----------------------------+      +-------------------------------+
               ^                                     ^
               |                                     |
+--------------+-------------------------------------+----------------+
| Redis + Celery workers                                               |
| FFmpeg -> COLMAP -> gsplat -> splat-transform -> publish            |
+----------------------------------------------------------------------+
                              |
                              v
+----------------------------------------------------------------------+
| Ubuntu + Nginx + HTTPS                                               |
+----------------------------------------------------------------------+
```

## 3. 阶段总览

| Phase | 名称 | 可交付结果 | 进入条件 | 通过证据 |
|---|---|---|---|---|
| 00 | 项目骨架 | Web、Viewer、API 可独立启动 | 无 | 三服务启动与基础检查通过✅ PASS(2026-09-09) |
| 01 | 前端 UI | 首页、我的作品、免费计算、上传、Viewer Shell | 00 PASS | 页面路由、5 列卡片、响应式与交互通过 |
| 02 | Scene Viewer | 真实 SOG 场景可在全屏页交互 | 01 PASS | 真实资产加载、相机控制、资源释放通过 |
| 03 | 渐进加载 | Poster、0~100%、低 LOD 到清晰状态可见 | 02 PASS | 真实网络/解码事件驱动进度 |
| 04 | Streamed SOG / LOD | 分片、Range、缓存和 LOD 策略上线 | 03 PASS | 限速测试与请求证据 |
| 05 | 后端数据库 | 持久化 Scene/Asset/Job/User 数据 | 04 PASS | 迁移、API、事务与测试通过 |
| 06 | 上传与发布 | 安全上传、校验、转换、原子发布 | 05 PASS | 真实上传到 Viewer 闭环 |
| 07 | 3DGS 重建 | 视频/图片到发布场景的异步流水线 | 06 PASS | 一次真实重建或明确硬件验收记录 |
| 08 | 平台功能 | 作品管理、收藏、分享、问 AI、详情 | 07 PASS | 鉴权、权限、状态一致性与 E2E 通过 |
| 09 | 部署上线 | Ubuntu + Nginx + HTTPS 可运维部署 | 08 PASS | 域名、证书、备份、恢复与冒烟通过 |

## 4. 阶段依赖图

```text
[00 工程骨架]
       |
       v
[01 产品页面]
       |
       v
[02 Viewer 基础集成]
       |
       v
[03 真实渐进加载]
       |
       v
[04 Streamed SOG / LOD]
       |
       v
[05 API / PostgreSQL]
       |
       v
[06 上传 / 发布]
       |
       v
[07 异步重建]
       |
       v
[08 平台业务闭环]
       |
       v
[09 生产部署]
```

前一节点的 `docs/reports/PHASE_<N>_REPORT.md` 必须为 `PASS`，下一节点才能开始。负责人批准的阶段覆盖必须按 `00_GLOBAL_RULES.md` 记录 ADR。

## 5. 产品页面地图

```text
/
|-- 顶部分类 + 搜索
|-- 固定 Sidebar
`-- 5 列 SceneCard 内容区

/works
|-- 我的作品
|-- 状态筛选
`-- 继续编辑 / 查看 / 删除

/compute
|-- 免费计算说明
|-- 输入素材
|-- 参数确认
`-- 任务状态

/upload
|-- 作品信息
|-- 场景文件 / Poster
|-- 可见性
`-- 校验并发布

/scene/:sceneId
|-- Poster 模糊加载层 + 0~100%
|-- 低 LOD 到高斯逐步清晰
|-- 右侧作者 / 收藏 / 分享 / 问 AI / 详情
`-- 底部 Reset / Orbit-Fly / Performance / Quality / Help
```

## 6. 统一状态模型

### Scene 状态

```text
DRAFT -> VALIDATING -> PROCESSING -> READY -> PUBLISHED
   |          |             |
   `----------+-------------+----> FAILED
PUBLISHED -> ARCHIVED
```

### Job 状态

```text
QUEUED -> RUNNING -> SUCCEEDED
   |         |
   |         +----> RETRYING -> RUNNING
   `--------------> CANCELLED
             `----> FAILED
```

### Viewer 加载状态

```text
IDLE -> POSTER -> MANIFEST -> LOW_LOD_INTERACTIVE
                              |
                              v
                        STREAMING_DETAIL
                              |
                              v
                         HIGH_QUALITY_READY

任意加载状态 -> ERROR -> RETRY
```

## 7. 里程碑建议

- M1（Phase 00~02）：能够稳定浏览一个真实场景。
- M2（Phase 03~04）：弱网下低 LOD 尽快可交互并逐步清晰。
- M3（Phase 05~06）：用户可以安全上传并发布自己的作品。
- M4（Phase 07~08）：免费计算与平台业务形成闭环。
- M5（Phase 09）：完成可恢复、可监控的生产部署。

日程由团队能力与硬件资源决定，不在未估算前承诺固定日期。

## 8. 每阶段执行方式

1. 阅读 `00_GLOBAL_RULES.md` 与当前 Phase 文档。
2. 核对上一阶段报告为 `PASS`。
3. 只修改当前 Phase 范围。
4. 按详细 Checklist 实现。
5. 实际运行服务和自测命令。
6. 手工验证页面、API、Viewer 或流水线。
7. 只有核验成功的条目才能从 `[ ]` 改为 `[x]`。
8. 失败或无法验证的条目保持 `[ ]`，写入 `Known Issues`。
9. 生成 `docs/reports/PHASE_<N>_REPORT.md`。
10. 执行 `git status`、`git diff --stat`、`git diff`。
11. 自检后创建当前阶段独立 commit，不执行 push。

## 9. 项目级完成标准

- Phase 00~09 的报告全部为 `PASS`。
- 首页、我的作品、免费计算、上传作品、全屏 Scene Viewer 均可访问。
- 真实场景能从 Poster 进入低 LOD 交互并渐进至高质量。
- 上传和免费计算都形成真实的 API、数据库、队列和产物闭环。
- 生产站点使用 HTTPS，具备健康检查、日志、监控、备份和恢复手册。
- 仓库不包含密钥、大型场景数据或未经授权的第三方品牌资产。

