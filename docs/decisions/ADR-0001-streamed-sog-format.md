# ADR-0001：Streamed SOG 格式与传输选择

- 状态：ACCEPTED
- 日期：2026-09-11
- 决策人：GSPlatform autonomous execution agent（Phase 04）

## 背景

Phase 04 要求在 SuperSplat Viewer fork 的既有 SOG 能力上实现真实 Streamed SOG 加载：
资产可按上游支持的流式格式或字节范围获取，Viewer 根据相机、屏幕贡献、设备能力和近期
性能选择 LOD，优先呈现可用内容并按需细化。

前置条件是"已锁定并记录 SuperSplat Viewer、PlayCanvas Engine、splat-transform 版本"，
并且"通过当前版本的帮助与上游源码确认 Streamed SOG 的真实输入格式和 API"。

## 已锁定版本

| 组件 | 版本 | 记录位置 |
|---|---|---|
| @playcanvas/splat-transform | 3.3.3（revision d092ae9） | apps/viewer/package.json devDependencies |
| playcanvas | 2.22.0（pnpm-lock 解析） | apps/viewer/package.json |
| SuperSplat Viewer fork | @gsplatform/viewer 3.0.0 | apps/viewer/package.json |

## 决定

1. **使用上游原生 Streamed SOG 格式**：splat-transform v3.3.3 的 `lod-meta.json`
   （库内 `InputFormat = 'lod'`）。它由一个 `lod-meta.json` 索引容器 + 多个按空间分块的
   SOG 单元组成，支持结构级多 LOD（`lodLevels` / `counts` / 空间树 `tree`），并由
   `containerSource` 提供惰性解码 + 有界 LRU 缓存（默认 `cacheSize` 3）。

2. **传输采用 HTTP Range**：`@playcanvas/splat-transform` 的 `UrlReadFileSystem`
   自动探测服务器是否支持 Range；支持时用 Range 头流式定位读取，不支持时回退为整文件
   下载。因此本项目静态 origin 必须真实支持 `206` / `Content-Range` / `416`，
   否则退化为整文件下载（仍可用但失去分片语义）。

3. **多 LOD 由上游原生机制产生**：不发明不兼容的二进制格式。通过 CLI 两级构建：
   - 第一级：对归一化源 PLY 做 `--decimate`，产出 low/medium/high 三份 PLY；
   - 第二级：用 `--tag-lod 0/1/2` 将三份 PLY 堆叠（`stackLods`）为一个
     `lod-meta.json` 流式容器，配合 `--lod-chunk-count` / `--lod-chunk-extent`
     控制空间分块粒度。

4. **项目 manifest 只包装业务元数据**，不替代上游 `lod-meta.json`：
   `entryUrl` 指向版本化目录下的上游 `lod-meta.json`，`checksums.sha256` 与
   `build-info.json` 记录校验和与构建参数。

## 备选方案

1. **三个完整 SOG 文件顺序下载冒充流式加载**——被 Phase 04 明确禁止（"禁止把三个完整
   SOG 文件顺序下载冒充按需流式加载"），否决。
2. **HTTP Range 直接读取单个大 SOG**——Range 只解决字节范围，不提供空间分块与 LOD
   结构，且无法被校验脚本遍历引用；上游已有 `lod-meta.json` 结构，否决。
3. **.lcc / .lcc2（XGrids）**——上游支持的另一种多 LOD 格式，但项目其余部分（脚本、
   Viewer 加载入口、`splat-serialize.ts` 注释）以 SOG 为主；Streamed SOG（`lod`）是
   上游文档化的 SOG 家族流式格式，选定它保持与现有资产管线一致，否决 LCC。
4. **自研"Streamed SOG"二进制格式**——被明确禁止，否决。

## 影响与风险

- `UrlReadFileSystem` 的 Range 探测是运行时行为：若 origin 返回 200（整文件）而非 206，
  读取仍是正确的，但失去按需分片语义。必须用 Nginx/Vite 配置 + curl 验证锁定 206。
- `containerSource` 默认 `cacheSize` 3 会淘汰解码后的子文件；本项目 `ResidencyManager`
  在宿主侧再做一层有界缓存与预算控制，与上游缓存互补而非冲突。
- `lod-meta.json` 版本字段（当前 `version: 1`）若在上游升级后变化，`readLodSource`
  会抛错；本项目脚本锁定 splat-transform 3.3.3，构建时校验工具版本。

## 验证与回滚

- `./scripts/build_streamed_sog.sh` 可复现构建；`./scripts/verify_streamed_sog.sh`
  校验缺片、长度、哈希、索引边界与路径安全。
- `curl` 对 origin 验证 `206` / `Content-Range` / `416` / HEAD 长度。
- 回滚：Phase 03 的三档独立 SOG 管线仍保留（`build_preview_lods.sh`），如 Streamed SOG
  阻塞，可退回旧管线，但需在 Phase Report 中记录。
