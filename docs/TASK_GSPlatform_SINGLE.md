# 任务：基于 PlayCanvas SuperSplat 构建 3D 高斯溅射 Web 平台（GSPlatform）

> 本任务书为唯一任务输入。你将以 GitHub 开源项目 `playcanvas/supersplat` 为基础，从零构建可运行、可验收的 3D Gaussian Splatting（3DGS）内容平台 GSPlatform，并完成全部验收。

## 一、任务背景

3DGS 自 2023 年 SIGGRAPH 提出以来已成为高质量实时三维重建的主流表示（数百万高斯椭球，实时 30–60fps），但生态长期停留在"重建出 .ply 即结束"的单向管线，缺少浏览、管理、上传、重建、分享与发布平台层。PlayCanvas 开源的 **SuperSplat**（https://github.com/playcanvas/supersplat，MIT，TypeScript，PlayCanvas Engine + WebGL/WebGPU）是浏览器端 3DGS 编辑器/查看器，支持 PLY 编辑、SOG 与 Streamed SOG，可作为 Viewer 内核，但不是面向最终用户的平台产品。

**任务要求**：以 supersplat 为 Viewer 内核，构建完整 3DGS Web 平台 GSPlatform——用户可浏览公开场景、管理作品、上传已有 3DGS 场景、提交"视频/照片 → 3DGS"免费重建任务，并在全屏 Viewer 中真实渐进加载（低 LOD → 高质量高斯）查看，支持收藏、分享、详情与"问 AI"。

## 二、目标与总体交付

单仓库（monorepo），三个可独立启动/测试/构建的应用：apps/web（React+TS+Vite+AntD+Router+Zustand+Axios，5173，五个核心页面）、apps/viewer（SuperSplat fork + PlayCanvas Engine，5174，真实 SOG/Streamed SOG 渲染）、apps/api（Python3.11+FastAPI+Pydantic v2+SQLAlchemy 2.x+Alembic，8000，REST/持久化/任务编排）。配套 PostgreSQL、Redis+Celery（异步处理/重建，CPU/GPU 分队列）、Nginx（开发与生产）、Ubuntu 部署与 Runbook。

### 两条端到端主路径（最终必须真实跑通）
```text
主路径 A（浏览）：首页(5列SceneCard) → 打开作品 → Poster+真实0~100%进度 → 低LOD可交互
  → Streamed SOG 按需细化 → 收藏/分享/详情/问AI
主路径 B（创作）：登录 → 上传已有场景或提交免费重建 → API 创建记录
  → Celery 校验/转换/重建 → 原子发布新版本 → 我的作品可见 → 全屏 Viewer 真实加载验证
```

## 三、基础、环境与固定技术约束

### 3.1 基础代码
- 创建 supersplat 自有 fork 引入 apps/viewer（subtree 或独立仓库构建；源码入 monorepo 须清除嵌套 .git）。apps/viewer/UPSTREAM.md 记录上游 URL、fork URL、基线 commit、同步方法；保留 MIT 许可证并在根目录第三方声明登记。
- 禁止重写 Gaussian renderer 或绕开 SuperSplat Viewer / PlayCanvas Engine。

### 3.2 环境
Git、Node LTS、pnpm、Python 3.11、PostgreSQL、Redis。GPU/COLMAP/gsplat/splat-transform 等重型工具在阶段 07 按"能力检查+尽环境所能真实运行"使用。端口经环境变量可覆盖；浏览器环境变量只用 VITE_ 前缀且不含服务端秘密。技术栈固定不可替换。

### 3.3 工程底线（全程适用，违者判 FAIL）
- 真实性：一切进度/渲染/性能数字必须来自真实事件（网络字节、解码、首帧、迭代、工具输出）；禁止定时器/CSS动画/硬编码/预录日志冒充进度与渲染；禁止 Poster、录屏或 Canvas 动画冒充真实 3D。
- 诚实性：Checklist 只在真实运行与验证成功后勾 [x]；失败/无法验证保持 [ ] 并写 Known Issues。
- 安全：不提交 .env/密钥/令牌/大场景/构建产物/依赖缓存；不自动 push；用户输入不直接作服务端路径或 shell 字符串。
- 每阶段：实现 → 真实运行验证 → docs/reports/PHASE_XX_REPORT.md → git status/diff --stat/diff 自检 → 独立 commit（不 push）。

