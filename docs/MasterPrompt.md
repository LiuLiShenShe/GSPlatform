
```markdown
# GSPlatform Master Phase Prompt

你正在继续开发 GSPlatform。

项目根目录：

`/fj/GSPlatform`

---

## 本次只允许手工修改的两个参数

```text
PHASE_NUMBER = 7

PHASE_DOC = /fj/GSPlatform/docs/PHASE_07_RECONSTRUCTION.md
```

除这两个参数外，不需要用户再手工提供：

- 上一阶段 Report 路径
- 当前阶段 Report 路径
- 下一阶段编号
- Commit message
- Branch
- Push 命令

这些都必须由 Agent 自行推导。

---

# 一、总执行原则

你必须自主完成当前 Phase 的完整闭环：

```text
读取规范
→ 检查上一阶段
→ 检查当前代码
→ 执行开发
→ 实际运行
→ 实际测试
→ 自行核验 Checklist
→ 更新当前 Phase 文档
→ 生成 Phase Report
→ Git 自检
→ Commit
→ Push
→ 停止
```

只允许执行当前 Phase。

禁止自动进入下一 Phase。

---

# 二、第一步：检查当前仓库

首先执行：

```bash
cd /fj/GSPlatform

pwd

git status

git branch --show-current

git log --oneline -5

git remote -v
```

确认：

- 当前目录正确
- 当前 Git 仓库正常
- 当前 Branch 明确
- `origin` remote 存在
- 当前工作树状态明确

如果存在未提交修改：

必须先判断这些修改属于：

- 当前 Phase
- 上一 Phase
- 用户已有修改
- 其他来源

禁止直接：

```bash
git reset --hard
```

禁止直接：

```bash
git checkout -- .
```

禁止删除或覆盖无法确认来源的用户修改。

如果存在无法安全判断来源的未提交修改：

立即停止并报告。

---

# 三、第二步：自动推导阶段信息

根据：

```text
PHASE_NUMBER
```

自动计算：

```text
CURRENT_PHASE = PHASE_NUMBER

PREVIOUS_PHASE = PHASE_NUMBER - 1

NEXT_PHASE = PHASE_NUMBER + 1
```

Phase 文件编号统一使用两位数字：

```text
0 → 00
1 → 01
2 → 02
3 → 03
...
9 → 09
```

例如：

```text
PHASE_NUMBER = 2
```

则自动推导：

```text
CURRENT_PHASE = 2

PREVIOUS_PHASE = 1

NEXT_PHASE = 3
```

当前阶段 Report：

```text
docs/reports/PHASE_02_REPORT.md
```

上一阶段 Report：

```text
docs/reports/PHASE_01_REPORT.md
```

---

# 四、第三步：检查上一阶段

如果：

```text
PHASE_NUMBER = 0
```

则跳过上一阶段检查。

如果：

```text
PHASE_NUMBER > 0
```

必须读取：

```text
docs/reports/PHASE_<PREVIOUS_PHASE两位数>_REPORT.md
```

例如：

```text
PHASE_NUMBER = 2
```

必须读取：

```text
docs/reports/PHASE_01_REPORT.md
```

必须检查：

```text
Result

Next Phase Readiness

Known Issues

Not Completed
```

要求上一阶段必须满足：

```text
Result = PASS

Next Phase Readiness = READY
```

如果上一阶段为：

```text
PARTIAL

FAIL

NOT READY
```

则立即停止。

不得进入当前 Phase。

如果上一阶段 Report 不存在：

立即停止。

输出：

```text
PREVIOUS PHASE REPORT MISSING
```

不得自行假设上一阶段已经完成。

---

# 五、第四步：读取规范

必须完整读取：

```text
docs/00_GLOBAL_RULES.md

docs/DEVELOPMENT_PLAN.md

PHASE_DOC
```

当前 Phase 的以下内容全部以 `PHASE_DOC` 为准：

- Goal
- Checklist
- Acceptance
- Prohibited
- Implementation Requirements
- Test Requirements
- Required Artifacts

禁止只依赖本 Prompt 猜测任务。

如果不同文档存在冲突，优先级为：

```text
1. 用户当前明确指令

2. docs/00_GLOBAL_RULES.md

3. 当前 PHASE_DOC

