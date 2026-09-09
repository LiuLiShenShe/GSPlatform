# Architecture Decision Records

在本目录记录会影响多个 Phase、核心技术栈、安全或兼容性的决定。

推荐文件名：

```text
ADR-0001-<short-title>.md
```

最小结构：

```markdown
# ADR-XXXX：标题

- 状态：PROPOSED / ACCEPTED / SUPERSEDED
- 日期：
- 决策人：

## 背景

## 决定

## 备选方案

## 影响与风险

## 验证与回滚
```

如果负责人明确要求跳过阶段，ADR 还必须包含 `PHASE_DEPENDENCY_OVERRIDE`、被跳过的前置条件、风险、补验日期和批准人。ADR 不能把未验证 Checklist 自动变成 `[x]`。

