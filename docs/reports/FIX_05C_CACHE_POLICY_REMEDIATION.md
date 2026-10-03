# FIX_05C_CACHE_POLICY_REMEDIATION：Cache-Control 优先级收口报告

- 日期：2026-10-01
- 阶段：FIX-05C —— 最终缓存策略收口（**无新业务功能**；修复 Backend cache 优先级 +
  Nginx fallback 同步 + 测试矩阵 + 验收文档统一）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体/运行时对齐）PASS ·
  FIX-04（生产验收，软件项）PASS · FIX-05（独立审计整改）PASS · FIX-05B（Vite 收尾）PASS
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（**未升级**）

---

## RESULT

**PASS** —— Backend cache 优先级 bug 已修复，全部门禁通过，软件侧最后一个缓存 blocker 关闭。
**Hardware acceptance 不伪造**：Quest/PICO 真机验收未执行（PENDING，见 PRODUCTION_RUNTIME_ACCEPTANCE.md）。

## ROOT CAUSE

`SceneAssetService.build_cache_control()`（`apps/api/app/services/scene_asset.py`）的
**优先级顺序错误**：文件名特例（`manifest.json` / `poster.webp`）被放在 **scope / 路径语义
之前**，导致：

```text
current/manifest.json   → public, max-age=60       ✗（应为 no-cache）
current/poster.webp      → public, max-age=86400   ✗（应为 no-cache）
versions/v1/manifest.json → public, max-age=60    ✗（应为 immutable）
versions/v1/poster.webp  → public, max-age=86400   ✗（应为 immutable）
SHARE + poster.webp      → private, max-age=86400  ✗（应为 private, no-cache）
```

根因一句话：**「文件叫什么」优先于「谁在访问 + 路径可不可变」**。

## FIX

`build_cache_control()` 重排优先级（不可调换）：

```text
1. SHARE         → private, no-cache        （token 可吊销 → 永不 public/immutable/长 max-age）
2. current/*     → no-cache                 （可重指向别名 → 永不 immutable）
3. versions/<v>/* → immutable               （内容寻址不可变）
4. 顶层 manifest.json / poster.webp          （scope-aware 短 TTL，保留现有常量）
5. default       → no-cache
```

实现：SHARE 分支置于最前；`current/` 用 `startswith("current/")` 判定并置于 versions 之前；
`_VERSIONED_SEGMENT_RE`（既有 matcher，未发明第二套）之后才是 `manifest.json` / `poster.webp`
文件名特例 —— 特例不再能覆盖 scope/路径语义。

## MATRIX（§7，单测 39 项全过）

| scope | 路径 | Cache-Control |
|---|---|---|
| SHARE | 任何（manifest/poster/current/versions/其他） | `private, no-cache` |
| PUBLIC | `current/*`（含 manifest/poster/chunk） | `public, no-cache` |
| OWNER | `current/*`（含 manifest/poster/chunk） | `private, no-cache` |
| PUBLIC | `versions/<v>/*`（含 manifest/poster/chunk） | `public, max-age=31536000, immutable` |
| OWNER | `versions/<v>/*`（含 manifest/poster/chunk） | `private, max-age=31536000, immutable` |
| PUBLIC | 顶层 `manifest.json` / `poster.webp` | `public, max-age=60` / `public, max-age=86400` |
| OWNER | 顶层 `manifest.json` / `poster.webp` | `private, no-cache` / `private, max-age=86400` |
| 任意 scope | 嵌套 `*/manifest.json`、`*/poster.webp` | no-cache（**顶层特例只对顶层文件生效**，见 FIX-05C.1） |
| 其它/未知 | 任意 | scope 对应 no-cache |

## HISTORICAL BUG REGRESSION（§8，专项锁定）

`TestCachePriorityRegression` 5 项：
`current/manifest.json ≠ 60s`、`current/poster.webp ≠ 1d`、`versions/v1/manifest.json ≠ 60s`、
`versions/v1/poster.webp ≠ 1d`、`SHARE + poster.webp == private, no-cache`（无 max-age）。
以后即使有人调整 manifest/poster TTL，也不得再次破坏 current/version/share 路径语义。

## NGINX FALLBACK（§10）

`deploy/nginx/gsplatform.conf` map 修正顺序：

```text
default                        → public, no-cache
~^/.*/assets/versions/[^/]+/   → public, max-age=31536000, immutable
~^/.*/assets/current/          → public, no-cache        （新增，置于 manifest/poster 之前）
~/manifest\.json$              → public, max-age=60
~/poster\.webp$                → public, max-age=86400
```

- `current/manifest.json` / `current/poster.webp` 不再被文件名 regex 命中为 60s / 1d。
- `versions/<v>/manifest.json` / `poster.webp` 仍先命中 versions 规则 → immutable。
- Nginx 无法从 URL 推导 scope（private/share），故本 map 只镜像 PUBLIC 路径语义；
  **scope-aware 权威 Cache-Control 仍由 Backend 响应决定**（`resolved.cache_control`），
  Nginx 不再重盖（`scenes-streaming.conf` 的 `add_header` 已移除）。