## 四、执行流程（十阶段，逐阶段门禁）

每阶段以上一阶段 Report 为 PASS 作进入门禁；不满足即停止报告。验收均须满足：命令/页面/网络/性能记录可复验、lint/typecheck/test/build 全过、报告含 Known Issues、独立 commit 不 push。

### 阶段 00 · 项目骨架与工程约束
目录 apps/web、apps/viewer、apps/api、workers、scenes、scripts、deploy/nginx、tests、docs/reports、docs/decisions；根 README/.gitignore/.editorconfig/.env.example/package.json/pnpm-workspace.yaml+锁文件。Web：Vite+React+TS 接入 AntD/Router/Zustand/Axios，TS/ESLint/测试脚本，/health-ui 显示构建信息。Viewer：fork+UPSTREAM.md+许可证登记，独立包名、5174 端口、构建命令，启动页可访问。API：Python3.11 venv+锁定依赖，FastAPI+Uvicorn+Pydantic v2+SQLAlchemy 2.x+Alembic，GET /health/live 返回 200 稳定 JSON（只表进程存活），OpenAPI /docs 可打开。根脚本覆盖 Web/Viewer 的 dev/lint/typecheck/test/build 与 API 检查。验收：三服务同时运行≥3 分钟互不占端口，控制台无未处理错误，pnpm install --frozen-lockfile 成功，Git 无密钥/大文件/缓存/阶段外改动。

### 阶段 01 · 平台前端 UI 与路由
项目自有设计 Token 经 ConfigProvider 应用，不复制第三方品牌/Logo/文案。固定 Sidebar（桌面 224px 不随内容滚动）+Topbar+移动端抽屉导航；全局 loading/empty/error/403/404+错误边界。路由 /、/works、/compute、/upload、/scene/:sceneId、404。主页：顶部分类+搜索（键盘可提交、清空可操作）；桌面 1600px 严格 5 列 SceneCard（Poster/标题/作者/统计，整卡与内部按钮不冲突），窄屏降 3/2/1 列不溢出。我的作品：状态 Tabs（草稿/处理中/已发布/失败）、搜索/排序/上传入口；未接后端操作明确禁用并说明；删除需二次确认。免费计算：三步流程表单状态；文件选择显示名称/数量/前端校验；权利确认未选中提交不可用；未接后端时提交明确不可用。上传作品：标题/简介/场景文件/Poster/分类/可见性；错误与字段关联；本地草稿明确"未保存到服务端"；发布按钮在阶段 06 前禁用；object URL 替换/卸载时释放。Viewer 外壳：/scene/:sceneId 无 Sidebar 全屏；右侧顺序 作者/收藏/分享/问AI/详情，底部 Reset/Orbit-Fly/Performance/Quality/Help；未实现按钮 disabled 或说明面板。验收：五页面+404 可访问/刷新/前进后退，关键交互可键盘完成，360/768/1280/1600 无横向溢出，src/fixtures 与生产 API 适配层隔离并标记。

### 阶段 02 · Scene Viewer 基础集成
apps/viewer 导出类型化 Viewer API：createViewer/loadScene/resetCamera/setCameraMode/resize/getStats/destroy；Web 只依赖适配层；加载用受控 DTO；失败返回结构化错误（SCENE_NOT_FOUND/ASSET_FETCH_FAILED/ASSET_INVALID/GRAPHICS_UNSUPPORTED/VIEWER_INIT_FAILED/CONTEXT_LOST）。真实 SOG 测试场景（来源/许可证/体积/SHA-256 有记录）放 Git 忽略目录或独立静态服务；/scene/:sceneId 解析 manifest 取真实资产 URL。相机：Orbit 旋转/缩放/平移；Fly 键盘+指针并显示模式；Reset 恢复初始相机或自动取景；near/far/FOV/速度适配场景；焦点在表单时 Viewer 不劫持按键；Help 列出控制。页面：Canvas 填满挂载区且 Resize 正确；全屏进出可用失败有提示；Performance 显示真实 FPS/splat/frame time；分享用平台 URL 不含本地路径与令牌。生命周期：切换 sceneId 取消旧请求并销毁旧场景；离开路由移除监听/ResizeObserver/动画循环并释放 GPU 资源；10 次进入/退出无持续增长；WebGL 上下文丢失显示可恢复错误；首帧时间/稳定 FPS/峰值内存写报告基线。验收：真实 SOG 首帧可辨识；Orbit/Fly/Reset/Resize/Fullscreen 可操作；Performance 实时非固定值；404/损坏资产明确错误并可返回/重试；10 次挂载卸载无泄漏；测试资产来源合法且不进 Git。

