# Phase 13：Independent WebXR Viewer

## 阶段目标

新增独立：

```text
apps/xr-viewer
```

使用 PlayCanvas Engine + WebXR 加载同一 Scene Experience Manifest、SOG / Streamed SOG，使 PC 端浏览器能够通过 OpenXR / SteamVR / PICO Connect 驱动 PICO Neo 3 进入真实 Gaussian 世界。

**本阶段禁止直接把 XR 逻辑塞进现有 `apps/viewer`。**

## 前置条件

- [ ] Phase 12 `PASS`。
- [ ] HTTPS / secure context 可用。
- [ ] PlayCanvas XR browser capability 可验证。
- [ ] PICO Neo 3 + PICO Connect PCVR 可连接。
- [ ] 测试 Building 场景稳定。

## 禁止事项

- 禁止修改 Desktop Viewer 的核心 render pipeline。
- 禁止 fork 第二套 Scene 数据结构。
- 禁止 XR 使用单独手工配置的场景参数。
- 禁止 iframe 模拟 VR。
- 禁止用左右两张普通 Canvas 冒充 WebXR。

## 架构

```text
                    API
                     |
              Scene Manifest
                     |
          +----------+----------+
          |                     |
          v                     v
 apps/viewer               apps/xr-viewer
 Desktop                   WebXR
 SuperSplat                PlayCanvas
          |                     |
          +----------+----------+
                     |
              same SOG/SSOG
```

## XR Scene

```text
XrRoot
 |
 +-- PlayerRig
 |    `-- Camera
 |
 +-- GaussianWorld
 |
 +-- CollisionWorld
 |
 +-- AnnotationRoot
 |
 `-- XRUiRoot
```

## Checklist

- [ ] 创建 `apps/xr-viewer`。
- [ ] Viewer boot。
- [ ] WebGPU / WebGL fallback 明确。
- [ ] `navigator.xr` 检测。
- [ ] VR support detection。
- [ ] Enter VR。
- [ ] Exit VR。
- [ ] Camera parent rig。
- [ ] SOG 加载。
- [ ] Streamed SOG 加载。
- [ ] Manifest 同源。
- [ ] Annotation 加载。
- [ ] background / skybox。
- [ ] collision。
- [ ] runtime cleanup。

## PASS

```text
Windows
Chrome / Edge
PICO Connect
PICO Neo 3

→ 打开 /xr/scene/:id
→ Enter VR
→ Building 左右眼正确
→ 6DoF 正常
→ Exit VR
```

必须真实头显验证。

---
