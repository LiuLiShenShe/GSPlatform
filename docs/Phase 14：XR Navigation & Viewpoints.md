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

- [ ] 左摇杆。（代码完成：读取 axes[2]/axes[3]；真实移动需 PICO 设备验证）
- [x] deadzone。（单元测试通过：<0.2 归零、0.2→1 线性重映射）
- [ ] movement speed。（profile 常量已接线；实际移动未设备验证）
- [ ] head-relative movement。（轴投影数学已单测；实际移动未设备验证）
- [ ] snap turn。（已修复 `setFromEulerAngles` 弧度/角度 bug；数学单测通过；右摇杆触发未设备验证）
- [ ] gravity。（代码完成：自由下落/吸附地面；未设备验证）
- [ ] collision。（自研逐三角形 raycast 完成；无真实 GLB 碰撞网格可实测）
- [x] indoor/outdoor profile。（INDOOR/OUTDOOR 常量单测通过；URL 参数选择已接线）

### Viewpoints

- [ ] Next。（已实现 wraparound + cooldown；需 VR A 键）
- [ ] Previous。（已实现 wraparound + cooldown；需 VR B 键）
- [ ] cooldown。（1.2 s cooldown 已编码；未在 VR 长按验证）
- [ ] Fade out。（FadeOverlay.setOpacity 已编码；未在头显验证渲染）
- [ ] move rig。（applyViewpoint 已定位 rig + 转向；未设备验证）
- [ ] Fade in。（fade-in 过渡已编码；未设备验证）
- [ ] target orientation。（atan2 yaw 计算已编码；未设备验证）
- [x] wraparound。（next→first / prev→last 取模单测通过）

### Interaction

- [ ] XR ray。（perpendicular 点到射线距离测试已编码；未设备验证）
- [ ] annotation select。（trigger + 射线命中已编码；未设备验证）
- [ ] media panel。（world-space panel 已创建；CanvasFont 文本渲染已编码；未在设备视觉验证）
- [ ] close panel。（B 键 / Grip 关闭已编码；未设备验证）
- [ ] audio。（background audio URL 已接线；播放需用户手势，未在会话验证）

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