### 阶段 03 · 真实渐进加载与加载页面
从同一真实源场景生成 low/medium/high 三档（同一坐标系/单位/朝向/裁剪/颜色）；manifest 记录 URL/字节/SHA-256/splat 数/质量+Poster 尺寸/占位色/初始相机；转换脚本可重复、清单确定；Git 只提交脚本与元数据。状态机 PREPARING/FETCHING_LOW/DECODING_LOW/INTERACTIVE_LOW/STREAMING_HIGH/READY/ERROR/CANCELLED，转换由 fetch/字节/解码/应用/首帧事件触发。进度：有 Content-Length 按真实已读字节；无长度显示不确定进度；下载/解码/首帧/高质量用文档化权重且仅在真实事件完成时结算；只有 high 首帧后显示 100%；百分比单调不倒退。Poster：模糊背景覆盖挂载区正确比例；失败用项目自有背景不阻断加载；低 LOD 首帧后短暂淡出；不接管输入；prefers-reduced-motion 下禁非必要过渡。低→高：low 优先，首帧后立即开放 Orbit/Fly；medium/high 后台真实加载逐级应用；替换保持相机/模式/输入连续，无坐标跳变/闪黑/长期叠加；失败保留最后成功 LOD 可单独重试；Quality 显示当前与加载中等级。弱网（限速）、low 404、medium/high 失败、未知 Content-Length、快速切换场景均有真实验证；状态机/进度/取消有单元测试；三档资产有浏览器 E2E 或可重复 smoke test。验收：可测量"先低 LOD 点云状可交互→逐级高质量"；100% 只在 high 首帧后；无长度不出现伪百分比；high 失败不破坏 low/medium 且可重试；切换/取消无旧事件/旧请求/GPU 泄漏。

### 阶段 04 · Streamed SOG、LOD 与网络分片
格式确认：执行锁定版本 splat-transform --help、阅读 fork 真实加载入口，以锁定版本帮助/源码/测试为准，不猜参数、不发明不兼容格式；ADR 记录格式/传输/兼容范围/回退；项目 manifest 只包装业务元数据。build_streamed_sog.sh（锁定版本、失败非零退出、临时目录校验后原子改名、生成 manifest/索引/分片/Poster/checksums/build-info）与 verify_streamed_sog.sh（缺片/长度/哈希/索引边界/路径安全）；同参数两次构建一致。Stream scheduler：按可见性/屏幕贡献/相机距离/当前 LOD 排序；低 LOD/根优先；相机快速移动取消或降权过时请求；并发/在途字节/解码队列/GPU 上传有上限；AbortSignal；临时错误有上限指数退避+抖动；404/校验/格式失败不无限重试。LOD 选择：自动结合屏幕贡献/视锥/FPS/frame time/内存预算；省流/自动/高质量三模式真实请求量可测差异并在 UI 显示；阈值加迟滞；静止后近处逐步达目标；远离/不可见可降级回收。缓存内存：网络响应进有上限 CPU LRU；解码/GPU 资源分预算淘汰；缓存 key 含资产版本/内容哈希；同分片请求去重；路由离开正确失效；长时浏览无 JS heap/GPU 无界增长；内存压力优先保低 LOD 可交互。HTTP/Nginx：支持真实 Range 返回 206/Content-Range/Content-Length，无效 Range 返回 416；manifest 短缓存或版本化 URL，不可变分片内容哈希+长期 immutable；CORS 限配置来源；压缩不破坏 Range 与二进制；MIME 稳定。进度/观测：总进度基于 manifest 目标工作量与真实接收/解码/应用事件；区分"初始就绪"与"后台细化"；100%=初始视图目标集合全部应用；Performance 显示请求数/缓存命中/吞吐/解码队列/驻留 splat/FPS；日志含 session/asset version/chunk/range/错误码，生产默认不输出高频逐帧日志。验收：网络记录证明按需分片/Range 而非先下载完整文件；冷缓存下 low 优先可交互近处随后细化；快速移动可见过时请求取消与缓存命中；三模式可测差异；206/416 正确；断网/缺片/坏哈希保留可用 LOD 可重试；small/medium/large 冷热缓存实测；连续浏览 15 分钟无无界内存增长。

