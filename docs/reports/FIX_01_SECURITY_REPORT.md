# FIX_01_SECURITY_REPORT：GSPlatform Security & Access Control Hardening

- 日期：2026-09-29
- 阶段：FIX-01 — 迁移完成后的第一轮正确性/安全加固（非新功能）
- 前置：SSV-00 ～ SSV-10 全部完成（HEAD `a6a929e chore(viewer): complete SuperSplat runtime migration`）
- 范围：Scene 读权限链 / Runtime Descriptor / 私有资产交付 / Nginx 静态别名 / Vite 开发资产服务器 / 分享授权

---

## RESULT

**PASS** —— 20 个分节全部完成，安全修复闭环。未发现新的阻断性问题。

---

## HEAD BEFORE

- `a6a929e chore(viewer): complete SuperSplat runtime migration`（工作区干净）

---

## ROOT CAUSES（§2：修改前链路 + 已确认漏洞）

修改前的真实链路：

```text
Scene(DB) → GET /api/v1/scenes/{id}/runtime → Runtime Descriptor
  → content.url / posterUrl = /local-scenes/<slug>/<rel>
  → Nginx location /local-scenes/ { alias <scene-origin>; }    ← 未鉴权公开别名
  → 文件系统 scenes/<slug>/<rel>（current 相对符号链接 / versions/<ver>→storage）
```

四个已确认漏洞：

| 编号 | 严重级 | 描述 | 修复 |
|---|---|---|---|
| **P0-1** | 高 | Runtime Descriptor 的 content/poster URL 指向 `/local-scenes/{slug}/...`，生产 Nginx 对该前缀**公开 alias** 到 scene-origin 树 —— 私密场景的 Gaussian 字节只需猜出 slug 即可免登录下载 | §5/§15 私有资产一律走鉴权 API + Nginx internal（X-Accel-Redirect）；删除公开 alias |
| **P0-2** | 高 | Vite 开发资产服务器路径边界问题：sceneId 直接参与 `path.resolve`，containment root 由用户输入构造；`decodeURIComponent` 可多次解码；`.trycloudflare.com` 无条件放行 → dev server 可被公网 tunnel 暴露 | §8/§9/§10 slug 白名单 + 单次解码 + realpath 包含校验 + tunnel 环境变量门控 |
| **P1-1** | 中 | Runtime 匿名规则为 `PUBLIC + READY`，与平台官方公开规则 `PUBLIC + PUBLISHED`（`get_public_by_slug`）不一致 —— 未发布预览状态被匿名读取 | §3/§4 统一 SceneAccessPolicy：匿名只读 `PUBLIC + PUBLISHED + 未删除` |
| **P1-2** | 中 | Runtime/SceneDetail 使用裸 `get_by_slug/get_by_id`，**软删除场景仍对其所有者可读** | 策略层：`deleted_at IS NOT NULL` 一律 404 |

顺带发现（works hall 面，FIX-01 修复范围内）：

- `repositories/scenes.py::list_public` 分页游标直接 `json.dumps(datetime)` → 一旦公开列表超过一页即 500。已改为 `.isoformat()`（解码端本就 `fromisoformat`）。
- `publish_service._bridge_dev_scene_view` 用 `parents[3]` 定位仓库根，实际得到 `apps/`（`apps/scenes` 不存在）→ dev/test 桥接总是静默跳过。**未改**（`build_streamed_sog.sh` 已在正确位置建树；修复超出本次权限链范围），列入 KNOWN LIMITATIONS。

---

## ACCESS POLICY（§3 — 统一 SceneAccessPolicy）

新增 `apps/api/app/services/scene_access.py`：

- `SceneAccessPolicy.resolve_readable_scene(slug_or_id, identity, share_token=None)` /
  `resolve_readable_for_user(...)`：**所有读面**（works hall 详情 / Runtime Descriptor / Asset Delivery / 分享 / 碰撞）共用同一判定。
- 规则（固定，禁止在调用点重写）：
  - **OWNER**：本人所有 non-deleted Scene（任意 status/visibility，含 DRAFT/READY 预览）。
  - **ANONYMOUS**：仅 `visibility==PUBLIC AND status==PUBLISHED AND deleted_at IS NULL`。`PUBLIC+READY` 一律 401（不再是 200）。
  - **SHARE**：复用现有 `ShareLink` 机制（仅存 `token_hash`、revoke/expire 即时生效），且 scene 仍须 PUBLISHED（与 `resolve_share` 一致）。
  - **DELETED**：对 owner / anonymous / share token 一律 404（`get_public_by_slug` 同样不返回）。
