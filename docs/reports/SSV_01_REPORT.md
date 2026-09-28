# SSV_01_REPORT：Unified Scene Runtime Contract

- 日期：2026-09-28
- 阶段：SSV-01 — Runtime Contract
- 前置：`docs/reports/SSV_00_REPORT.md` RESULT = PASS ✓
- 分支：`main`

---

## RESULT

**PASS**

- 后端新增 `GET /api/v1/scenes/{scene_id}/runtime`，返回正式 Pydantic schema `SceneRuntimeDescriptorV1`（schemaVersion=1）。
- 全部块（scene / content / presentation / viewpoints / annotations / backgroundAudio / collision）来自**现有数据库模型**，未为 DTO 新增任何数据库字段。
- 后端测试 19 项全过（含 SSV-00 基线内全部既有测试：全仓后端 **116 passed**）。
- 前端 `getSceneRuntime()` 解析测试 10 项全过（web 全量 **143 passed**，原 133 + 新 10）。
- 实际启动 API 并对真实场景 curl 验证（见下）。
- 未创建 Viewer、未迁移 Desktop / XR —— 只做合同和数据。

## REAL SCENE USED

`r-8c4e2264e86a`（title `Phase07 E2E photos`）

- 真实存在于数据库：`status=PUBLISHED, visibility=PRIVATE, owner=dev@gsplatform.local`（dev identity 调用方即 owner → 200）。
- `current_version`：`streamed-sog` / `asset_version=b2cc7bb1594d`，version.manifest 含 `stream.entryUrl`。
- 内容文件真实存在于磁盘（dev bridge：`scenes/r-8c4e2264e86a/current → versions/b2cc7bb1594d → published storage`）。

## ENDPOINT

```
GET /api/v1/scenes/{scene_id}/runtime
```

- `scene_id` 复用现有业务标识（slug，兼容内部 UUID），与 `/scene/:slug` 前端路由一致。
- 注册于 `apps/api/app/api/v1/router.py`（`/scenes` prefix，tags: Scene Runtime）。
- 返回：`SceneRuntimeDescriptorV1`（FastAPI response_model）。

## RESPONSE EXAMPLE

`curl http://127.0.0.1:8001/api/v1/scenes/r-8c4e2264e86a/runtime`（HTTP 200，节选）：

```json
{
  "schemaVersion": 1,
  "scene": {
    "id": "r-8c4e2264e86a",
    "name": "Phase07 E2E photos",
    "posterUrl": "/local-scenes/r-8c4e2264e86a/poster.webp"
  },
  "content": {
    "url": "/local-scenes/r-8c4e2264e86a/versions/b2cc7bb1594d/lod-meta.json",
    "format": "lod-meta"
  },
  "presentation": {
    "worldTransform": { "position": null, "rotation": null, "scale": null },
    "initialCamera": { "position": null, "target": null, "fov": null },
    "background": { "type": "color", "color": null, "url": null }
  },
  "viewpoints": [],
  "annotations": [],
  "backgroundAudio": null,
  "collision": null
}
```

## CONTENT URL

- 规则：同源 URL（`/local-scenes/...`、`/api/...`、`https://...`）—— 绝不返回服务器本地绝对路径。
- streamed-sog：`manifest.stream.entryUrl`（scene-root 相对）前缀 `/local-scenes/{slug}/`，无 entryUrl 时回退 `/local-scenes/{slug}/current/lod-meta.json`。
- 单文件：manifest `assetUrl`（绝对 URL 原样；相对 `./`/`../` 归一化）→ SOG 资产 storage_key 文件名 → 格式默认名。
- **端到端验证**：`http://127.0.0.1:5173/local-scenes/r-8c4e2264e86a/versions/b2cc7bb1594d/lod-meta.json` → Vite dev 中间件 **HTTP 200**，返回真实 lod-meta 内容（splat-transform v3.3.3，count 2503）。

## FORMAT

- 由**实际资产文件名 / 元数据**判定，绝不依据 `schemaVersion`。
- 映射（`content_format_from_filename`）：`.lod-meta.json` → `lod-meta`；`.meta.json` → `meta`；`.compressed.ply` → `compressed-ply`；`.sog` → `sog`；`.ply` → `ply`。
- streamed-sog 版本 → `lod-meta`（StreamedSogLoader 的入口容器）；单文件 → 按扩展名。

## AUTH BEHAVIOR

| 场景 | 调用方 | 结果 | 实测 |
|---|---|---|---|
| PRIVATE + owner | owner | 200 | `r-8c4e2264e86a` → HTTP 200 ✓ |
| PRIVATE + other | 已登录他人 | 403 | `scene-dee5605a` → HTTP 403 FORBIDDEN ✓ |
| PRIVATE + 未登录 | 匿名 | 401（需要登录） | 服务层单测（HTTP dev bypass 恒为 dev 身份，401 在 `identity=None` 边界验证）✓ |
| PUBLIC + PUBLISHED/READY | 任意 | 200 | `scene-73457f10` → HTTP 200 ✓ |
| 不存在 | 任意 | 404 | `no-such-scene-xyz` → HTTP 404 NOT_FOUND ✓ |