- `nginx -t`（容器 harness，`<DOMAIN>→gsplatform.test`）：**syntax ok / test successful**。

## VITE（§11，不允许被破坏）

未改动 Vite：`buildDevSceneCacheControl` 的 `current/* → public, no-cache` /
`versions/<ver>/* → immutable` 语义不变；`/local-scenes` trust boundary 仍只信
`realSceneRoot`，未重新开放 `storage/published`。web 全量 227 passed 复证。

## TESTS（§16/§13，真实计数）

| 门禁 | 命令 | 结果 |
|---|---|---|
| targeted cache 矩阵 | `.venv/bin/python -m pytest tests/test_scene_cache.py -q` | **39 passed** |
| backend 全量 | `.venv/bin/python -m pytest -q` | **234 passed** |
| backend ruff | `.venv/bin/python -m ruff check .` | **All checks passed** |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| web 全量 | `pnpm vitest run` | **227 passed / 26 files** |
| web typecheck / lint / build | `pnpm typecheck` / `pnpm lint` / `pnpm build` | 0 errors / exit 0 / exit 0 |
| workers | `python -m pytest tests -q`（workers/tests） | **13 passed** |
| nginx | `/home/test/bin/nginx -t`（harness） | syntax ok / test successful |
| 仓库 | `pnpm test` / `pnpm lint` / `pnpm api:check` | 227 / exit 0 / clean |

## ENDPOINT VERIFICATION（§9）

真实 HTTP asset route（`GET /api/v1/scenes/{id}/assets/{rel}`）响应 `Cache-Control`
直接使用 `build_cache_control()` 结果（`scene_runtime.py` 的 `resolved.cache_control`）：
- PUBLIC `current/manifest.json` / `current/poster.webp` → `public, no-cache`（实测）。
- PUBLIC `versions/v1/manifest.json` / `versions/v1/poster.webp` → `public, max-age=31536000, immutable`（实测）。
- SHARE（私有场景 + `?share=` token）`current` / `versions` / `poster.webp` →
  `private, no-cache`（实测，无 public/immutable/max-age）。
- OWNER 私有 current → `private, no-cache`（既有测试保持）。

## FILES CHANGED

- `apps/api/app/services/scene_asset.py`（build_cache_control 优先级 + 注释矩阵）
- `apps/api/tests/test_scene_cache.py`（矩阵 39 项 + 5 项优先级回归 + 真实 route 用例扩展）
- `deploy/nginx/gsplatform.conf`（map 增加 `current/* → no-cache`，置于 manifest/poster 前，注释同步）
- `docs/reports/PRODUCTION_RUNTIME_ACCEPTANCE.md`（阶段 FIX-05C，测试计数全文档统一为最终真实值）
- `docs/reports/FIX_05C_CACHE_POLICY_REMEDIATION.md`（本报告，新）

未改动：Vite 中间件/trust、share 授权模型、SuperSplat/Viewer/XR/LOD、Scene DB schema。

## FIX-05C.1 SUPPLEMENT（2026-10-03，顶层特例对齐）

**Previously the implementation used the basename for manifest/poster,
which made nested `foo/manifest.json` and `foo/poster.webp` inherit
top-level TTL rules. FIX-05C.1 aligns implementation with the existing
documented contract: only exact top-level `manifest.json` and `poster.webp`
receive the filename-specific TTL.**

- Backend `build_cache_control()`：`rel_path == "manifest.json"` / `== "poster.webp"`
  精确匹配（不再 basename）；优先级 SHARE → current → versions → top-level
  manifest/poster → default **不变**，TTL 数值不变。
- Vite `buildDevSceneCacheControl()`：`segments.length === 1 && segments[0] === ...`
  精确顶层；current/versions 优先级与 trust boundary **不变**。
- Nginx fallback regex：`~^/.*/assets/manifest\.json$` / `~^/.*/assets/poster\.webp$`
  精确锚定 `/assets/` 顶层（不再匹配任意嵌套 basename）。Backend 仍为
  scope-aware 权威，Nginx 仅 fallback/文档。
- 测试：backend cache 矩阵 53 passed（新增 nested-path 回归 14）；
  vite policy 15 passed；全量 backend 248 / web 228 / workers 13。

## FINAL STATUS

```text
SuperSplat migration:   PASS
FIX-05B:                PASS
FIX-05C:                PASS
Software acceptance:    PASS
Software blockers:      NONE
Hardware acceptance:    PENDING
```

**Remaining blocker：Quest/PICO real-device acceptance only**（真机 6DoF/视差/
Enter-Exit-Reenter/热点/collision-in-XR/LOD 全量首帧复核，无硬件不可执行、不伪造）。

## NEXT STEP

Quest/PICO 真机 + 真实大场景 + LOD + XR interaction 验收（本阶段不自动开始，也不继续
软件侧审计）。
