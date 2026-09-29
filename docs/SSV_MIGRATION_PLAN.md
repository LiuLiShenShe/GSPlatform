# SSV_MIGRATION_PLAN：SuperSplat Viewer 迁移总计划

- 状态：ACTIVE（顺序 FROZEN）
- 日期：2026-09-28
- 架构依据：`docs/adr/ADR_SUPERSPLAT_RUNTIME.md`
- 当前阶段：**SSV-08 — Streaming / LOD / Performance（已完成）**

---

## 目标

把 GSPlatform 的 Scene Runtime 从「自维护 fork（`apps/viewer`）+ 独立 PlayCanvas XR viewer（`apps/xr-viewer`）」迁移为**单一官方 `@playcanvas/supersplat-viewer`**，期间不丢失任何业务能力。

冻结版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（SSV-00 ～ SSV-10 完成前禁止升级）。

---

## 阶段顺序（FROZEN，不得随意改变）

| 阶段 | 名称 | 内容 | 出口标准 |
|---|---|---|---|
| **SSV-00** | Architecture Freeze | 架构冻结、依赖审计、ADR、文档、基线 | ADR + 迁移计划 + 报告；typecheck baseline 记录 |
| **SSV-01** | Runtime Contract | 定义官方 runtime 契约（GSPlatform → Viewer's settings/commands 面） | 契约类型定义 + 单元测试 |
| **SSV-02** | Official Runtime Wrapper | 官方 runtime wrapper（把 `apps/web/src/xr/XRViewerRuntime.ts` 泛化为 Desktop+XR 共用） | Desktop / XR 共用一个 wrapper |
| **SSV-03** | Desktop Migration | Desktop 从 iframe fork 切到官方 runtime | Desktop 走官方 runtime；`ViewerAdapter` 退役 |
| **SSV-04** | XR Unification | XR 统一到同一官方 runtime | Desktop / XR 同 runtime（XR 强制 WebGL）；`apps/xr-viewer` 退役为 FROZEN |
| **SSV-05** | Experience Settings | Experience Settings v2 落地（Authoring UI → DB → Adapter → Viewer） | 相机/背景/变换等设置经官方 settings 生效 |
| **SSV-06** | Annotation / Media / Audio | Annotation runtime、Media、Background Audio 迁移 | 标注/音频在官方 runtime 中工作 |
| **SSV-07** | Collision / Walk | Collision runtime、walk/teleport 迁移 | 碰撞行走可用 |
| **SSV-08** | Streamed SOG / LOD | Streamed SOG、LOD、splat budget、performance mode 迁移 | 大场景流式加载可用 |
| **SSV-09** | Legacy Cleanup | 清理 `apps/viewer`、`apps/xr-viewer`、旧契约与测试 | 两个 legacy 目录删除，仓库无 fork 残留 |
| **SSV-10** | Production Acceptance | 生产验收（含真实头显硬件验证） | 全部能力在官方 runtime 上验收通过 |

---

## 不可变约束（贯穿 SSV-00 ～ SSV-10）

1. 迁移期间**禁止**升级 `@playcanvas/supersplat-viewer` / `playcanvas`。
2. 不得为实现 XR / walk / collision / annotation / LOD / skybox 而 fork 官方 viewer（除非新的 ADR 批准）。
3. `apps/viewer`、`apps/xr-viewer` 在 SSV-09 之前不删除，但**冻结**，不新增生产功能。
4. 每阶段开始前先读 `docs/adr/ADR_SUPERSPLAT_RUNTIME.md`；如发现与本计划冲突，先改 ADR，再改代码。
5. 每阶段结束产出 `docs/reports/SSV_XX_REPORT.md`（RESULT: PASS / BLOCKED）。
6. 不得进行与当前阶段无关的重构 / 修复（typecheck 基线错误按 SSV-00 记录数保留，直至其所属阶段处理）。

---

## 阶段间依赖

- SSV-01 → SSV-02：契约先定，wrapper 才有稳定接口。
- SSV-02 → SSV-03 / SSV-04：Desktop 与 XR 复用同一 wrapper，避免二次实现。
- SSV-03 / SSV-04 → SSV-05 ～ SSV-08：所有能力迁移都建立在「已切到官方 runtime」之上。
- SSV-05 ～ SSV-08 内部顺序（settings → annotation/media/audio → collision/walk → streaming/LOD）不可颠倒：settings 是所有能力的承载面，streaming 最复杂放最后。
- SSV-09 依赖 SSV-03 ～ SSV-08 全部完成（无 legacy 依赖后才可删目录）。
- SSV-10 依赖 SSV-09。

---

## 关联文档

- `docs/adr/ADR_SUPERSPLAT_RUNTIME.md` — 生产 runtime 决策与职责边界
- `docs/reports/SSV_00_REPORT.md` — SSV-00 阶段报告
- `docs/reports/WEBXR_REPAIR_REPORT.md` — 官方 viewer WebXR 路径来源审计
- `docs/decisions/ADR-0001-streamed-sog-format.md` — 流式 SOG 格式