### 阶段 05 · FastAPI、PostgreSQL 与持久化数据模型
模型 User/Scene/SceneVersion/Asset/Job/UploadSession；UUID 主键、UTC 时间；slug/状态/可见性/owner 约束；SceneVersion 不可变 asset version+唯一约束；Asset 记 kind/storage key/byte size/MIME/SHA-256；Job 状态/进度 0~100/attempt/Celery task ID 约束索引；软删除不出现默认公共查询；关键查询建索引。Alembic：从应用 metadata 读模型；首个显式迁移人工审阅升级/降级；空库 upgrade head、downgrade base 后再次 upgrade head 成功；CI 检查缺迁移。DTO/错误：列表/详情/命令独立 DTO；响应不暴露 storage key/内部错误/秘密；分页/排序/分类/状态强校验；错误含 code/message/requestId；422/404/409/401/403/500 语义稳定；OpenAPI 含主要响应与错误示例。API：GET /api/v1/scenes（仅可见已发布，游标分页限 limit）；GET /api/v1/scenes/{id} 区分不存在/无权限/可见；GET /api/v1/me/scenes 经身份依赖；GET /api/v1/jobs/{id} 仅所有者；/health/live 不依赖 DB；/health/ready 真实探测 PostgreSQL 失败非 200；响应返回 manifest 业务 URL 不泄露服务器路径。身份边界：可替换 get_current_user 与 RequestIdentity；覆盖未认证/无权限/所有者测试；开发身份注入仅显式 development 且默认关、production 拒绝；日志只记 user ID。分层 router/service/repository/model/schema；路由不直接 commit，事务在服务层；列表无 N+1（日志/分析证明）；并发更新返回 409。测试：repository 用真实 PostgreSQL（事务/隔离 schema），SQLite 不得作验收证据；API 覆盖正常/校验失败/404/409/401/403；约束/外键/软删除/回滚；测试独立库并清理。Web：Axios DTO 读取真实 API，首页/我的作品生产数据路径不再依赖 fixture。验收：空库 base→head→base→head 往返成功；live/ready 语义正确；公开/私有/软删除隔离；owner 只能读自己的 works/jobs；production 无法启用开发身份旁路。

