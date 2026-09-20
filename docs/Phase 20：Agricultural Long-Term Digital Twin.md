

## 阶段目标

把前面所有能力合并成真实农业观测站长期数字孪生。

最终世界：

```text
Static
├── Building
├── Road
└── WeatherStation

Periodic
├── Wheat_A
├── Wheat_B
└── Corn_A

Realtime
├── Tractor
├── Robot
└── Person

Sensor
├── Temperature
├── Humidity
└── Soil Moisture
```

## 更新时间尺度

```text
建筑      月 / 年

农田      天 / 周

车辆      秒

传感器    秒 / 分钟
```

## Timeline

```text
Apr 01
Apr 08
Apr 15
Apr 22
...
```

切换日期：

```text
Static 保持
Periodic Tile 切版本
Realtime 使用当前实时状态
```

## Checklist

- [ ] 农业 Scene。
- [ ] Static Tiles。
- [ ] Periodic Tiles。
- [ ] RTK/GCP/永久 anchor。
- [ ] 周期采集协议。
- [ ] sparse update。
- [ ] change-aware。
- [ ] tile versions。
- [ ] time slider。
- [ ] XR。
- [ ] realtime entities。
- [ ] sensor UI。

