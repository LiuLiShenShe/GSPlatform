# Phase 14：XR Navigation & Viewpoints

## 阶段目标

在 Phase 13 XR Viewer 上实现完整 PICO 交互：

```text
左摇杆：自由移动
右摇杆左右：Snap Turn
A：Next Viewpoint
B：Previous Viewpoint
Trigger：Annotation
Grip/Menu：XR Menu
```

支持自由漫游和固定观察点两种导航方式。

## 前置条件

- [ ] Phase 13 `PASS`。
- [ ] Viewpoint 数据来自 Phase 10。
- [ ] Collision 来自 Phase 12。
- [ ] Annotation 来自 Phase 11。

## 禁止事项

- 禁止直接设置 HMD Camera world transform。
- 禁止手柄移动绕过 Collision。
- 禁止长按 A/B 一帧触发几十次。
- 禁止桌面和 XR 各保存一套 Viewpoint。

## 架构

```text
PICO Gamepad
     |
     v
XRInputManager
     |
+----+------------+
|                 |
v                 v
Locomotion   ViewpointManager
|                 |
v                 v
PlayerRig      PlayerRig
```

## Checklist

### Navigation

- [ ] 左摇杆。
- [ ] deadzone。
- [ ] movement speed。
- [ ] head-relative movement。
- [ ] snap turn。
- [ ] gravity。
- [ ] collision。
- [ ] indoor/outdoor profile。

### Viewpoints

- [ ] Next。
- [ ] Previous。
- [ ] cooldown。
- [ ] Fade out。
- [ ] move rig。
- [ ] Fade in。
- [ ] target orientation。
- [ ] wraparound。

### Interaction

- [ ] XR ray。
- [ ] annotation select。
- [ ] media panel。
- [ ] close panel。
- [ ] audio。

## PASS

真实 PICO Neo 3：

```text
连续走动
转向
至少 5 个 VP
来回切换 20 次
Annotation 可点击
不卡死
无异常位姿跳变
```

---