- XR 页面：`/runtime` 走标准 API 调用（cookie/CSRF 自动带上）；私密场景 401 → 登录门禁（http.ts 非 `/xr/*` 才跳登录），无 redirect loop。前端 `getSceneRuntime` 将 404/401/403/网络 分类为可恢复 `RuntimeApiError(kind)`，页面可据 `kind` 分派 UI。
- 为让 `collision.url` / `backgroundAudio.url` 成为真实可访问 URL，新增两个**最小 serve 端点**（复用既有 `serve_background_audio` 模式，无 DB 字段变更，非 Viewer 功能）：
  - `GET /api/v1/scenes/{slug}/collision/mesh`（collision GLB）
  - `GET /api/v1/scenes/{slug}/presentation/background-audio`（已存在，直接引用）

## TESTS

**Backend**（`apps/api/tests/test_scene_runtime.py`，19 项）：

1. existing scene → 200 ✓
2. not found → 404 ✓
3. SOG format ✓
4. PLY format（相对 assetUrl 归一化）✓
5. lod-meta format（streamed entryUrl；schemaVersion=1 不影响判定）✓
6. presentation serialization（transform/camera/background，含 panorama url）✓
7. annotations serialization（anchor/style/contentType/order）✓
8. collision null ✓
9. collision populated（url/format=glb/mode/params/enabled）✓
10. authorization（public 200 / private owner 200 / private other 403 / anon 401 / unlisted 403 / no-version 场景 content null）✓

执行结果：
- `pytest tests/test_scene_runtime.py` → **19 passed**
- 全仓后端 `pytest -q` → **116 passed**
- `ruff check`（改动的 7 个文件）→ **All checks passed**
- `mypy app`（改动的 5 个 app 文件）→ **Success: no issues**

**Frontend**（`apps/web/src/__tests__/scene-runtime.test.ts`，10 项）：

- URL 组装与 sceneId 编码（`/scenes/{sceneId}/runtime`、`%20`/`%2F`）
- 合法描述解析（完整 fixture + 空白 null/[] fixture）
- 失败分类：404→SCENE_NOT_FOUND、401→UNAUTHORIZED、403→FORBIDDEN、500/网络→NETWORK、schemaVersion≠1→PARSE、缺字段→PARSE

执行结果：
- `pnpm --filter @gsplatform/web test scene-runtime` → **10 passed**
- web 全量 → **143 passed**（基线 133 + 新 10）
- `lint` → 0 error（仅预存在 authoring warning；本阶段未新增）
- `typecheck` → **13 error，与 SSV-00 基线一致**，新文件 0 error

## FILES CHANGED

**Backend**
- `apps/api/app/schemas/scene_runtime.py` — **新增**：`SceneRuntimeDescriptorV1` + 各块 schema
- `apps/api/app/services/scene_runtime.py` — **新增**：`SceneRuntimeService`（访问控制 / content 解析 / 各块组装）+ `content_format_from_filename`
- `apps/api/app/api/v1/scene_runtime.py` — **新增**：`GET /{scene_id}/runtime` 路由
- `apps/api/app/api/v1/router.py` — 注册 `scene_runtime.router`（`/scenes` prefix）
- `apps/api/app/services/collision.py` — `serve_collision_mesh()`（供 `collision.url` 真实可访问）
- `apps/api/app/api/v1/collision.py` — `GET /{slug}/collision/mesh` 路由
- `apps/api/tests/test_scene_runtime.py` — **新增**：19 项测试

**Frontend**
- `apps/web/src/scene-runtime/types.ts` — **新增**：`SceneRuntimeDescriptorV1` 全类型
- `apps/web/src/scene-runtime/runtimeApi.ts` — **新增**：`getSceneRuntime(sceneId)` + `RuntimeApiError(kind)`
- `apps/web/src/scene-runtime/__fixtures__/descriptor.ts` — **新增**：完整 / 空白 descriptor fixture
- `apps/web/src/__tests__/scene-runtime.test.ts` — **新增**：10 项测试

**未改动**：任何 Viewer 文件、任何数据库 migration / 模型字段。

## NEXT PHASE

**SSV-02 — Official Runtime Wrapper**：把 `apps/web/src/xr/XRViewerRuntime.ts` 泛化为 Desktop+XR 共用 wrapper（以 `getSceneRuntime()` 为数据入口）。

顺序见 `docs/SSV_MIGRATION_PLAN.md`。禁止跳过 / 乱序。