4. docs/DEVELOPMENT_PLAN.md
```

---

# 六、第五步：检查当前实现状态

开始写代码前，必须先检查当前项目已有实现。

包括：

- 当前目录结构
- 已有源码
- 已有配置
- 已有依赖
- 已有测试
- 当前 Phase 已存在的实现
- 当前 Phase Checklist 中已经为 `[x]` 的内容
- 上一阶段留下的功能
- 当前 Phase 可能已经部分完成的内容

禁止：

因为 Checklist 当前是：

```text
[ ]
```

就直接从零重写。

如果功能已经存在：

先验证。

验证通过：

可以直接将对应任务标记为：

```text
[x]
```

验证失败：

修复后重新验证。

禁止无理由重构已正常工作的功能。

---

# 七、第六步：严格执行当前 Phase

只允许执行：

```text
PHASE_DOC
```

中定义的当前阶段任务。

禁止：

- 提前开始下一 Phase
- 无关重构
- 自行更换技术栈
- 重写已经验证正常的功能
- 删除原始资产
- 覆盖 Master PLY
- 删除用户数据
- 用 Mock 冒充真实功能
- 用 Placeholder 冒充完成
- 用理论推断代替实际验证
- 因为代码看起来正确就判定完成

如果当前 Phase 必须修复上一阶段遗留的阻塞 Bug：

允许进行最小必要修复。

但必须：

- 说明修复原因
- 在 Phase Report 中记录
- 禁止借机大范围重构上一阶段

---

# 八、第七步：Checklist 自行核验规则

这是强制规则。

每一个：

```text
[ ]
```

只有以下条件全部满足后，才允许修改为：

```text
[x]
```

必须同时满足：

1. 对应代码、配置或资产已经真实完成
2. 对应功能已经实际运行
3. 已执行实际测试
4. 测试结果通过
5. 满足当前 `PHASE_DOC` 的 Acceptance
6. 没有阻塞该任务的已知错误
7. 如果是页面功能，必须实际打开页面验证
8. 如果是 API，必须实际发送请求验证
9. 如果是 Viewer，必须实际加载场景验证
10. 如果是 Build，必须真实执行 Build 命令
11. 如果是脚本，必须实际执行脚本验证
12. 如果是数据产物，必须检查实际文件存在且有效

以下情况禁止打勾：

- 只写了代码
- 只创建了文件
- 只安装了依赖
- 只进行了静态代码阅读
- 理论上认为可以运行
- 没有实际运行
- 没有实际测试
- 测试失败
- 使用 Mock 代替真实功能
- 使用假数据冒充真实流程
- 文件存在但内容无效
- 服务启动但目标功能没有验证

如果无法验证：

保持：

```text
[ ]
```

并记录在：

```text
Known Issues
```

或：

```text
Not Completed
```

中。

禁止机械地把 Checklist 全部改成 `[x]`。

---

# 九、第八步：阶段测试与验收

完成开发后，必须重新完整读取：

```text
PHASE_DOC
```

然后执行其中规定的全部：

- Acceptance
- Build
- Test
- Unit Test
- Smoke Test
- Runtime Test
- API Test
- Browser Test
- Viewer Test
- Pipeline Test

不得只运行其中一部分就判定 PASS。

如果文档没有给出足够的自动测试：

必须自行补充合理的最小验证。

示例：

## Frontend

```bash
npm run build
```

并实际打开页面验证。

## Backend

```bash
pytest
```

并实际：

```bash
curl
```

对应 API。

## Viewer

必须实际加载真实场景。

## Pipeline

必须实际生成输出文件，并验证输出有效。

---

# 十、第九步：更新当前 Phase Checklist

完成测试后，重新逐项审核：

```text
PHASE_DOC
```

只把真实验证通过的：

```text
[ ]
```

修改为：

```text
[x]
```

然后统计：

```text
TOTAL_CHECKLIST_ITEMS

COMPLETED_ITEMS

UNCOMPLETED_ITEMS
```

例如：

```text
Checklist:

18 / 20 completed
```

---

# 十一、第十步：判定当前 Phase 状态

只允许使用以下三种状态：

```text
PASS

PARTIAL

FAIL
```

## PASS

满足：

- 当前 Phase 核心目标完成
- 所有阻塞任务完成
- Acceptance 全部通过
- 没有阻止进入下一 Phase 的问题

此时：

```text
Next Phase Readiness = READY
```

## PARTIAL

满足：

- 部分功能完成
- 仍有未完成 Checklist
- 或部分 Acceptance 未通过

此时：

```text
Next Phase Readiness = NOT READY
```

## FAIL

满足：

- 当前 Phase 核心目标未实现
- 或功能无法可靠运行
- 或关键测试失败

此时：

```text
Next Phase Readiness = NOT READY
```

---

# 十二、第十一步：生成当前 Phase Report

自动生成或更新：

```text
docs/reports/PHASE_<CURRENT_PHASE两位数>_REPORT.md
```

例如：

```text
PHASE_NUMBER = 2
```

则生成：

```text
docs/reports/PHASE_02_REPORT.md
```

Report 必须使用以下结构：

```markdown
# Phase N Report

## Result

PASS / PARTIAL / FAIL

## Summary

本阶段实际完成内容。

## Completed

- ...

## Not Completed

- ...

## Checklist

- [x] ...
- [ ] ...

## Files Changed

- ...

## Dependencies Added

- ...

## Commands Executed

```bash
...
```

## Tests

| Test | Command | Result |
|---|---|---|
| ... | ... | PASS |
| ... | ... | FAIL |

## Runtime Verification

记录实际运行验证结果。

## Known Issues

- ...

## Fixes Outside Current Phase

如果没有：

None

## Git Status Before Commit

记录 Git 自检结果。

## Commit

如果已提交：

```text
<commit hash>
```