### 阶段 06 · 安全上传、校验与原子发布
存储抽象：Storage 接口（暂存/范围读/原子发布/删除/存在性/校验和）；LocalDiskStorage 所有 key 服务端生成；staging/published/quarantine 不位于 Web 源码或公开根；路径解析后验证在配置根内；禁符号链接逃逸；最小权限；磁盘不足提前拒绝。上传 API：POST /api/v1/uploads（身份/配额/声明大小/格式，返回 uploadId/服务端 offset/chunk 上限/过期，不返回绝对路径）；HEAD 返回所有者可见真实 offset/status；PATCH 按 offset 写，offset 不一致返回 409+真实 offset；chunk 上限/超时/锁/校验；POST complete 仅总长与摘要符合时入队；DELETE 取消并清理；过期由真实周期任务清理。验证：扩展名/声明 MIME/魔数一致；实际字节数与声明；SHA-256 计算保存支持客户端比对；锁定版本工具解析 SOG，失败即隔离；归档（如接受）限条目/大小/压缩比/路径；Poster 限格式/尺寸/像素并重解码编码；日志不含文件内容/用户路径。Celery：Redis 连接不写仓库；task 以 DB job ID 关联；阶段 VALIDATING/CONVERTING/VERIFYING/PUBLISHING/SUCCEEDED/FAILED；进度来自真实字节/阶段/校验；重复投递幂等；外部命令 argv+固定路径+超时+资源限制；stdout/stderr 限长受限，DB 只存安全摘要；失败保留诊断并按策略清理。原子发布：转换先写临时版本目录，校验全部资产/哈希/manifest；发布目录用 scene ID+content/version hash；同文件系统原子 rename 后才允许 DB 指向新版本；DB 事务创建 SceneVersion/Assets 并更新 currentVersion；DB 失败不暴露孤立版本、文件失败不提交 DB 状态；旧版本不被覆盖可回滚；公开路径只读 PUBLISHED/有权限；Nginx 不暴露 staging/quarantine。Web：真实会话 API；显示真实字节/总/速度/offset/错误；暂停/刷新续传/取消；完成后显示服务端真实 job 阶段；轮询/SSE 断连可重连不误判失败；成功跳"我的作品"可开真实 Viewer。测试：未认证/跨用户/超配额/错误 offset/超大 chunk；伪扩展/错误魔数/截断 SOG/坏摘要/恶意归档；断点续传/重复 complete/重复投递/取消；磁盘不足/转换失败/DB 失败/发布回滚；用一个真实场景完成 上传→Celery→published→我的作品→Viewer 端到端；过期清理真实清理测试目录。验收：真实场景分块上传/暂停/刷新/续传/完成；坏文件不发布；重复 complete/投递不产生重复版本；不可变目录+原子切换失败不破坏上版本；跨用户读写被拒绝。

### 阶段 07 · FFmpeg、COLMAP 与 gsplat 异步重建
工具环境：实际执行 ffmpeg/ffprobe/COLMAP/gsplat/splat-transform 版本命令并记录 GPU/驱动/CUDA/显存/磁盘；worker capability check 不满足不消费队列；gsplat 由 lock/commit 固定；工具路径可信配置；每任务记录版本/profile/输入摘要/可复现参数。输入预检：ffprobe 读编码/时长/分辨率/帧率/旋转/音轨；照片序列验证数量/格式/尺寸/损坏/方向；拒绝超限；输入只读产物写 job 目录；预检给可处理/警告/拒绝+错误码；低质量输入不得静默"成功"空场景。FFmpeg 抽帧：按 profile 选抽帧率/最大帧数；应用旋转与像素格式保留纵横比；服务端连续编号；抽帧后验证数量/尺寸/可读性/大小；模糊/重复过滤记录阈值；进度来自可解析真实时间/帧；取消终止子进程组。COLMAP：按数量/类型选策略；库与 sparse 在 job 目录；每步查退出码与产物；校验注册图像/点数/reprojection error/相机；低于阈值安全失败给建议；GPU/CPU 参数与设备一致；命令以 -h/--help 验证并经 argv 执行；取消/超时终止并保存诊断。gsplat：COLMAP 输出转锁定训练入口结构；profile 明确 iterations/分辨率/评估/保存/资源；job 独立目录+随机种子；进度来自真实迭代/loss/checkpoint；checkpoint 临时文件后原子改名；可恢复；检测 NaN/Inf/OOM/设备/磁盘错误分类失败；最终导出真实 splat 校验数/bounds/有限值；取消在安全点停。转换/发布：锁定 splat-transform+阶段 04 脚本生成 Streamed SOG；生成 Poster/manifest/build-info/checksums；验证索引/哈希/bounds/相机/low 首帧；用阶段 06 原子发布；DB 只在资产完整后指向新 current；Viewer smoke 加载新版本非旧缓存。Celery 编排：CPU/GPU 队列分离受配置控制；阶段可重入或完成标记跳过（含输入/参数/工具/产物哈希）；重试只对可重试错误；worker lost/超时/重复投递不并行写同目录；状态转换条件更新防倒退；取消在阶段边界与进度回调检查；失败重跑新 attempt 保留关联。Web 任务页：从服务端能力获取格式/配额/profile；确认权利才提交；队列位置无法准确提供不显示伪数字；真实 job stage+0~100% 或阶段型不确定进度；刷新/重连从 API 恢复；安全日志摘要仅允许字段；取消是请求状态 worker 确认后显示 CANCELLED；成功进我的作品/Viewer，失败给建议。安全配额清理：每用户并发/每日任务/输入字节/GPU 时长服务端约束；路由/目录/task/job 均校验 owner；子进程限运行时/CPU/内存/文件/日志；worker 非特权；失败/取消/过期按保留策略清理（dry-run+根校验+审计）；已发布当前版本不被清理删除。验收（环境自适应但诚实）：真实视频与照片序列分别走完整流水线并生成不同当前 SceneVersion；工具真实执行有版本/参数/产物证据；新 Streamed SOG 冷缓存首帧可辨识；进度/日志来自真实事件；取消/中断恢复/重复投递不造成错误成功或目录并发破坏；坏输入/低注册率/OOM/磁盘不足产生正确错误码与建议；配额生效用户间不可互访。若环境无法完整训练 gsplat：训练项不得勾 PASS，Report 标 BLOCKED/FAIL 记录 blocker，同时交付完整可运行代码与能力检查证据。