- 错误语义保持项目规范：不存在/已删→404；存在但私有+匿名→401；存在但私有+登录非 owner→403。
- 已替换的旧重复实现：
  - `scene_runtime.py::_resolve_readable_scene`（原 `PUBLIC+READY` + 无 deleted 检查）
  - `authoring.py::_get_owned_scene_for_read`（原相同规则）
  - `scenes.py::resolve_detail`（原 owner 分支裸查 + 无 deleted 检查）
  - `collision.py` 读路由（原只有 deleted 检查，无 visibility/owner 判定 —— 私有碰撞字节等同公开）

## PRIVATE ASSET ARCHITECTURE（§5/§6/§7）

- 新增 `apps/api/app/services/scene_asset.py` + 路由 `GET /api/v1/scenes/{scene_id}/assets/{asset_path:path}`：
  1. `SceneAccessPolicy` 授权（含 `?share=`/`gs_share` cookie）；
  2. `asset_path` 逐段校验（拒绝 `..`/`.`/空/`%`/`\`/NUL/绝对路径）；
  3. `Path.resolve()` realpath 包含校验 —— **非字符串 `startswith`**：真实目标必须落在 `scene_root` 真实路径 **或** `<storage_root>/published` 真实路径内（`versions/<ver>` 合法符号链接指向 storage；指向 `/etc`、兄弟场景、其他位置的符号链接一律 404）；
  4. **生产**：返回 `X-Accel-Redirect: /_scene-origin/<slug>/<rel>`（FastAPI 从不读取文件正文）；**dev/test**：`FileResponse`（Starlette 原生 Range）。
- Descriptor 内容 URL 改为授权端点：`SCENE_ASSET_BASE = /api/v1/scenes/{slug}/assets`；`_content_url` 同时把历史 manifest 中遗留的绝对 `/local-scenes/<slug>/...` 引用重写为授权端点 —— 描述符永不发射未鉴权 URL。
- 公有场景同样走同一鉴权 API 路径（无任何公开静态别名；`PUBLIC+PUBLISHED` 匿名放行）。
- §7：Range 通过 `curl -I`/`curl -H "Range: bytes=0-1023"` 验证（见 RANGE TEST），生产由 Nginx core 处理 206/416，FastAPI 全程零文件正文读取。

## NGINX CHANGES（§15）

`deploy/nginx/gsplatform.conf`：

- **删除** `location /local-scenes/ { alias ...; }`（公开别名）。
- **新增** `location /_scene-origin/ { internal; alias /srv/gsplatform-data/scene-origin/; include .../scenes-streaming.conf; }` —— `internal` 意味着客户端直连 `/_scene-origin/...` 得 404，只有 FastAPI 鉴权后的 X-Accel-Redirect 可达。
- 保留 `Permissions-Policy`、`scenes-streaming.conf` 的 Range/Cache/CORS（map `$scene_cache_control` 不变：manifest 60s / poster 1d / versioned immutable）。
- `deploy/scripts/smoke_test.sh` 的 manifest/Range 探测改走授权 API 路径；`DEPLOYMENT_RUNBOOK.md` 拓扑与验证命令同步更新；`CAPACITY_PLAN.md` 的 CDN/监控引用更新为授权资产 API。
- 注意：`GS_SCENE_ORIGIN_ROOT`（API 侧）与 nginx `alias` 根必须指向同一棵树（部署 runbook 约束，见 KNOWN LIMITATIONS）。

## VITE TRAVERSAL FIX（§8/§9/§11）

`apps/web/vite.config.ts`（`gs-serve-streamed-scenes`，**DEV ONLY**）：

1. sceneId 白名单 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`（与后端 slug 规则一致）；不合法 → 403。
2. 路径组件**仅解码一次**；解码后仍含 `%`（双重编码）、`/`（编码斜杠）、`\`、NUL、`.`/`..`/空 → 400。
3. 包含校验用 `fs.realpathSync`：scene 目录真实路径 + 目标真实路径，组件级 `path.relative` 判定（绝不 `startsWith`），信任根 = 真实 scene 根 ∪ 真实 `<GS_STORAGE_ROOT>/published`（`versions/<ver>` 合法指向 storage）。
4. 失败一律拒绝（403 越界 / 404 不存在），不再 `next()` 落入 SPA 回退返回 200。
5. 注释明确 DEV ONLY：生产 build/Nginx 不依赖该中间件。

## DEV TUNNEL POLICY（§10）

- 删除无条件 `allowedHosts: ['.trycloudflare.com']`。
- 改为环境变量门控：`GS_ENABLE_DEV_TUNNEL=1` 才允许 `['.trycloudflare.com']`，默认关闭；永不用 `allowedHosts: true`。生产（Nginx + 真实域名）与此开关无关。

## AUTH MATRIX（§13 — 统一策略，实测）

| 调用方 | Scene 状态 | Runtime | Scene Detail |
|---|---|---|---|
| Owner | 任意 non-deleted（DRAFT/READY/PRIVATE/PUBLIC） | ✅ 200 | ✅ 200 |
| Anonymous | PUBLIC + PUBLISHED | ✅ 200 | ✅ 200 |
| Anonymous | PUBLIC + **READY** | ❌ 401（旧 200） | ❌ 401 |
| Anonymous | PRIVATE + PUBLISHED | ❌ 401 | ❌ 401 |
| Anonymous | UNLISTED + PUBLISHED | ❌ 401 | ❌ 401 |
| Other user | PRIVATE + PUBLISHED | ❌ 403 | ❌ 403 |
| Anonymous/Other | UNLISTED + PUBLISHED | ❌ 403/401 | — |
| Owner | **deleted** | ❌ 404（旧 200） | ❌ 404 |
| Anonymous | deleted PUBLIC | ❌ 404 | ❌ 404 |
| 任何人 | 不存在 | ❌ 404 | ❌ 404 |
| Share token（未过期/未撤销，PUBLISHED） | PRIVATE 等 | ✅ 200 | — |
| Share token 过期/已撤销 | PRIVATE | ❌ 401 | — |

## ASSET MATRIX（§14 — 授权资产端点，实测）

| 调用方 | Scene 状态 | Asset |
|---|---|---|
| Anonymous | PRIVATE | ❌ 401 |
| Owner | PRIVATE | ✅ 200 |
| Anonymous | PUBLIC + PUBLISHED | ✅ 200 |
| Anonymous | PUBLIC + **READY** | ❌ 401 |
| Owner/Anonymous | **deleted** | ❌ 404 |
| Owner | 合法文件缺失 | ❌ 404 |
| 穿越 `../`、`%2e%2e%2f`、`..%2f`、编码斜杠、绝对路径、反斜杠、`%00`、双重编码、非法 slug、符号链接越界 | 任意 | ❌ 404 / 400 / 403 |
| Share token | PRIVATE | ✅ 200 |

## RANGE TEST（§7 — curl 实测）

dev（FileResponse，语义与生产 nginx 一致）—— 真实场景 `r-8c4e2264e86a`（PRIVATE+PUBLISHED，owner=dev，磁盘含真实 LOD）：

```text
Range: bytes=0-99    → 206  Content-Range: bytes 0-99/476  Accept-Ranges: bytes
                      Cache-Control: public, max-age=31536000, immutable