如果未提交：

```text
None
```

## Branch

```text
<branch name>
```

## Push Result

```text
SUCCESS

FAILED

NOT EXECUTED
```

## Next Phase Readiness

READY / NOT READY
```

---

# 十三、第十二步：Git 安全检查

提交前必须执行：

```bash
git status

git diff --stat

git diff
```

必须检查是否存在：

- `.env`
- 密码
- Token
- API Key
- TLS 私钥
- SSH Key
- 数据库密码
- 临时文件
- Cache
- Build 临时产物
- `node_modules`
- Python venv
- 巨型 PLY
- 巨型 SOG
- 用户原始视频
- 用户原始图片
- 数据库文件
- 无关修改

任何敏感信息不得提交。

任何明显不应该进入 Git 的大型二进制资产不得提交，除非当前项目规范明确要求。

发现敏感信息时：

先修复，再提交。

---

# 十四、第十三步：自动生成 Commit Message

用户不需要提供 Commit Message。

必须根据：

```text
PHASE_NUMBER
```

和：

```text
PHASE_DOC
```

自动生成清晰的 Commit Message。

格式：

```text
phase<N>: <phase description>
```

示例：

```text
PHASE_NUMBER = 2

PHASE_DOC = docs/PHASE_02_SCENE_VIEWER.md
```

生成：

```text
phase2: implement scene viewer
```

示例：

```text
PHASE_NUMBER = 4

PHASE_DOC = docs/PHASE_04_STREAMED_SOG_LOD.md
```

生成：

```text
phase4: add streamed SOG and LOD
```

禁止使用：

```text
update

fix stuff

changes

work

misc
```

等无意义 Commit Message。

---

# 十五、第十四步：Commit 与 Push

如果当前 Phase：

```text
PASS
```

必须提交并 Push。

首先获取当前 Branch：

```bash
git branch --show-current
```

然后：

```bash
git add <当前阶段应该提交的文件>
```

再：

```bash
git commit -m "<自动生成的 commit message>"
```

获取 Commit Hash：

```bash
git rev-parse HEAD
```

然后 Push：

```bash
git push origin HEAD
```

如果当前 Branch 尚未设置 upstream，则执行：

```bash
git push -u origin HEAD
```

Push 后再次执行：

```bash
git status
```

确认工作树状态。

并记录：

```text
Commit Hash

Branch

Push Result
```

如果 Push 失败：

必须记录：

```text
PUSH FAILED
```

并说明具体原因。

不得声称已成功交付。

---

# 十六、PARTIAL / FAIL 的 Git 规则

如果当前 Phase 状态是：

```text
PARTIAL
```

或：

```text
FAIL
```

默认：

```text
不创建正式 Phase 完成 Commit

不 Push
```

除非用户明确要求保存 WIP。

---

# 十七、第十五步：更新 DEVELOPMENT_PLAN

如果当前 Phase：

```text
PASS
```

则更新：

```text
docs/DEVELOPMENT_PLAN.md
```

把当前阶段：

```text
- [ ] Phase N
```

修改为：

```text
- [x] Phase N
```

如果当前状态是：

```text
PARTIAL

FAIL
```

则保持：

```text
- [ ] Phase N
```

不得勾选。

---

# 十八、第十六步：停止

完成当前 Phase 后立即停止。

即使已经计算出：

```text
NEXT_PHASE
```

也禁止自动进入下一阶段。

禁止：

- 自动读取下一 Phase 后开始开发
- 顺便完成下一 Phase
- 自动连续执行多个 Phase
- 提前修改下一 Phase Checklist

只能报告：

```text
Next Phase:

READY
```

或：

```text
Next Phase:

NOT READY
```

然后等待用户下一次明确启动。

---

# 十九、最终回复格式

最终回复必须使用以下格式：

```text
Phase:
<N>

Status:
PASS / PARTIAL / FAIL

Checklist:
<X> / <Y> completed

Tests:
<通过数量> passed
<失败数量> failed

Runtime Verification:
PASS / FAIL

Known Issues:
None
```

如果存在问题：

```text
Known Issues:
- ...
- ...
```

继续：

```text
Report:
docs/reports/PHASE_<NN>_REPORT.md

Commit:
<commit hash / None>

Branch:
<branch name>

Push:
SUCCESS / FAILED / NOT EXECUTED

Next Phase:
READY / NOT READY
```

禁止最终只回复：

```text
完成了
```

或：

```text
Done
```

必须给出真实执行结果。

---

# 二十、执行前最终确认

开始当前 Phase 前，确认本次只使用以下两个人工参数：

```text
PHASE_NUMBER = 2

PHASE_DOC = docs/PHASE_02_SCENE_VIEWER.md
```

其余所有信息必须自动推导。

确认完成后，开始执行当前 Phase。
```

你可以直接保存成：

```text
docs/MASTER_PHASE_PROMPT.md
```

以后每次只改：

```text
PHASE_NUMBER = 3

PHASE_DOC = docs/PHASE_03_PROGRESSIVE_LOADING.md
```

即可。