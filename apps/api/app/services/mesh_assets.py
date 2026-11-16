"""Owner-scoped derived GLB lifecycle; original PLY remains authoritative."""

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from workers.meshing.asset_coordinates import (
    CONVERTER_VERSION,
    ORIENTATIONS,
    TRANSFORM_VERSION,
    recipe_key,
)

from app.core.errors import ConflictError, NotFoundError, ServiceUnavailableError
from app.db.models.mesh_asset_variant import MeshAssetVariant
from app.db.models.mesh_model import MeshModel
from app.schemas.mesh_asset import CreateMeshAsset
from app.services.mesh_models import MeshModelService


class MeshAssetService(MeshModelService):
    @staticmethod
    def output_variant(row):
        return {
            "retryable": row.status == "FAILED"
            or (
                row.status == "RUNNING"
                and row.lease_expires_at is not None
                and row.lease_expires_at < datetime.now(UTC)
            ),
            "id": str(row.id),
            "status": row.status,
            "format": row.format,
            "sourcePlySha256": row.source_ply_sha256,
            "sha256": row.sha256,
            "sizeBytes": row.size_bytes,
            "converterVersion": row.converter_version,
            "transformVersion": row.transform_version,
            "orientationEvidence": row.orientation_evidence,
            "rotation": row.rotation,
            "errorCode": row.error_code,
            "createdAt": row.created_at,
            "metadata": row.result,
            "downloadUrl": f"/api/v1/mesh-models/{row.mesh_model_id}/files/glb?variantId={row.id}"
            if row.status == "READY"
            else None,
        }

    def state(self, model_id, identity):
        model, _ = self.owned(model_id, identity)
        rows = self.db.scalars(
            select(MeshAssetVariant)
            .where(MeshAssetVariant.mesh_model_id == model.id)
            .order_by(MeshAssetVariant.created_at.desc())
        ).all()
        return {
            "eligible": model.units == "m",
            "reason": None
            if model.units == "m"
            else "原始 Mesh 的单位为 scene，缺少米制证据。保留原文件和单位，本次不缩放或冒充米制。",
            "orientationRequired": True,
            "orientations": [
                {"upAxis": key, "rotation": value} for key, value in ORIENTATIONS.items()
            ],
            "variants": [self.output_variant(row) for row in rows],
        }

    def submit(self, model_id, body: CreateMeshAsset, identity, send_task):
        self.owned(model_id, identity)
        model = self.db.scalar(select(MeshModel).where(MeshModel.id == model_id).with_for_update())
        if model.units != "m":
            raise ConflictError("Mesh 尚无米制证据，不能生成标准米制 GLB；原始文件保留。")
        if model.sha256 != body.sourcePlySha256:
            raise ConflictError("源 PLY 校验和已变化，请刷新")
        rotation = ORIENTATIONS[body.upAxis]
        key = hashlib.sha256(
            (str(model_id) + recipe_key(model.sha256, rotation)).encode()
        ).hexdigest()
        row = self.db.scalar(
            select(MeshAssetVariant).where(MeshAssetVariant.recipe_key == key).with_for_update()
        )
        dispatch = False
        if row is None:
            row = MeshAssetVariant(
                mesh_model_id=model_id,
                recipe_key=key,
                source_ply_sha256=model.sha256,
                rotation=rotation,
                converter_version=CONVERTER_VERSION,
                transform_version=TRANSFORM_VERSION,
                orientation_evidence={
                    "confirmedBy": str(identity.user_id),
                    "upAxis": body.upAxis,
                    "confirmedAt": datetime.now(UTC).isoformat(),
                    "method": "OWNER_AXIS_CONFIRMATION",
                },
                status="QUEUED",
            )
            self.db.add(row)
            dispatch = True
        elif row.status == "FAILED" or (
            row.status == "RUNNING"
            and row.lease_expires_at
            and row.lease_expires_at < datetime.now(UTC)
        ):
            row.status = "QUEUED"
            row.error_code = None
            dispatch = True
        self.db.commit()
        if dispatch:
            try:
                send_task("tasks.convert_mesh_asset", args=[str(row.id)])
            except Exception as exc:
                row.status = "FAILED"
                row.error_code = "DISPATCH_FAILED"
                self.db.commit()
                raise ServiceUnavailableError("GLB 转换队列暂不可用，请重试") from exc
        return self.output_variant(row)

    def glb_file(self, model_id, identity, variant_id=None):
        model, _ = self.owned(model_id, identity)
        query = select(MeshAssetVariant).where(
            MeshAssetVariant.mesh_model_id == model.id, MeshAssetVariant.status == "READY"
        )
        if variant_id:
            query = query.where(MeshAssetVariant.id == variant_id)
        row = self.db.scalar(query.order_by(MeshAssetVariant.created_at.desc()).limit(1))
        if not row or not row.storage_key:
            raise NotFoundError("GLB 尚未生成完成")
        root = (Path(self.settings.storage_root) / "mesh-assets" / str(model.id)).resolve()
        path = (Path(self.settings.storage_root) / row.storage_key).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise NotFoundError("GLB 文件不可用")
        return path, row