### 阶段 08 · 账户、作品、收藏、分享、问 AI 与详情
账户会话：注册/邀请/登录/登出/当前用户/撤销；密码强哈希（外部身份验 issuer/audience/signature/expiry）；浏览器会话 Secure/HttpOnly/SameSite Cookie；写操作 CSRF 防护；登录/敏感动作速率限制+审计；过期 Axios 统一处理；删除或拒绝开发身份旁路；日志/前端状态无凭据。我的作品：/works 真实分页 API+URL 筛选排序；显示 DRAFT/PROCESSING/PUBLISHED/FAILED/ARCHIVED 真实状态；编辑 schema 校验+冲突控制（多标签页冲突 409 并前端提示）；归档/恢复/删除二次确认+后端权限；删除可恢复/延迟清理不在请求中递归删大目录；处理中可看 job/取消/重试资格。收藏：Favorite(user_id,scene_id) 唯一约束；收藏/取消幂等校验可见性；Viewer 与 SceneCard 同源状态；乐观更新失败回滚提示；刷新/重登/多标签页与 DB 一致；私有化/删除后不泄露。分享：公共用规范平台 URL 不暴露 storage key；私有/未列出由 owner 创建可撤销可过期 token；DB 只存 token hash/权限/expiry/revoked_at/审计；原始 token 只在创建响应返回不入日志；访问再次校验 Scene 状态与版本；撤销/过期在 API 与静态资产交付层真实生效（短期签名同源路径或 Nginx 内部重定向）；Web Share 不可用提供复制回退。详情作者：右侧作者入口展示允许公开信息与作品列表；详情面板标题/简介/分类/发布日期/可见统计/当前版本/允许技术信息；不展示内部路径/原始文件名/任务日志/私有 EXIF；真实 loading/empty/error/retry。问 AI：服务端 SceneAssistantService，前端不直接调模型；密钥/endpoint/标识只在服务端；上下文只含用户有权看到的元数据/公开描述/技术统计/允许文本，不发送场景文件/私有路径/令牌/Cookie/他人信息；请求身份/分享校验、长度/速率限制、超时/取消；回答是真实模型响应，未配置/失败明确不可用，固定文本/模板/随机内容不得冒充；回答标明基于哪些字段，信息不足承认无法判断；场景文字作不可信数据不得覆盖安全规则；非流式 JSON+AbortController 无重复消息。统计一致性（若实现）：浏览/收藏统计可解释口径+幂等 key/异步聚合防刷新累加；SceneCard/详情/Viewer 同字段语义；缓存失效含 visibility/currentVersion/删除；公开列表不读未提交事务。验收：正式会话登录/刷新/过期/登出/撤销正确，production 无旁路；权限矩阵（owner/登录非 owner/匿名+分享）由 API 与资产交付层验证而非仅前端隐藏；收藏/分享/详情刷新与多标签页与 DB 一致；问 AI 真实模型响应（无密钥环境以 mock 验证全部路径与上下文安全断言并在 Report 如实标注）；完整 E2E：登录→我的作品→Viewer→收藏→分享→问AI→详情。

