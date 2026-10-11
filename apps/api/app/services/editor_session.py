"""Platform-owned authorization around the official independent Editor."""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError
from app.core.identity import RequestIdentity
from app.db.models.job import Job
from app.db.models.scene import Scene, SceneVersion
from app.db.models.scene_edit_session import SceneEditSession
from app.db.models.upload_session import UploadSession
from app.schemas.editor_session import (
    CreateEditSessionRequest,
    EditExportRequest,
    EditSessionOut,
    EditSourceOut,
)
from app.schemas.uploads import CreateUploadRequest, UploadSessionOut
from app.services.scene_access import SceneAccessPolicy
from app.services.scene_asset import ResolvedSceneAsset, SceneAssetAccessScope, SceneAssetService

EDITOR_COMMIT = "f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b"


class EditSessionError(ConflictError):
    code = "EDIT_SESSION_INVALID"


class EditBaseVersionChanged(ConflictError):
    code = "EDIT_BASE_VERSION_CHANGED"


class EditorSessionService:
    def __init__(self, session: Session, settings: Settings) -> None:
        self.session = session
        self.settings = settings

    def owner_scene(self, slug: str, identity: RequestIdentity) -> Scene:
        if identity.source != "session":
            raise ForbiddenError("高级编辑需要真实登录会话；不允许开发身份旁路")
        policy = SceneAccessPolicy(self.session)
        scene = policy.resolve_readable_scene(slug, identity)
        if not policy.is_owner(scene, identity.user_id):
            raise ForbiddenError("只有作品所有者可以编辑 Gaussian；分享链接仅允许查看")
        return scene

    def build_identity(self) -> str:
        if not self.settings.editor_enabled or not self.settings.editor_build_manifest:
            raise ServiceUnavailableError("官方 Editor 尚未启用或未通过部署审核")
        try:
            receipt = json.loads(Path(self.settings.editor_build_manifest).read_text())
            identity = receipt["artifactSha256"]
            if (receipt["upstreamCommit"] != EDITOR_COMMIT
                    or receipt["basePath"] != "/gaussian-editor/"
                    or not isinstance(identity, str)
                    or not re.fullmatch(r"[a-f0-9]{64}", identity)):
                raise ValueError("invalid receipt")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ServiceUnavailableError("Editor 固定构建凭据无效") from exc
        return identity

    def source_info(self, slug: str, identity: RequestIdentity) -> EditSourceOut:
        from app.db.models.scene_spatial_state import SceneSpatialState

        scene = self.owner_scene(slug, identity)
        version = self.session.get(SceneVersion, scene.current_version_id)
        spatial = self.session.get(SceneSpatialState, scene.id)
        counts = (version.manifest or {}).get("stream", {}).get("counts", []) if version else []
        return EditSourceOut(
            sceneId=scene.id, sceneTitle=scene.title, currentVersionId=scene.current_version_id,
            assetVersion=version.asset_version if version else None,
            format=version.format if version else None, counts=counts or [scene.splat_count or 0],
            editorEnabled=self.settings.editor_enabled,
            maxGaussians=self.settings.editor_max_gaussians,
            spatialState=spatial.state if spatial else None,
        )

    def create(self, slug: str, body: CreateEditSessionRequest,
               identity: RequestIdentity) -> EditSessionOut:
        scene = self.owner_scene(slug, identity)
        if scene.current_version_id != body.expectedCurrentVersion:
            raise EditBaseVersionChanged("当前版本已变化，请重新读取场景后创建编辑会话")
        version = self.session.get(SceneVersion, scene.current_version_id)
        if version is None or version.scene_id != scene.id:
            raise ConflictError("场景没有可编辑的已发布版本")
        if version.format not in ("ply", "sog", "streamed-sog"):
            raise ConflictError("此版本没有受支持的持久化 PLY/SOG 编辑来源")
        build = self.build_identity()
        streamed = version.format == "streamed-sog"
        counts = (version.manifest or {}).get("stream", {}).get("counts", [])
        if not counts:
            counts = [scene.splat_count or 0]
        if not all(isinstance(count, int) and count > 0 for count in counts):
            raise ConflictError("源 Gaussian 数量缺少可信记录")
        lod = body.selectedLod if streamed else None
        if streamed:
            if not body.acknowledgeLodSource or lod is None or lod >= len(counts):
                raise ConflictError("Streamed SOG 只编辑所选 LOD，需明确选择并确认降采样来源")
        count = counts[lod or 0]
        if count > self.settings.editor_max_gaussians:
            raise ConflictError("所选来源超过浏览器编辑安全上限，请选择更低 LOD")
        if count > 1_000_000 and not body.acknowledgeBrowserMemory:
            raise ConflictError("大型来源需要明确确认浏览器内存风险")
        entry = (
            "lod-meta.json" if streamed else "scene.ply" if version.format == "ply" else "scene.sog"
        )
        SceneAssetService(self.settings).resolve(
            scene, f"versions/{version.asset_version}/{entry}",
            access_scope=SceneAssetAccessScope.OWNER,
        )
        now = datetime.now(UTC)
        edit = SceneEditSession(
            scene_id=scene.id, owner_id=identity.user_id, source_version_id=version.id,
            source_asset_version=version.asset_version,
            source_kind="SELECTED_STREAMED_LOD" if streamed else "FULL_RESOLUTION_SOURCE",
            source_entry=entry, source_counts=counts, selected_lod=lod,
            editor_upstream_commit=EDITOR_COMMIT, editor_build_identity=build, status="CREATED",
            created_at=now, expires_at=now + timedelta(hours=self.settings.editor_session_hours),
        )
        self.session.add(edit)
        self.session.flush()
        result = self.out(scene, edit)
        self.session.commit()
        return result

    def owned(self, slug: str, session_id: uuid.UUID, identity: RequestIdentity,
              *, active: bool = False, lock: bool = False) -> tuple[Scene, SceneEditSession]:
        scene = self.owner_scene(slug, identity)
        query = select(SceneEditSession).where(
            SceneEditSession.id == session_id, SceneEditSession.scene_id == scene.id,
            SceneEditSession.owner_id == identity.user_id,
        ).execution_options(populate_existing=True)
        if lock:
            query = query.with_for_update()
        edit = self.session.scalars(query).one_or_none()
        if edit is None:
            raise NotFoundError("编辑会话不存在或不属于此场景")
        if edit.expires_at <= datetime.now(UTC) and edit.status not in ("COMPLETED", "CANCELLED"):
            edit.status = "EXPIRED"
        if active and edit.status in ("EXPIRED", "CANCELLED", "COMPLETED"):
            raise EditSessionError(
                f"编辑会话已终止：{edit.status}", details={"status": edit.status}
            )
        return scene, edit

    def get(self, slug: str, session_id: uuid.UUID, identity: RequestIdentity) -> EditSessionOut:
        scene, edit = self.owned(slug, session_id, identity)
        return self.out(scene, edit)

    def cleanup_exports(self) -> int:
        from app.storage import LocalDiskStorage

        cutoff = datetime.now(UTC) - timedelta(days=self.settings.editor_export_retention_days)
        records = self.session.scalars(
            select(SceneEditSession).where(SceneEditSession.expires_at < cutoff)
            .with_for_update(skip_locked=True).limit(100)
        ).all()
        storage = LocalDiskStorage(self.settings.storage_root)
        cleaned = 0
        for edit in records:
            job = self.session.get(Job, edit.job_id) if edit.job_id else None
            if job and job.status in ("RUNNING", "QUEUED"):
                continue
            if edit.upload_id:
                for prefix in ("staging", "quarantine"):
                    key = f"{prefix}/{edit.upload_id}"
                    if storage.exists(key):
                        storage.delete(key)
                        cleaned += 1
            if edit.status not in ("COMPLETED", "CANCELLED"):
                edit.status = "EXPIRED"
        self.session.commit()
        return cleaned

    def create_upload(
        self, slug: str, session_id: uuid.UUID, body: EditExportRequest,
        identity: RequestIdentity,
    ) -> UploadSessionOut:
        from app.services.celery_client import send_task
        from app.services.upload_service import UploadService
        from app.storage import LocalDiskStorage

        scene, edit = self.owned(slug, session_id, identity, active=True, lock=True)
        uploads = UploadService(self.session, LocalDiskStorage(self.settings.storage_root),
                                self.settings, send_task=send_task)
        if edit.upload_id:
            upload = self.session.get(UploadSession, edit.upload_id)
            if (upload is None or upload.total_size != body.size
                    or upload.upload_format != body.format
                    or upload.declared_sha256 != body.sha256):
                raise EditSessionError("会话已有不同导出文件，不能替换或重复创建上传")
            return uploads._to_out(upload)
        if edit.source_kind == "SELECTED_STREAMED_LOD":
            if not body.acknowledgeSelectedLod or body.selectedLod != edit.selected_lod:
                raise EditSessionError("必须确认官方 Editor 实际选择的 LOD 与会话一致")
        request = CreateUploadRequest(
            filename=body.filename, format=body.format, mime_type=body.mime_type,
            size=body.size, sha256=body.sha256, title=scene.title, description=scene.description,
            category=scene.category, visibility=scene.visibility,
        )
        return uploads.create_session(request, identity, edit_session=edit)

    def cancel(self, slug: str, session_id: uuid.UUID, identity: RequestIdentity) -> EditSessionOut:
        scene, edit = self.owned(slug, session_id, identity, lock=True)
        if edit.status == "COMPLETED":
            raise EditSessionError("已发布的编辑结果不能取消")
        if edit.status not in ("CANCELLED", "EXPIRED"):
            edit.status = "CANCELLED"
            edit.cancelled_at = datetime.now(UTC)
        return self.out(scene, edit)

    def source(self, slug: str, session_id: uuid.UUID, asset_version: str, resource: str,
               identity: RequestIdentity) -> ResolvedSceneAsset:
        scene, edit = self.owned(slug, session_id, identity, active=True)
        if self.build_identity() != edit.editor_build_identity:
            raise EditSessionError("编辑器部署构建已变化，请创建新的授权会话")
        if asset_version != edit.source_asset_version:
            raise NotFoundError("资源版本与编辑会话不符")
        version = self.session.get(SceneVersion, edit.source_version_id)
        if (version is None or version.scene_id != scene.id
                or version.asset_version != asset_version):
            raise NotFoundError("编辑来源版本不存在")
        resolved = SceneAssetService(self.settings).resolve(
            scene, f"versions/{asset_version}/{resource}", access_scope=SceneAssetAccessScope.OWNER,
        )
        if edit.status == "CREATED":
            edit.status = "OPENED"
            edit.opened_at = datetime.now(UTC)
        return ResolvedSceneAsset(resolved.absolute_path, resolved.x_accel_path,
                                  resolved.media_type, "private, no-store")

    def out(self, scene: Scene, edit: SceneEditSession) -> EditSessionOut:
        source = (f"/api/v1/scenes/{scene.slug}/edit-sessions/{edit.id}/source/"
                  f"versions/{edit.source_asset_version}/{edit.source_entry}")
        job = self.session.get(Job, edit.job_id) if edit.job_id else None
        upload = self.session.get(UploadSession, edit.upload_id) if edit.upload_id else None
        result = (self.session.get(SceneVersion, edit.result_version_id)
                  if edit.result_version_id else None)
        status = edit.status
        if upload and status not in ("COMPLETED", "CANCELLED", "EXPIRED", "FAILED"):
            status = upload.status
        return EditSessionOut(
            id=edit.id, sceneId=scene.id, sceneSlug=scene.slug, sceneTitle=scene.title,
            sourceVersionId=edit.source_version_id, sourceAssetVersion=edit.source_asset_version,
            sourceKind=edit.source_kind, sourceCounts=edit.source_counts,
            selectedLod=edit.selected_lod,
            editorUpstreamCommit=edit.editor_upstream_commit,
            editorBuildIdentity=edit.editor_build_identity,
            status=status, createdAt=edit.created_at, expiresAt=edit.expires_at,
            sourceUrl=source, editorUrl="/gaussian-editor/?" + urlencode({"load": source}),
            uploadId=edit.upload_id, resultVersionId=edit.result_version_id,
            resultCounts=((result.manifest or {}).get("stream", {}).get("counts")
                          if result else None),
            errorCode=edit.error_code,
            progress=int(job.progress) if job else 0, stage=job.stage if job else None,
        )
