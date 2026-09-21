# ADR-0002：Phase 13 阶段依赖覆盖（PHASE_DEPENDENCY_OVERRIDE）

- 状态：ACCEPTED
- 日期：2026-09-21
- 决策人：项目负责人（用户明确指示"先跳过 写明"）

## PHASE_DEPENDENCY_OVERRIDE

- 被跳过的前置条件：Phase 13 Report `Result = PARTIAL`（真实 VR 头显验证未完成）。
- 覆盖内容：允许在 Phase 13 报告保持 `PARTIAL` 的情况下继续 Phase 14（XR Navigation & Viewpoints）。

## 背景

Phase 13（Independent WebXR Viewer）已在开发环境完成并验证全部软件功能：

- Viewer boot（PlayCanvas AppBase，WebGPU/WebGL2 fallback）
- `navigator.xr` / VR support 检测
- Enter / Exit VR 会话生命周期
- SOG / PLY / Streamed SOG 场景加载
- Collision 碰撞代理加载
- TypeScript strict 编译、生产 Build、Dev server、运行时验证

唯一未完成项是"真实 PICO Neo 3 + PICO Connect 头显硬件验证"，属于测试环境缺少硬件，并非实现缺陷。

`00_GLOBAL_RULES.md` §4 规定前一 Phase 报告必须为 `PASS` 才能进入下一 Phase。负责人明确指示跳过该门禁并记录本 ADR。

## 决定

1. 允许在 Phase 13 Report 保持 `PARTIAL` 的情况下开始 Phase 14。
2. Phase 13 未验证 Checklist 项保持 `[ ]`，本 ADR 不将任何未验证项自动变为 `[x]`。
3. 待真实 VR 硬件可用时，合并补验 Phase 13 + Phase 14 的硬件验收项。

## 风险

- Phase 14 核心功能（摇杆移动、Snap Turn、Viewpoint 切换、Annotation 交互）依赖真实 XR 会话与手柄输入。若真机坐标/手柄映射与软件模拟不一致，可能导致真机不可用。
- 缓解：Phase 14 使用 PlayCanvas WebXR 标准输入 API（`xr.getInputSources()` / `gamepad.axes` / `gamepad.buttons`）与 PICO 标准键位映射；无硬件环境下用模拟 XR input source 做软件级验证，真机差异留待补验。

## 验证与回滚

- 补验日期：真实 PICO Neo 3 + PICO Connect 硬件可用时（负责人约定后执行）。
- 补验范围：Phase 13（VR 会话进入/退出、场景加载）+ Phase 14（连续走动、转向、≥5 个 VP 来回切换 20 次、Annotation 可点击、不卡死、无异常位姿跳变）。
- 回滚：真机验证失败时按缺陷修复，不影响已提交代码结构。