### 阶段 09 · Ubuntu、Nginx 与 HTTPS 生产部署
主机：Ubuntu 安全更新；独立 deploy/app/worker 账户最小权限；SSH 密钥限来源；防火墙仅 SSH/80/443，DB/Redis 不公网；UTC 日志；容量与磁盘告警；GPU worker 驱动/CUDA 验证且普通账户最小权限用设备。发布：不可变 release ID（含 commit/构建元数据）；Web 锁文件受控构建；Python 锁定版本装 release 专属 venv；外部工具版本与阶段 07 一致；/opt/gsplatform/current 原子指向有效 release；配置/秘密在 release 外仅运行账户可读；部署脚本 dry-run/preflight/非零失败。systemd：FastAPI 专用 unit 绑 localhost/Unix socket，非 root/工作目录/环境文件/重启/资源限制；Celery CPU/GPU 不同 unit/队列/并发/资源；定时清理用 timer；启动依赖必要（Redis 短暂不可用不无限重启风暴）；stop timeout 足够安全 checkpoint/重排；systemctl status/journal/任务执行验证成功。DB/Redis：仅私有接口+最小权限角色；连接池不超上限；auto vacuum/慢查询/磁盘监控；Redis 私有+认证/ACL+内存淘汰；持久化与"broker/backend 不是唯一业务真相"一致；断连可恢复不假成功。Nginx/HTTPS：80 仅 ACME/重定向；443 有效域名证书+完整链+现代安全配置；自动续期 dry-run 验证；SPA 刷新回退 index.html，资产 404 不回退 HTML；/api/ 反代保留 request ID/真实客户端协议/受信代理；API 超时，上传独立大文件限制；SSE/流式关闭破坏流式的缓冲；/scene-assets/ 支持 206/Content-Range/416+正确 MIME；版本资产长期 immutable 缓存；staging/quarantine/jobs/source/logs/backups HTTP 拒绝；CSP/HSTS/X-Content-Type-Options/Referrer-Policy 等响应头；CORS 只允许生产来源。数据目录：目录所有者/mode 正确；published 与临时目录在原子 rename 边界内；磁盘水位耗尽前阻止新任务且保留现有服务；清理 dry-run+根校验+不跨 Scene 删除；Nginx 只对授权资源内部交付；大文件真实穿过 Nginx→API→staging。迁移发布：每次发布前 preflight（备份/磁盘/配置/依赖/迁移）；alembic upgrade head 在 staging 从生产结构副本真实执行；兼容窗口明确；破坏性迁移用扩展/迁移/收缩；release 切换/reload/健康检查可重复；smoke 失败自动或按手册回滚；不可逆数据变化有单独恢复方案，不伪称代码回滚=数据回滚。健康/日志/指标/告警：外部监测首页/live/ready/公开 manifest；API/Nginx/worker 日志含 request/job ID 可追踪；脱敏/限长/轮转/保留验证；监控 CPU/RAM/磁盘/GPU/DB/Redis/队列/任务失败/API 延迟错误率/上传失败/Viewer 资产 4xx-5xx/Range 成功率；证书到期/备份失败/磁盘水位/worker 离线告警；用测试事件实际触发至少一个告警并确认恢复通知。备份恢复：DB 自动备份加密校验复制到故障域外；published 资产/关键配置/版本关系一致备份；staging/中间件/缓存备份与否有决定；保留符合隐私；隔离环境真实恢复 PostgreSQL；隔离环境真实恢复一个 Scene 的 manifest/Poster/Streamed SOG 并由 Viewer 打开；记录实测 RPO/RTO 与手册修订。安全上线：依赖/系统扫描或清单；生产 .env 权限正确不在 Git；登录/CSRF/CORS/分享/私有资产/恶意上传生产拓扑复测；TLS/重定向/安全头/Cookie 真实域名复测；五页面+Viewer 渐进/Streamed SOG/工具冷缓存复测；执行一次受控发布与一次受控回滚演练。验收：真实受控域名仅有效 HTTPS，HTTP 重定向与续期验证通过；SPA/API/上传/SSE/公开私有资产在 Nginx 后真实工作；Range 206/416 与冷缓存渐进按阶段 04 标准；DB/Redis 不公网进程非 root；生产拓扑 E2E 全过；监控/日志/轮转/至少一个测试告警真实验证；DB 与一个完整 Scene 隔离恢复并由 Viewer 打开；发布回滚演练成功记录实测 RPO/RTO。若环境无真实域名/公网：允许本地受控主机+本地签发受限证书完成同等验证并在 Report 如实说明，不得声称已通过真实公网验收。

