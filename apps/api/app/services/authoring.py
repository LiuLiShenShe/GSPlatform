"""Authoring service — ScenePresentation, SceneViewpoint & SceneAnnotation use-cases.

Owns all read/write for presentation settings, viewpoints, annotations,
cover/background asset management, and background audio.
The service does not touch the original SOG; transforms are
applied to the viewer entity at load time.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.errors import ConflictError, ForbiddenError, NotFoundError
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind  # noqa: F401  (referenced via .value below)
from app.db.models.scene import Scene
from app.db.models.scene_annotation import SceneAnnotation
from app.db.models.scene_presentation import ScenePresentation
from app.db.models.scene_viewpoint import SceneViewpoint
from app.repositories.authoring import (
    SceneAnnotationRepository,
    ScenePresentationRepository,
    SceneViewpointRepository,
)
from app.schemas.scene_annotation import (
    SceneAnnotationCreateRequest,
    SceneAnnotationOut,
    SceneAnnotationReorderRequest,
    SceneAnnotationUpdateRequest,
)
from app.schemas.scene_presentation import (
    ScenePresentationOut,
    ScenePresentationUpdateRequest,
    SceneViewpointCreateRequest,
    SceneViewpointOut,
    SceneViewpointReorderRequest,
    SceneViewpointUpdateRequest,
    Vec3,
)
from app.storage.base import Storage

logger = logging.getLogger("gsplatform.authoring")

# Allowed cover / background MIME types.
_COVER_MIME = {"image/jpeg", "image/png", "image/webp"}
_COVER_MAX_BYTES = 10 * 1024 * 1024  # 10 MB


def _validate_owner(scene: Scene, owner_id: uuid.UUID) -> None:
    if scene.owner_id != owner_id:
        raise ForbiddenError("只有场景所有者可以编辑")


def _json_to_vec3(data: dict[str, float] | None) -> Vec3 | None:
    if not data:
        return None
    return Vec3(x=data.get("x", 0.0), y=data.get("y", 0.0), z=data.get("z", 0.0))


def _vec3_to_json(v: Vec3) -> dict[str, float]:
    return {"x": v.x, "y": v.y, "z": v.z}


def _presentation_out(
    pres: ScenePresentation,
    storage: Storage,
) -> ScenePresentationOut:
    """Assemble the DTO, resolving cover/background asset URLs."""
    cover_url: str | None = None

    if pres.cover_asset_id is not None:
        cover = storage.read(f"presentation/{pres.scene_id}/cover")
        if cover:
            cover_url = f"/api/v1/scenes/{pres.scene_id}/presentation/cover"

    return ScenePresentationOut(
        worldPosition=_json_to_vec3(pres.world_position),
        worldRotation=_json_to_vec3(pres.world_rotation),
        worldScale=_json_to_vec3(pres.world_scale),
        initialCameraPosition=_json_to_vec3(pres.initial_camera_position),
        initialCameraTarget=_json_to_vec3(pres.initial_camera_target),
        initialCameraFov=pres.initial_camera_fov,
        backgroundType=pres.background_type,
        backgroundColor=_json_to_vec3(pres.background_color),
        backgroundAssetId=str(pres.background_asset_id) if pres.background_asset_id else None,
        backgroundMetadata=pres.background_metadata,
        coverAssetId=str(pres.cover_asset_id) if pres.cover_asset_id else None,
        coverUrl=cover_url,
        backgroundAudioAssetId=(
            str(pres.background_audio_asset_id) if pres.background_audio_asset_id else None
        ),
        backgroundAudioVolume=pres.background_audio_volume,
        backgroundAudioLoop=pres.background_audio_loop,
        backgroundAudioEnabled=pres.background_audio_enabled,
        collisionMode=pres.collision_mode,
        collisionAssetId=str(pres.collision_asset_id) if pres.collision_asset_id else None,
        collisionGravity=pres.collision_gravity,
        collisionSlopeLimitDegrees=pres.collision_slope_limit_degrees,
        collisionStepOffset=pres.collision_step_offset,
        collisionPlayerHeight=pres.collision_player_height,
        collisionEnabled=pres.collision_enabled,
    )


class AuthoringService:
    """Scene presentation/authoring use-cases."""

    def __init__(self, session: Session, storage: Storage) -> None:
        self._session = session
        self._storage = storage
        self._presentations = ScenePresentationRepository(session)
        self._viewpoints = SceneViewpointRepository(session)
        self._annotations = SceneAnnotationRepository(session)

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _get_owned_scene(self, slug_or_id: str, owner_id: uuid.UUID) -> Scene:
        from app.repositories.scenes import SceneRepository

        scene = SceneRepository(self._session).get_by_slug(slug_or_id)
        if scene is None:
            # maybe the internal UUID
            try:
                scene_uuid = uuid.UUID(slug_or_id)
                scene = SceneRepository(self._session).get_by_id(scene_uuid)
            except ValueError:
                scene = None
        if scene is None:
            raise NotFoundError(f"场景 {slug_or_id} 不存在")
        _validate_owner(scene, owner_id)
        return scene

    def _resolve_pres_for_edit(
        self, slug_or_id: str, owner_id: uuid.UUID
    ) -> tuple[Scene, ScenePresentation]:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        pres = self._presentations.get_by_scene_or_create(scene.id)
        return scene, pres

    # ------------------------------------------------------------------ #
    # presentation settings
    # ------------------------------------------------------------------ #
    def get_presentation(
        self, slug_or_id: str, identity_user_id: uuid.UUID | None
    ) -> ScenePresentationOut:
        """Read presentation. Visible to owner; published public scenes are readable."""
        scene = self._get_owned_scene_for_read(slug_or_id, identity_user_id)
        pres = self._presentations.get_by_scene(scene.id)
        if pres is None:
            pres = self._presentations.get_by_scene_or_create(scene.id)
        return _presentation_out(pres, self._storage)

    def _get_owned_scene_for_read(
        self, slug_or_id: str, identity_user_id: uuid.UUID | None
    ) -> Scene:
        from app.repositories.scenes import SceneRepository

        repo = SceneRepository(self._session)
        scene = repo.get_by_slug(slug_or_id)
        if scene is None:
            try:
                scene_uuid = uuid.UUID(slug_or_id)
                scene = repo.get_by_id(scene_uuid)
            except ValueError:
                scene = None
        if scene is None:
            raise NotFoundError(f"场景 {slug_or_id} 不存在")
        if identity_user_id is not None and scene.owner_id == identity_user_id:
            return scene
        # published + public scenes are readable by anyone
        if scene.status in {"PUBLISHED", "READY"} and scene.visibility == "PUBLIC":
            return scene
        raise ForbiddenError("该场景不可见或未发布")

    def update_presentation(
        self,
        slug_or_id: str,
        owner_id: uuid.UUID,
        body: ScenePresentationUpdateRequest,
        *,
        overwrite: bool = False,
    ) -> ScenePresentationOut:
        scene, pres = self._resolve_pres_for_edit(slug_or_id, owner_id)

        # backgroundType validation
        if body.backgroundType is not None:
            if body.backgroundType not in {"color", "equirectangular"}:
                raise ConflictError(f"无效背景类型: {body.backgroundType}")
            pres.background_type = body.backgroundType

        if body.worldPosition is not None:
            pres.world_position = _vec3_to_json(body.worldPosition)
        elif overwrite:
            pres.world_position = None

        if body.worldRotation is not None:
            pres.world_rotation = _vec3_to_json(body.worldRotation)
        elif overwrite:
            pres.world_rotation = None

        if body.worldScale is not None:
            pres.world_scale = _vec3_to_json(body.worldScale)
        elif overwrite:
            pres.world_scale = None

        if body.initialCameraPosition is not None:
            pres.initial_camera_position = _vec3_to_json(body.initialCameraPosition)
        elif overwrite:
            pres.initial_camera_position = None

        if body.initialCameraTarget is not None:
            pres.initial_camera_target = _vec3_to_json(body.initialCameraTarget)
        elif overwrite:
            pres.initial_camera_target = None

        if body.initialCameraFov is not None:
            fov = body.initialCameraFov
            if fov < 10.0 or fov > 160.0:
                raise ConflictError("FOV 必须在 10-160 之间")
            pres.initial_camera_fov = fov
        elif overwrite:
            pres.initial_camera_fov = None

        if body.backgroundColor is not None:
            pres.background_color = _vec3_to_json(body.backgroundColor)
        elif overwrite:
            pres.background_color = None

        if body.backgroundMetadata is not None:
            pres.background_metadata = body.backgroundMetadata
        elif overwrite:
            pres.background_metadata = None

        if body.backgroundAssetId is not None:
            try:
                asset_uuid = uuid.UUID(body.backgroundAssetId)
            except ValueError:
                raise ConflictError("无效的 backgroundAssetId") from None
            asset = self._session.get(Asset, asset_uuid)
            if asset is None:
                raise NotFoundError("背景资源不存在")
            if asset.scene_id != scene.id:
                raise ForbiddenError("背景资源不属于该场景")
            pres.background_asset_id = asset_uuid
        elif overwrite:
            pres.background_asset_id = None

        if body.coverAssetId is not None:
            try:
                cover_uuid = uuid.UUID(body.coverAssetId)
            except ValueError:
                raise ConflictError("无效的 coverAssetId") from None
            asset = self._session.get(Asset, cover_uuid)
            if asset is None:
                raise NotFoundError("封面资源不存在")
            if asset.scene_id != scene.id:
                raise ForbiddenError("封面资源不属于该场景")
            pres.cover_asset_id = cover_uuid
        elif overwrite:
            pres.cover_asset_id = None

        self._session.flush()
        return _presentation_out(pres, self._storage)

    # ------------------------------------------------------------------ #
    # cover / background asset uploads
    # ------------------------------------------------------------------ #
    def _store_image(
        self,
        scene_id: uuid.UUID,
        kind: str,
        data: bytes,
        mime: str,
        *,
        lat: float | None = None,
        lon: float | None = None,
    ) -> Asset:
        """Persist an image under presentation/ and create a POSTER/COVER Asset."""
        digest = hashlib.sha256(data).hexdigest()
        key = f"presentation/{scene_id}/{kind}"
        self._storage.write(key, data)

        asset_kind = AssetKind.POSTER.value if kind == "cover" else kind
        metadata: dict[str, Any] = {"mime": mime}
        if lat is not None:
            metadata["latitude"] = lat
        if lon is not None:
            metadata["longitude"] = lon

        asset = Asset(
            scene_id=scene_id,
            version_id=None,
            kind=asset_kind,
            storage_key=key,
            mime_type=mime,
            byte_size=len(data),
            sha256=digest,
            metadata_=metadata,
        )
        self._session.add(asset)
        self._session.flush()
        return asset

    def set_cover_upload(
        self,
        slug_or_id: str,
        owner_id: uuid.UUID,
        data: bytes,
        mime: str,
    ) -> ScenePresentationOut:
        if mime not in _COVER_MIME:
            raise ConflictError(f"仅支持 JPG/PNG/WebP 封面，收到: {mime}")
        if len(data) > _COVER_MAX_BYTES:
            raise ConflictError("封面文件不能超过 10MB")
        scene, pres = self._resolve_pres_for_edit(slug_or_id, owner_id)
        asset = self._store_image(scene.id, "cover", data, mime)
        pres.cover_asset_id = asset.id
        self._session.flush()
        return _presentation_out(pres, self._storage)

    def set_background_upload(
        self,
        slug_or_id: str,
        owner_id: uuid.UUID,
        data: bytes,
        mime: str,
        *,
        lat: float | None = None,
        lon: float | None = None,
    ) -> ScenePresentationOut:
        if mime not in _COVER_MIME:
            raise ConflictError(f"仅支持 JPG/PNG/WebP 全景背景，收到: {mime}")
        if len(data) > _COVER_MAX_BYTES:
            raise ConflictError("背景文件不能超过 10MB")
        scene, pres = self._resolve_pres_for_edit(slug_or_id, owner_id)
        asset = self._store_image(
            scene.id, "background", data, mime, lat=lat, lon=lon
        )
        pres.background_type = "equirectangular"
        pres.background_asset_id = asset.id
        self._session.flush()
        return _presentation_out(pres, self._storage)

    def serve_cover(self, slug_or_id: str) -> tuple[bytes, str]:
        """Return cover image bytes + mime (or raise NotFound)."""
        from app.repositories.scenes import SceneRepository

        scene = SceneRepository(self._session).get_by_slug(slug_or_id)
        if scene is None:
            raise NotFoundError(f"场景 {slug_or_id} 不存在")
        pres = self._presentations.get_by_scene(scene.id)
        if pres is None or pres.cover_asset_id is None:
            raise NotFoundError("该场景尚未设置封面")
        asset = self._session.get(Asset, pres.cover_asset_id)
        if asset is None:
            raise NotFoundError("封面资源不存在")
        data = self._storage.read(asset.storage_key)
        return data, asset.mime_type

    def serve_background(self, slug_or_id: str) -> tuple[bytes, str]:
        from app.repositories.scenes import SceneRepository

        scene = SceneRepository(self._session).get_by_slug(slug_or_id)
        if scene is None:
            raise NotFoundError(f"场景 {slug_or_id} 不存在")
        pres = self._presentations.get_by_scene(scene.id)
        if pres is None or pres.background_asset_id is None:
            raise NotFoundError("该场景尚未设置背景")
        asset = self._session.get(Asset, pres.background_asset_id)
        if asset is None:
            raise NotFoundError("背景资源不存在")
        data = self._storage.read(asset.storage_key)
        return data, asset.mime_type

    # ------------------------------------------------------------------ #
    # viewpoints
    # ------------------------------------------------------------------ #
    def list_viewpoints(
        self, slug_or_id: str, identity_user_id: uuid.UUID | None
    ) -> list[SceneViewpointOut]:
        scene = self._get_owned_scene_for_read(slug_or_id, identity_user_id)
        return [
            SceneViewpointOut(
                id=str(vp.id),
                name=vp.name,
                position=_json_to_vec3(vp.position) or Vec3(x=0, y=0, z=0),
                target=_json_to_vec3(vp.target) or Vec3(x=0, y=0, z=0),
                fov=vp.fov,
                orderIndex=vp.order_index,
                enabled=vp.enabled,
            )
            for vp in self._viewpoints.list_by_scene(scene.id)
        ]

    def create_viewpoint(
        self, slug_or_id: str, owner_id: uuid.UUID, body: SceneViewpointCreateRequest
    ) -> SceneViewpointOut:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        vp = SceneViewpoint(
            scene_id=scene.id,
            name=body.name.strip() or "未命名视角",
            position=_vec3_to_json(body.position),
            target=_vec3_to_json(body.target),
            fov=body.fov,
            order_index=self._viewpoints.next_order_index(scene.id),
            enabled=True,
        )
        self._viewpoints.add(vp)
        return SceneViewpointOut(
            id=str(vp.id),
            name=vp.name,
            position=body.position,
            target=body.target,
            fov=vp.fov,
            orderIndex=vp.order_index,
            enabled=vp.enabled,
        )

    def update_viewpoint(
        self,
        slug_or_id: str,
        owner_id: uuid.UUID,
        viewpoint_id: str,
        body: SceneViewpointUpdateRequest,
    ) -> SceneViewpointOut:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        try:
            vp_uuid = uuid.UUID(viewpoint_id)
        except ValueError:
            raise NotFoundError("视角不存在") from None
        vp = self._viewpoints.get_by_scene(scene.id, vp_uuid)
        if vp is None:
            raise NotFoundError("视角不存在")

        if body.name is not None:
            vp.name = body.name.strip() or "未命名视角"
        if body.position is not None:
            vp.position = _vec3_to_json(body.position)
        if body.target is not None:
            vp.target = _vec3_to_json(body.target)
        if body.fov is not None:
            fov = body.fov
            if fov < 10.0 or fov > 160.0:
                raise ConflictError("FOV 必须在 10-160 之间")
            vp.fov = fov
        if body.orderIndex is not None:
            vp.order_index = body.orderIndex
        if body.enabled is not None:
            vp.enabled = body.enabled
        self._session.flush()
        return SceneViewpointOut(
            id=str(vp.id),
            name=vp.name,
            position=_json_to_vec3(vp.position) or Vec3(x=0, y=0, z=0),
            target=_json_to_vec3(vp.target) or Vec3(x=0, y=0, z=0),
            fov=vp.fov,
            orderIndex=vp.order_index,
            enabled=vp.enabled,
        )

    def delete_viewpoint(self, slug_or_id: str, owner_id: uuid.UUID, viewpoint_id: str) -> None:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        try:
            vp_uuid = uuid.UUID(viewpoint_id)
        except ValueError:
            raise NotFoundError("视角不存在") from None
        vp = self._viewpoints.get_by_scene(scene.id, vp_uuid)
        if vp is None:
            raise NotFoundError("视角不存在")
        self._viewpoints.delete(vp)

    def reorder_viewpoints(
        self, slug_or_id: str, owner_id: uuid.UUID, body: SceneViewpointReorderRequest
    ) -> list[SceneViewpointOut]:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        existing = {str(vp.id): vp for vp in self._viewpoints.list_by_scene(scene.id)}
        if len(body.viewpointIds) != len(existing) or any(
            vp_id not in existing for vp_id in body.viewpointIds
        ):
            raise ConflictError("视角列表不完整，请刷新后重试")
        for index, vp_id in enumerate(body.viewpointIds):
            existing[vp_id].order_index = index + 1
        self._session.flush()
        return self.list_viewpoints(slug_or_id, owner_id)

    # ------------------------------------------------------------------ #
    # background audio
    # ------------------------------------------------------------------ #

    def update_background_audio(
        self,
        slug_or_id: str,
        owner_id: uuid.UUID,
        *,
        asset_id: str | None = None,
        volume: float | None = None,
        loop: bool | None = None,
        enabled: bool | None = None,
    ) -> ScenePresentationOut:
        """Update background audio settings on the presentation."""
        scene, pres = self._resolve_pres_for_edit(slug_or_id, owner_id)

        if asset_id is not None:
            if asset_id == "":
                pres.background_audio_asset_id = None
            else:
                try:
                    audio_uuid = uuid.UUID(asset_id)
                except ValueError:
                    raise ConflictError("无效的 backgroundAudioAssetId") from None
                asset = self._session.get(Asset, audio_uuid)
                if asset is None:
                    raise NotFoundError("音频资源不存在")
                if asset.scene_id != scene.id:
                    raise ForbiddenError("音频资源不属于该场景")
                pres.background_audio_asset_id = audio_uuid

        if volume is not None:
            pres.background_audio_volume = max(0.0, min(1.0, volume))

        if loop is not None:
            pres.background_audio_loop = loop

        if enabled is not None:
            pres.background_audio_enabled = enabled

        self._session.flush()
        return _presentation_out(pres, self._storage)

    def serve_background_audio(self, slug_or_id: str) -> tuple[bytes, str]:
        """Return background audio bytes + mime (or raise NotFound)."""
        from app.repositories.scenes import SceneRepository

        scene = SceneRepository(self._session).get_by_slug(slug_or_id)
        if scene is None:
            raise NotFoundError(f"场景 {slug_or_id} 不存在")
        pres = self._presentations.get_by_scene(scene.id)
        if pres is None or pres.background_audio_asset_id is None:
            raise NotFoundError("该场景尚未设置背景音频")
        asset = self._session.get(Asset, pres.background_audio_asset_id)
        if asset is None:
            raise NotFoundError("音频资源不存在")
        data = self._storage.read(asset.storage_key)
        return data, asset.mime_type

    # ------------------------------------------------------------------ #
    # annotations
    # ------------------------------------------------------------------ #

    def list_annotations(
        self, slug_or_id: str, identity_user_id: uuid.UUID | None
    ) -> list[SceneAnnotationOut]:
        scene = self._get_owned_scene_for_read(slug_or_id, identity_user_id)
        return [
            SceneAnnotationOut(
                id=str(a.id),
                title=a.title,
                description=a.description,
                anchorX=a.anchor_x,
                anchorY=a.anchor_y,
                anchorZ=a.anchor_z,
                style=a.style,
                contentType=a.content_type,
                textContent=a.text_content,
                mediaAssetId=str(a.media_asset_id) if a.media_asset_id else None,
                textColor=a.text_color,
                textSize=a.text_size,
                fov=a.fov,
                orderIndex=a.order_index,
                enabled=a.enabled,
            )
            for a in self._annotations.list_by_scene(scene.id)
        ]

    def create_annotation(
        self, slug_or_id: str, owner_id: uuid.UUID, body: SceneAnnotationCreateRequest
    ) -> SceneAnnotationOut:
        scene = self._get_owned_scene(slug_or_id, owner_id)

        # Validate style
        if body.style not in {"LEADER_TEXT", "NUMBER_POPUP", "HIDDEN"}:
            raise ConflictError(f"无效的注解样式: {body.style}")

        # Validate content type
        if body.contentType not in {"TEXT", "IMAGE", "VIDEO", "AUDIO", "PANORAMA"}:
            raise ConflictError(f"无效的内容类型: {body.contentType}")

        # Validate media asset if provided
        media_uuid: uuid.UUID | None = None
        if body.mediaAssetId is not None:
            try:
                media_uuid = uuid.UUID(body.mediaAssetId)
            except ValueError:
                raise ConflictError("无效的 mediaAssetId") from None
            asset = self._session.get(Asset, media_uuid)
            if asset is None:
                raise NotFoundError("媒体资源不存在")
            if asset.scene_id != scene.id:
                raise ForbiddenError("媒体资源不属于该场景")

        annotation = SceneAnnotation(
            scene_id=scene.id,
            title=body.title.strip(),
            description=body.description.strip(),
            anchor_x=body.anchorX,
            anchor_y=body.anchorY,
            anchor_z=body.anchorZ,
            style=body.style,
            content_type=body.contentType,
            text_content=body.textContent,
            media_asset_id=media_uuid,
            text_color=body.textColor,
            text_size=body.textSize,
            fov=body.fov,
            order_index=self._annotations.next_order_index(scene.id),
            enabled=True,
        )
        self._annotations.add(annotation)

        return SceneAnnotationOut(
            id=str(annotation.id),
            title=annotation.title,
            description=annotation.description,
            anchorX=annotation.anchor_x,
            anchorY=annotation.anchor_y,
            anchorZ=annotation.anchor_z,
            style=annotation.style,
            contentType=annotation.content_type,
            textContent=annotation.text_content,
            mediaAssetId=str(annotation.media_asset_id) if annotation.media_asset_id else None,
            textColor=annotation.text_color,
            textSize=annotation.text_size,
            fov=annotation.fov,
            orderIndex=annotation.order_index,
            enabled=annotation.enabled,
        )

    def update_annotation(
        self,
        slug_or_id: str,
        owner_id: uuid.UUID,
        annotation_id: str,
        body: SceneAnnotationUpdateRequest,
    ) -> SceneAnnotationOut:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        try:
            ann_uuid = uuid.UUID(annotation_id)
        except ValueError:
            raise NotFoundError("注解不存在") from None
        ann = self._annotations.get_by_scene(scene.id, ann_uuid)
        if ann is None:
            raise NotFoundError("注解不存在")

        if body.title is not None:
            ann.title = body.title.strip()
        if body.description is not None:
            ann.description = body.description.strip()
        if body.anchorX is not None:
            ann.anchor_x = body.anchorX
        if body.anchorY is not None:
            ann.anchor_y = body.anchorY
        if body.anchorZ is not None:
            ann.anchor_z = body.anchorZ
        if body.style is not None:
            if body.style not in {"LEADER_TEXT", "NUMBER_POPUP", "HIDDEN"}:
                raise ConflictError(f"无效的注解样式: {body.style}")
            ann.style = body.style
        if body.contentType is not None:
            if body.contentType not in {"TEXT", "IMAGE", "VIDEO", "AUDIO", "PANORAMA"}:
                raise ConflictError(f"无效的内容类型: {body.contentType}")
            ann.content_type = body.contentType
        if body.textContent is not None:
            ann.text_content = body.textContent
        if body.mediaAssetId is not None:
            if body.mediaAssetId == "":
                ann.media_asset_id = None
            else:
                try:
                    media_uuid = uuid.UUID(body.mediaAssetId)
                except ValueError:
                    raise ConflictError("无效的 mediaAssetId") from None
                asset = self._session.get(Asset, media_uuid)
                if asset is None:
                    raise NotFoundError("媒体资源不存在")
                if asset.scene_id != scene.id:
                    raise ForbiddenError("媒体资源不属于该场景")
                ann.media_asset_id = media_uuid
        if body.textColor is not None:
            ann.text_color = body.textColor
        if body.textSize is not None:
            ann.text_size = body.textSize
        if body.fov is not None:
            ann.fov = body.fov
        if body.orderIndex is not None:
            ann.order_index = body.orderIndex
        if body.enabled is not None:
            ann.enabled = body.enabled

        self._session.flush()

        return SceneAnnotationOut(
            id=str(ann.id),
            title=ann.title,
            description=ann.description,
            anchorX=ann.anchor_x,
            anchorY=ann.anchor_y,
            anchorZ=ann.anchor_z,
            style=ann.style,
            contentType=ann.content_type,
            textContent=ann.text_content,
            mediaAssetId=str(ann.media_asset_id) if ann.media_asset_id else None,
            textColor=ann.text_color,
            textSize=ann.text_size,
            fov=ann.fov,
            orderIndex=ann.order_index,
            enabled=ann.enabled,
        )

    def delete_annotation(self, slug_or_id: str, owner_id: uuid.UUID, annotation_id: str) -> None:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        try:
            ann_uuid = uuid.UUID(annotation_id)
        except ValueError:
            raise NotFoundError("注解不存在") from None
        ann = self._annotations.get_by_scene(scene.id, ann_uuid)
        if ann is None:
            raise NotFoundError("注解不存在")
        self._annotations.delete(ann)

    def reorder_annotations(
        self, slug_or_id: str, owner_id: uuid.UUID, body: SceneAnnotationReorderRequest
    ) -> list[SceneAnnotationOut]:
        scene = self._get_owned_scene(slug_or_id, owner_id)
        existing = {str(a.id): a for a in self._annotations.list_by_scene(scene.id)}
        if len(body.annotationIds) != len(existing) or any(
            a_id not in existing for a_id in body.annotationIds
        ):
            raise ConflictError("注解列表不完整，请刷新后重试")
        for index, a_id in enumerate(body.annotationIds):
            existing[a_id].order_index = index + 1
        self._session.flush()
        return self.list_annotations(slug_or_id, owner_id)