Range: bytes=0-9（share） → 206  Content-Range: bytes 0-9/476
Range: bytes=99999999999- → 416
HEAD/无 Range → 200 全量（Accept-Ranges 广告）
```

匿名公开场景（PUBLIC+PUBLISHED）manifest：`Range: bytes=0-99 → 206`，`Cache-Control: max-age=60`；越界 → 416。

## AUTOMATED TESTS（§12/§14/§13 — 新增）

- `apps/api/tests/test_scene_access.py`（32 项）：owner/匿名/其他用户/公共READY/删除/UNLISTED/缺失 全矩阵（HTTP 级 + 策略服务级）；Share 授权：`?share=` 匿名 200、cookie `gs_share` 设值 + HttpOnly + 后续请求放行、过期/撤销 401。
- `apps/api/tests/test_scene_assets.py`（15 项）：私有/公有/删除/缺失资产权限；Range 206/416/全量 Accept-Ranges；穿越矩阵（`..`、`..%2f`、`%2e%2e%2f`、`%2E%2E%2f`、`%252e%252e`、反斜杠、`%00`、非法 slug、symlink 越界→`/etc`、兄弟场景）；合法 `current -> versions/<ver>` 符号链接链放行。
- 真实 HTTP（vite 开发服务器）穿越矩阵：合法 200、Range 206、`..%2f`/编码斜杠/反斜杠/NUL/双重编码 400、`%2e%2e%2f`/非法 sceneId 403、缺失/未知 scene 404；**原始 `..` 经裸 socket 发送**（curl 会客户端归一化）→ 403/400。

门禁（全部真实执行）：

| 门禁 | 结果 |
|---|---|
| backend pytest | **178 passed**（原 132 + 新增 47） |
| backend ruff | All checks passed |
| backend mypy | Success: no issues（83 source files） |
| `pnpm --filter @gsplatform/web test` | **145 passed / 18 files** |
| `pnpm lint` | exit 0（1 个既有 warning：CollisionPanel 未用 catch 参数，HEAD 同源） |
| `pnpm typecheck` | exit 0 / 0 errors |
| `pnpm build` | exit 0（含新 vite.config.ts） |

## REAL REQUEST TESTS（§18 — 双实例真实 HTTP）

- **匿名实例**（`GS_DEV_IDENTITY_ENABLED=false`，port 8002）：私有 runtime 401、私有 asset 401、公有+PUBLISHED runtime 200 / asset 200 / Range 206 / 416、公有+READY runtime 401、deleted runtime/asset 404、works hall 列表 200。
- **开发实例**（bypass ON，port 8001，重启载入新代码）：owner 私有 runtime 200、owner 私有 asset 200（真实 `versions/<ver>` 符号链接链）、Range 206/416、穿越 404、descriptor 只发射 `/api/v1/scenes/{slug}/assets/...`（posterUrl + content.url，零 `/local-scenes`）。
- **分享真实流**：匿名无 token 401 → `?share=` 200 → asset+Range 206 → `/shares/resolve` 设 `gs_share`（HttpOnly, SameSite=lax）→ cookie 放行 runtime 200 → **撤销后立即 401**。
- 临时公开探针场景（PUBLIC+PUBLISHED + 磁盘内容）验证后已删除并清理。

## KNOWN LIMITATIONS

- `publish_service._bridge_dev_scene_view` 的 `parents[3]` 仓库根定位偏差（得 `apps/scenes`，实际不存在 → dev/test 桥接静默跳过）为**既有问题**，FIX-01 未修复（不影响发布：`build_streamed_sog.sh` 在正确位置建树；修复属后续代码卫生轮）。
- 生产 Nginx `nginx -t` 在本环境不可用（`/home/test/bin/nginx` 是 docker-entrypoint 包装器）；nginx 改动经配置审查 + dev origin 语义等价 curl 取证，真实域名部署时由 runbook 执行 `nginx -t`。
- `GS_SCENE_ORIGIN_ROOT`（API）与 nginx `/_scene-origin/` 的 `alias` 根必须指向同一棵树（已写入 runbook）。
- API 测试套件一直直接写 dev 数据库（既有设计，`db` fixture 提交保留），新增测试行（`fix13-*`/`apub-*` 等）与此一致，非回归。
- 分享 cookie `gs_share` 为 HttpOnly + SameSite=lax + Path=/，revoke/expire 即时生效（每次读取重校验）；真实浏览器跨 tab/会话行为待真机验收。
- Windows Chrome / Quest/PICO 真机与真实域名 HTTPS 站点未在本环境执行（同 SSV-10，部署 runbook 项）。

## FILES CHANGED

新增：`app/services/scene_access.py`、`app/services/scene_asset.py`、`tests/test_scene_access.py`、`tests/test_scene_assets.py`

修改：`app/api/v1/scene_runtime.py`（+assets 路由、share 授权）、`app/api/v1/collision.py`（读面统一策略）、`app/api/v1/shares.py`（resolve 设 `gs_share` cookie）、`app/core/config.py`（`share_cookie_name` + 注释）、`app/repositories/scenes.py`（游标 datetime→isoformat 修复）、`app/schemas/scene_runtime.py`、`app/services/scene_runtime.py`、`app/services/scenes.py`、`app/services/authoring.py`、`app/services/publish_service.py`（注释）、`tests/test_scene_runtime.py`、`apps/web/vite.config.ts`、`deploy/nginx/gsplatform.conf`、`deploy/nginx/scenes-streaming.conf`、`deploy/scripts/smoke_test.sh`、`docs/operations/DEPLOYMENT_RUNBOOK.md`、`docs/operations/CAPACITY_PLAN.md`

未改（§16 范围外）：官方 supersplat-viewer、Experience Settings、Annotation、World Transform、XR UI、Panorama、Audio、Collision 物理、LOD 逻辑。

## NEXT PHASE

- FIX-02 等后续加固轮（未开始，§20 后停止）。
- 部署 runbook 项：真实域名 + `nginx -t` + 真机 Quest/PICO 复测分享 cookie 与私有资产访问。
