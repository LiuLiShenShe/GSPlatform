# Phase 16：Tile Version Runtime

## 阶段目标

实现运行时 Tile 版本切换：

```text
T0 → T1
```

不重新加载整个世界。

本阶段新版本人工准备，不使用 VGGT/VGGS。

## 测试

例如：

```text
Wheat_A/T0.sog
Wheat_A/T1.sog
```

修改：

```text
current_version_id
```

Viewer 检测 World Revision。

流程：

```text
manifest revision 16
       ↓
revision 17
       ↓
diff
       ↓
only Wheat_A changed
       ↓
preload T1
       ↓
atomic swap
       ↓
release T0
```

## Checklist

- [ ] revision。
- [ ] diff。
- [ ] preload。
- [ ] checksum。
- [ ] swap。
- [ ] unload。
- [ ] rollback。
- [ ] failure fallback。
- [ ] Desktop。
- [ ] XR。

## PASS

```text
Building
Road
Wheat_A
Wheat_B
```

只更新 Wheat_A。

其他三者 GPU object 不重建。

---