## 五、两条主路径最终验收（跨阶段综合）

阶段 09 后按生产拓扑（或如实标注的本地等效拓扑）完整复验：

| 验收项 | 判定标准 |
|---|---|
| 浏览主路径 | 首页 5 列→打开作品→Poster+真实进度→低 LOD 可交互→Streamed SOG 细化→收藏/分享/详情/问AI，控制台无未处理错误 |
| 创作主路径 | 登录→上传与免费重建→真实阶段/进度→原子发布→我的作品可见→Viewer 冷缓存加载新版本 |
| 数据一致性 | 刷新/重登/多标签页后收藏与作品与 DB 一致；权限由后端与资产交付层强制 |
| 安全基线 | 无密钥入库；staging/quarantine/jobs 不可 HTTP 访问；分享撤销即时生效；日志无凭据 |
| 工程质量 | pnpm lint/typecheck/test/build、API ruff/mypy/pytest、迁移往返、E2E 全过；已知问题如实记录 |

## 六、任务执行规范

1. 按阶段顺序执行，每阶段一个独立 commit（含阶段号），不 push；Report PASS 才进入下一阶段。
2. 真实验证优先：所有"可运行/可用/PASS"结论必须由实际命令/页面/网络/性能记录支撑并写入 Report 证据列。
3. 诚实记录：无法验证项保持 [ ]，写进 Report 的 Known Issues（ID/未完成项/环境命令/实际结果/原因/下一步），不得删除该节。
4. 不伪造不偷工：禁止定时器/硬编码/固定值/预录日志冒充真实进度与渲染；禁止 SQLite 通过 PostgreSQL 验收；禁止 fixture 冒充生产数据；禁止把完整文件下载称为 Streamed SOG。
5. 安全第一：秘密只经环境变量注入且绝不入库；用户输入不直接拼路径/命令；子进程统一 argv+固定路径+超时+资源限制；日志脱敏。
6. 最终交付：全部阶段完成后输出《任务执行总结》：仓库结构、两条主路径真实验证证据（命令输出/网络记录/截图或等价物）、各阶段 Report 路径、所有 Known Issues、未完成项与原因。

## 七、交付物清单（最终验收对象）

```text
GSPlatform/
|-- apps/web/            React 前端（五页面+Viewer Shell）
|-- apps/viewer/         SuperSplat fork（UPSTREAM.md+许可证）
|-- apps/api/            FastAPI+SQLAlchemy+Alembic
|-- workers/             Celery（上传发布+重建流水线）
|-- scripts/             构建/校验/基准脚本（lods、streamed sog、重建、发布、运维）
|-- deploy/              nginx/systemd/部署脚本/env 示例
|-- scenes/              测试场景清单与校验和（大文件不进 Git）
|-- docs/
|   |-- reports/PHASE_00_REPORT.md ... PHASE_09_REPORT.md（十份真实证据）
|   `-- operations/      部署/回滚/备份恢复/事故 Runbook+容量计划
`-- README.md / .env.example / 锁文件 / 第三方声明
```

## 八、评价维度（供验收方使用）

- 功能完整性：两条主路径+十阶段交付物是否全部真实存在且可运行。
- 真实性：进度/渲染/性能/权限证据是否来自真实事件与真实服务，能否被命令与记录复验。
- 正确性与健壮性：错误处理、取消、幂等、并发、失败降级、资源释放是否符合各阶段验收。
- 工程质量：分层、类型、迁移、测试、文档、Git 提交纪律。
- 安全：密钥、路径、命令、日志、权限边界的处理。
- 诚实性：Checklist 勾选是否与证据一致；无法验证项是否如实标注。