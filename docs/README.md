# GSPlatform 开发文档

## 从这里开始

1. 阅读 [全局开发与验收规则](00_GLOBAL_RULES.md)。
2. 阅读 [分阶段开发总计划](DEVELOPMENT_PLAN.md)。
3. 从 [Phase 00](PHASE_00_BOOTSTRAP.md) 开始，严格按顺序执行。
4. 每阶段结束在 `docs/reports/` 生成对应报告。
5. 需要交给独立 Agent 时，从 [提示词索引](PROMPTS_INDEX.md) 复制相应提示词。

## 文档清单

```text
docs/
|-- README.md
|-- 00_GLOBAL_RULES.md
|-- DEVELOPMENT_PLAN.md
|-- PHASE_00_BOOTSTRAP.md
|-- PHASE_01_FRONTEND_UI.md
|-- PHASE_02_SCENE_VIEWER.md
|-- PHASE_03_PROGRESSIVE_LOADING.md
|-- PHASE_04_STREAMED_SOG_LOD.md
|-- PHASE_05_BACKEND_DATABASE.md
|-- PHASE_06_UPLOAD_PUBLISH.md
|-- PHASE_07_RECONSTRUCTION.md
|-- PHASE_08_PLATFORM_FEATURES.md
|-- PHASE_09_DEPLOYMENT.md
|-- PROMPTS_INDEX.md
|-- decisions/
|   `-- README.md
`-- reports/
    `-- README.md
```

## 阶段状态

| Phase | 文档 | Report | 状态 |
|---|---|---|---|
| 00 | [项目骨架](PHASE_00_BOOTSTRAP.md) | `PHASE_00_REPORT.md` | NOT STARTED |
| 01 | [前端 UI](PHASE_01_FRONTEND_UI.md) | `PHASE_01_REPORT.md` | LOCKED |
| 02 | [Scene Viewer](PHASE_02_SCENE_VIEWER.md) | `PHASE_02_REPORT.md` | LOCKED |
| 03 | [渐进加载](PHASE_03_PROGRESSIVE_LOADING.md) | `PHASE_03_REPORT.md` | LOCKED |
| 04 | [Streamed SOG / LOD](PHASE_04_STREAMED_SOG_LOD.md) | `PHASE_04_REPORT.md` | LOCKED |
| 05 | [后端数据库](PHASE_05_BACKEND_DATABASE.md) | `PHASE_05_REPORT.md` | LOCKED |
| 06 | [上传发布](PHASE_06_UPLOAD_PUBLISH.md) | `PHASE_06_REPORT.md` | LOCKED |
| 07 | [3DGS 重建](PHASE_07_RECONSTRUCTION.md) | `PHASE_07_REPORT.md` | LOCKED |
| 08 | [平台功能](PHASE_08_PLATFORM_FEATURES.md) | `PHASE_08_REPORT.md` | LOCKED |
| 09 | [生产部署](PHASE_09_DEPLOYMENT.md) | `PHASE_09_REPORT.md` | LOCKED |

状态表只能根据真实阶段报告更新。文件刚创建时不代表 Phase 00 已完成。

## 一句话规则

```text
真实运行 + 真实测试 + 真实验收成功 -> 才能 [ ] 改为 [x]
失败或无法验证                       -> 保持 [ ] 并记录原因
上一 Phase 不是 PASS                 -> 下一 Phase 不得开始
每 Phase                             -> 单独报告、Git 自检、单独 commit、不 push
```

