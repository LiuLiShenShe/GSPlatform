# Phase Reports

每个阶段结束时，执行 Agent 从对应 Phase 文档复制报告模板，并创建：

```text
PHASE_00_REPORT.md
PHASE_01_REPORT.md
PHASE_02_REPORT.md
PHASE_03_REPORT.md
PHASE_04_REPORT.md
PHASE_05_REPORT.md
PHASE_06_REPORT.md
PHASE_07_REPORT.md
PHASE_08_REPORT.md
PHASE_09_REPORT.md
```

初始包不预先创建空报告，避免被误认为阶段已经执行。报告必须包含真实环境、真实命令、退出码、人工验收、Known Issues、Git 自检和最终状态。

只有必做 Checklist 全部真实通过时才能填写 `PASS`。失败填写 `FAIL`；受外部环境阻断且无法完成验证时填写 `BLOCKED`。两种情况都不能解锁下一阶段。

