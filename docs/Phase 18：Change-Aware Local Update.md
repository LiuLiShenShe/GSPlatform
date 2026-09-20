# Phase 18：Change-Aware Local Update

## 阶段目标

从“人工指定更新哪个 Tile”升级为：

> 系统通过新稀疏观测自动判断哪些区域发生变化，只对变化 Tile 建立新版 Gaussian。

Base：

```text
LTGS-style localization
+
Change Detection
+
VGGT/VGGS
```

## Pipeline

```text
New RGB
  |
  v
Localization
  |
  v
Render old world
  |
  v
Old vs New
  |
  v
Change Mask
  |
  v
3D projection
  |
  v
Tile Change Score
  |
  +--- unchanged -> keep old
  |
  `--- changed -> reconstruct
```

## Tile score

例如：

```text
Building  0.02
Road      0.04
Wheat_A   0.63 UPDATE
Wheat_B   0.07
```

## Boundary Fusion

必须处理：

```text
Old Context
   |
Overlap
   |
New Tile
```

考虑：

```text
geometry
appearance
opacity
density
duplicate Gaussian
```

## PASS

在测试场景中：

```text
自动选择正确 Tile
只生成该 Tile 新版本
其他 Tile 不变化
边界没有明显空洞或双影
```

---
