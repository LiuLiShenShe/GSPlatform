"""Scene runtime descriptor assembly (SSV-01).

Builds :class:`SceneRuntimeDescriptorV1` from the existing DB models
(Scene, SceneVersion, ScenePresentation, SceneViewpoint, SceneAnnotation,
CollisionAsset). All values are read-only projections; no new DB fields are
introduced. Content URLs are always viewer-accessible same-origin URLs
(``/local-scenes/...`` or ``/api/...``) — never server-local filesystem paths.

Access control mirrors the scene read rules:
  - owner → allowed;
  - ``PUBLIC`` + (``PUBLISHED``/``READY``) → allowed for anyone;
  - exists but not accessible + anonymous → 401 (login required);
  - exists but not accessible + other user → 403;
  - missing → 404.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.errors import ForbiddenError, NotFoundError, UnauthorizedError
from app.core.identity import RequestIdentity
from app.db.models.asset import Asset
from app.db.models.enums import AssetKind
from app.db.models.scene import Scene, SceneVersion
from app.repositories.authoring import (
    SceneAnnotationRepository,
    ScenePresentationRepository,
    SceneViewpointRepository,
)
from app.repositories.collision import CollisionAssetRepository
from app.repositories.scenes import SceneRepository
from app.schemas.scene_runtime import (
    RuntimeAnnotation,
    RuntimeBackground,
    RuntimeBackgroundAudio,
    RuntimeCollision,
    RuntimeContentOut,
    RuntimeInitialCamera,
    RuntimePresentation,
    RuntimeSceneOut,
    RuntimeVec3,
    RuntimeViewpoint,
    RuntimeWorldTransform,
    SceneRuntimeDescriptorV1,
)

# Business URL prefixes produced by the serving layer. Never filesystem paths.
SCENE_ASSET_BASE = "/local-scenes/{slug}"
PRESENTATION_SERVE_BASE = "/api/v1/scenes/{slug}"
COLLISION_SERVE_BASE = "/api/v1/scenes/{slug}/collision"

# Default on-disk filenames for single-file published versions, by version
# format. Used only as a last-resort fallback (no manifest assetUrl, no SOG
# asset row) — DB publishes are streamed (lod-meta).
_SINGLE_FILE_DEFAULTS = {
    "sog": "scene.sog",
    "ply": "scene.ply",
    "splat": "scene.splat",
}


def _vec3(raw: Any) -> RuntimeVec3 | None:
    """Coerce a JSONB ``{x, y, z}`` blob (or list) to RuntimeVec3, or None."""
    if raw is None:
        return None
    if isinstance(raw, dict):
        try:
            return RuntimeVec3(
                x=float(raw["x"]), y=float(raw["y"]), z=float(raw["z"])
            )
        except (KeyError, TypeError, ValueError):
            return None
    if isinstance(raw, (list, tuple)) and len(raw) == 3:
        try:
            return RuntimeVec3(x=float(raw[0]), y=float(raw[1]), z=float(raw[2]))
        except (TypeError, ValueError):
            return None
    return None


def _post_effects_json(raw: Any) -> dict[str, Any] | None:
    """Normalise a stored post-effects document to the official shape.

    The official ``postEffectSettings`` object has five effects, each with a
    fixed field set. Anything missing (older scenes, partially authored docs)
    falls back to the official defaults, so the front-end adapter can pass the
    result straight to ``validateSettings(settings, { limits: true })``.
    Returns None when the document is not usable at all.
    """
    if not isinstance(raw, dict):
        return None

    def merged(
        name: str, defaults: dict[str, Any]
    ) -> dict[str, Any]:
        """Official defaults for `name`, overridden by whatever was stored."""
        base = {"enabled": False, **defaults}
        value = raw.get(name)
        if not isinstance(value, dict):
            return base
        out: dict[str, Any] = {"enabled": bool(value.get("enabled", False))}
        for key, default in defaults.items():
            num = value.get(key, default)
            try:
                out[key] = type(default)(num)  # type: ignore[call-overload]
            except (TypeError, ValueError):
                out[key] = default
        return out

    return {
        "sharpness": merged("sharpness", {"amount": 0.0}),
        "bloom": merged("bloom", {"intensity": 1.0, "blurLevel": 2.0}),
        "grading": _grading(raw),
        "vignette": merged(
            "vignette",
            {"intensity": 0.5, "inner": 0.3, "outer": 0.75, "curvature": 1.0},
        ),
        "fringing": merged("fringing", {"intensity": 0.5}),
    }


def _grading(raw: dict[str, Any]) -> dict[str, Any]:
    """Grading with a validated 3-tuple tint (official default [1,1,1])."""
    out = {
        "enabled": False,
        "brightness": 1.0,
        "contrast": 1.0,
        "saturation": 1.0,
        "tint": [1.0, 1.0, 1.0],
    }
    value = raw.get("grading")
    if not isinstance(value, dict):
        return out
    out["enabled"] = bool(value.get("enabled", False))
    for key in ("brightness", "contrast", "saturation"):
        num = value.get(key)
        if isinstance(num, (int, float)):
            out[key] = float(num)
    tint = value.get("tint")
    if isinstance(tint, (list, tuple)) and len(tint) == 3:
        try:
            out["tint"] = [float(c) for c in tint]
        except (TypeError, ValueError):
            out["tint"] = [1.0, 1.0, 1.0]
    return out


def content_format_from_filename(name: str) -> str | None:
    """Map an asset filename to a runtime content format.

    Order matters: ``.lod-meta.json`` before ``.meta.json``, and
    ``.compressed.ply`` before ``.ply``.

    Recognised: ``.sog`` → sog, ``.ply`` → ply, ``.compressed.ply`` →
    compressed-ply, ``.meta.json`` → meta, ``.lod-meta.json`` → lod-meta.
    """
    lowered = (name or "").lower()
    if lowered.endswith(".lod-meta.json"):
        return "lod-meta"
    if lowered.endswith(".meta.json"):
        return "meta"
    if lowered.endswith(".compressed.ply"):
        return "compressed-ply"
    if lowered.endswith(".sog"):
        return "sog"
    if lowered.endswith(".ply"):
        return "ply"
    return None


class SceneRuntimeService:
    """Assembles the unified runtime descriptor for one scene."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._scenes = SceneRepository(session)
        self._presentations = ScenePresentationRepository(session)
        self._viewpoints = SceneViewpointRepository(session)
        self._annotations = SceneAnnotationRepository(session)
        self._collisions = CollisionAssetRepository(session)

    # ------------------------------------------------------------------ #
    # access control
    # ------------------------------------------------------------------ #
    def _resolve_readable_scene(
        self, slug_or_id: str, identity: RequestIdentity | None
    ) -> Scene:
        scene = self._scenes.get_by_slug(slug_or_id)
        if scene is None:
            try:
                scene = self._scenes.get_by_id(uuid.UUID(slug_or_id))
            except ValueError:
                scene = None
        if scene is None:
            raise NotFoundError(f"场景 {slug_or_id} 不存在")

        user_id = identity.user_id if identity is not None else None
        if user_id is not None and scene.owner_id == user_id:
            return scene
        if scene.status in {"PUBLISHED", "READY"} and scene.visibility == "PUBLIC":
            return scene

        # The scene exists but is not readable by this caller.
        if identity is None:
            raise UnauthorizedError("该场景需要登录后访问")
        raise ForbiddenError("该场景不可见或未发布")

    # ------------------------------------------------------------------ #
    # content
    # ------------------------------------------------------------------ #
    def _content_url(self, scene: Scene, url: str) -> str:
        """Normalise a relative asset reference to a same-origin URL."""
        if url.startswith(("http://", "https://", "/")):
            return url
        relative = url.lstrip("/")
        while relative.startswith("./"):
            relative = relative[2:]
        return f"{SCENE_ASSET_BASE.format(slug=scene.slug)}/{relative}"

    def _resolve_content(
        self, scene: Scene, version: SceneVersion | None
    ) -> RuntimeContentOut:
        """Resolve the loadable content URL + format for a scene version.

        Streamed versions resolve to their ``lod-meta.json`` entry (from the
        version manifest's ``stream.entryUrl``, else the well-known
        ``current/lod-meta.json``). Single-file versions resolve to the asset
        itself. The format comes from the actual asset filename — never from
        ``schemaVersion``.
        """
        if version is None:
            return RuntimeContentOut(url=None, format=None)

        manifest = version.manifest or {}
        version_format = version.format
        manifest_format = manifest.get("format")

        # Streamed SOG: the Viewer loads the lod-meta.json entry container.
        if version_format == "streamed-sog" or manifest_format == "streamed-sog":
            stream = manifest.get("stream")
            entry = stream.get("entryUrl") if isinstance(stream, dict) else None
            if isinstance(entry, str) and entry:
                url = self._content_url(scene, entry)
            else:
                url = f"{SCENE_ASSET_BASE.format(slug=scene.slug)}/current/lod-meta.json"
            return RuntimeContentOut(url=url, format="lod-meta")

        # Single-file: prefer the manifest's assetUrl, then the on-disk
        # filename of the version's SOG asset, then a format default.
        asset_url = manifest.get("assetUrl")
        if isinstance(asset_url, str) and asset_url:
            url = self._content_url(scene, asset_url)
        else:
            name = None
            asset_row = (
                self._session.query(Asset)
                .filter(
                    Asset.scene_id == scene.id,
                    Asset.version_id == version.id,
                    Asset.kind == "SOG",
                )
                .first()
            )
            if asset_row is not None:
                name = asset_row.storage_key.rstrip("/").split("/")[-1]
            else:
                name = _SINGLE_FILE_DEFAULTS.get(version_format)
            if name is None:
                return RuntimeContentOut(url=None, format=None)
            url = f"{SCENE_ASSET_BASE.format(slug=scene.slug)}/current/{name}"

        filename = url.rsplit("/", 1)[-1] if url else ""
        return RuntimeContentOut(url=url, format=content_format_from_filename(filename))

    # ------------------------------------------------------------------ #
    # descriptor
    # ------------------------------------------------------------------ #
    def get_descriptor(
        self, slug_or_id: str, identity: RequestIdentity | None
    ) -> SceneRuntimeDescriptorV1:
        scene = self._resolve_readable_scene(slug_or_id, identity)
        version = scene.current_version

        scene_block = RuntimeSceneOut(
            id=scene.slug,
            name=scene.title,
            posterUrl=f"{SCENE_ASSET_BASE.format(slug=scene.slug)}/poster.webp",
        )
        content = self._resolve_content(scene, version)
        presentation = self._build_presentation(scene)
        viewpoints = self._build_viewpoints(scene)
        annotations = self._build_annotations(scene)
        background_audio = self._build_background_audio(scene)
        collision = self._build_collision(scene)

        return SceneRuntimeDescriptorV1(
            schemaVersion=1,
            scene=scene_block,
            content=content,
            presentation=presentation,
            viewpoints=viewpoints,
            annotations=annotations,
            backgroundAudio=background_audio,
            collision=collision,
        )

    def _build_presentation(self, scene: Scene) -> RuntimePresentation:
        pres = self._presentations.get_by_scene(scene.id)
        if pres is None:
            return RuntimePresentation(
                worldTransform=RuntimeWorldTransform(),
                initialCamera=RuntimeInitialCamera(),
                background=RuntimeBackground(),
            )

        background_url = None
        if pres.background_type == "equirectangular" and pres.background_asset_id:
            base = PRESENTATION_SERVE_BASE.format(slug=scene.slug)
            background_url = f"{base}/presentation/background"

        post_effects = (
            _post_effects_json(pres.post_effects)
            if pres.post_effects
            else None
        )

        return RuntimePresentation(
            worldTransform=RuntimeWorldTransform(
                position=_vec3(pres.world_position),
                rotation=_vec3(pres.world_rotation),
                scale=_vec3(pres.world_scale),
            ),
            initialCamera=RuntimeInitialCamera(
                position=_vec3(pres.initial_camera_position),
                target=_vec3(pres.initial_camera_target),
                fov=pres.initial_camera_fov,
            ),
            background=RuntimeBackground(
                type=pres.background_type,
                color=_vec3(pres.background_color),
                url=background_url,
            ),
            tonemapping=pres.tonemapping,
            highPrecisionRendering=pres.high_precision_rendering,
            postEffects=post_effects,
        )

    def _build_viewpoints(self, scene: Scene) -> list[RuntimeViewpoint]:
        return [
            RuntimeViewpoint(
                id=str(vp.id),
                name=vp.name,
                position=_vec3(vp.position) or RuntimeVec3(x=0, y=0, z=0),
                target=_vec3(vp.target) or RuntimeVec3(x=0, y=0, z=0),
                fov=vp.fov,
                orderIndex=vp.order_index,
                enabled=vp.enabled,
            )
            for vp in self._viewpoints.list_by_scene(scene.id)
        ]

    def _build_annotations(self, scene: Scene) -> list[RuntimeAnnotation]:
        base = PRESENTATION_SERVE_BASE.format(slug=scene.slug)
        return [
            RuntimeAnnotation(
                id=str(ann.id),
                title=ann.title,
                description=ann.description,
                anchor=RuntimeVec3(x=ann.anchor_x, y=ann.anchor_y, z=ann.anchor_z),
                style=ann.style,
                contentType=ann.content_type,
                textContent=ann.text_content,
                mediaAssetUrl=(
                    f"{base}/annotations/{ann.id}/media" if ann.media_asset_id else None
                ),
                textColor=ann.text_color,
                textSize=ann.text_size,
                fov=ann.fov,
                orderIndex=ann.order_index,
                enabled=ann.enabled,
            )
            for ann in self._annotations.list_by_scene(scene.id)
        ]

    def _build_background_audio(self, scene: Scene) -> RuntimeBackgroundAudio | None:
        pres = self._presentations.get_by_scene(scene.id)
        if pres is None or pres.background_audio_asset_id is None:
            return None
        if not pres.background_audio_enabled:
            return None
        return RuntimeBackgroundAudio(
            url=f"{PRESENTATION_SERVE_BASE.format(slug=scene.slug)}/presentation/background-audio",
            volume=pres.background_audio_volume,
            loop=pres.background_audio_loop,
            enabled=pres.background_audio_enabled,
        )

    def _build_collision(self, scene: Scene) -> RuntimeCollision | None:
        collision = self._collisions.get_by_scene_id(scene.id)
        if collision is None or collision.asset_id is None or collision.status != "SUCCEEDED":
            return None
        base = COLLISION_SERVE_BASE.format(slug=scene.slug)
        asset = self._session.get(Asset, collision.asset_id)
        # The official viewer selects mesh-vs-voxel by the url extension, so the
        # emitted url must end in .glb / .voxel.json. Voxel (native octree) is
        # preferred when present; the GLB stays as the mesh fallback.
        if asset is not None and asset.kind == AssetKind.COLLISION_VOXEL.value:
            url, fmt = f"{base}/collision.voxel.json", "voxel"
        elif asset is not None and asset.kind == AssetKind.COLLISION_GLB.value:
            url, fmt = f"{base}/collision.glb", "glb"
        else:
            # Legacy single-asset layout (pre-SSV-07): serve under the contract
            # url; the official viewer still loads it as mesh (ext 'glb').
            url, fmt = f"{base}/mesh", "glb"
        pres = self._presentations.get_by_scene(scene.id)
        enabled = pres.collision_enabled if pres is not None else False
        return RuntimeCollision(
            url=url,
            format=fmt,
            mode=collision.mode,
            gravity=collision.gravity,
            slopeLimitDegrees=collision.slope_limit_degrees,
            stepOffset=collision.step_offset,
            playerHeight=collision.player_height,
            enabled=enabled,
        )
