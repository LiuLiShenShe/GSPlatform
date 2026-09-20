# Phase 17：Sparse Tile Reconstruction

## 阶段目标

验证：

> 一个已有大场景 Tile，只使用少量新 RGB 图像，能否生成足以作为新 Tile Version 的 Gaussian。

Base：

```text
CityGaussian
+
VGGT
+
VGGS
```

测试数据：

```text
Mill19 Building
```

## 实验

选择 CityGaussian 某一 Block：

```text
Full Views
30 Views
20 Views
10 Views
```

输出：

```text
G_full
G_30
G_20
G_10
```

## Checklist

- [ ] Camera selection。
- [ ] deterministic split。
- [ ] VGGT inference。
- [ ] VGGS reconstruction。
- [ ] Local Gaussian。
- [ ] Sim(3) registration。
- [ ] World transform。
- [ ] version asset generation。
- [ ] viewer load。
- [ ] quantitative evaluation。

## 指标

不能只看 PSNR。

至少：

```text
PSNR
SSIM
LPIPS
Registration translation error
rotation error
scale error
VR perceptual quality
```

## PASS

确定：

```text
10 / 20 / 30
```

哪个 sparse level 能稳定作为数字孪生更新输入。

---
