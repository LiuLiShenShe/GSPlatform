# Phase 19：Realtime Dynamic Entities

## 阶段目标

加入秒级动态实体：

```text
Car
Tractor
Robot
Person
```

不把高速动态实体重建为周期 Gaussian。

第一版使用 Mesh / Avatar。

## Pipeline

```text
Camera / Video
      |
      v
YOLO
      |
      v
ByteTrack
      |
      v
3D Localization
      |
      v
WebSocket
      |
      v
Dynamic Entity State
      |
      v
Desktop / XR
```

## 数据

```text
entity_id
class
position
rotation
velocity
timestamp
status
```

## Checklist

- [ ] WebSocket。
- [ ] reconnect。
- [ ] interpolation。
- [ ] stale timeout。
- [ ] entity spawn。
- [ ] update。
- [ ] despawn。
- [ ] desktop。
- [ ] XR。
- [ ] coordinate transform。

## PASS

真实或录制车辆：

```text
现实轨迹
≈
数字场景轨迹
```

VR 内运动平滑。

---
