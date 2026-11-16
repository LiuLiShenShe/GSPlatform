"""Private, persistent model library; finished meshes retain their source version."""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import NotFoundError
from app.core.identity import RequestIdentity
from app.db.models.job import Job
from app.db.models.mesh_model import MeshModel
from app.db.models.scene import Scene
from app.schemas.mesh_model import MeshModelList, MeshModelOut


def register_mesh(
    db: Session, settings: Settings, scene: Scene, job: Job, metadata: dict[str, Any]
) -> MeshModel:
    """Called within the fenced success transaction, also safe for old job backfills."""
    existing = db.scalar(select(MeshModel).where(MeshModel.job_id == job.id))
    if existing:
        return existing
    key = f"meshes/{scene.id}/{job.id}/mesh.ply"
    path = Path(settings.storage_root) / key
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if metadata.get("sha256") and metadata["sha256"] != digest:
        raise ValueError("Mesh checksum mismatch")
    row = MeshModel(
        owner_id=job.owner_id,
        scene_id=scene.id,
        source_version_id=uuid.UUID(job.task_parameters["sourceVersionId"]),
        job_id=job.id,
        title=f"{scene.title[:230]} · Mesh",
        algorithm="2dgs-tsdf" if job.task_parameters["algorithm"] == "2dgs" else "nksr",
        units=metadata["units"],
        vertices=metadata["vertices"],
        faces=metadata["faces"],
        size_bytes=path.stat().st_size,
        sha256=digest,
        storage_key=key,
        provenance={
            "reconstructionJobId": job.task_parameters["reconstructionJobId"],
            "scaleFactor": job.task_parameters["scaleFactor"],
            "editedGeometry": job.task_parameters.get("editedGeometry", False),
        },
    )
    db.add(row)
    db.flush()
    return row


class MeshModelService:
    def __init__(self, db: Session, settings: Settings) -> None:
        self.db, self.settings = db, settings

    def output(self, row: MeshModel, scene: Scene) -> MeshModelOut:
        from app.db.models.mesh_asset_variant import MeshAssetVariant

        status = self.db.scalar(
            select(MeshAssetVariant.status)
            .where(MeshAssetVariant.mesh_model_id == row.id)
            .order_by(
                (MeshAssetVariant.status == "READY").desc(), MeshAssetVariant.created_at.desc()
            )
            .limit(1)
        )
        return MeshModelOut(
            glbStatus=status or ("NEEDS_METRIC_EVIDENCE" if row.units != "m" else "NOT_GENERATED"),
            id=row.id,
            title=row.title,
            sceneId=scene.id,
            sceneSlug=scene.slug,
            sceneTitle=scene.title,
            sourceVersionId=row.source_version_id,
            isCurrentSource=scene.current_version_id == row.source_version_id,
            algorithm=row.algorithm,
            units=row.units,
            vertices=row.vertices,
            faces=row.faces,
            sizeBytes=row.size_bytes,
            sha256=row.sha256,
            createdAt=row.created_at,
            jobId=row.job_id,
            downloadUrl=f"/api/v1/mesh-models/{row.id}/file",
            previewUrl=f"/meshes/{row.id}",
        )

    def list(
        self,
        identity: RequestIdentity,
        *,
        q: str = "",
        algorithm: str | None = None,
        sort: str = "created",
        page: int = 1,
        page_size: int = 24,
    ) -> MeshModelList:
        filters = [
            MeshModel.owner_id == identity.user_id,
            Scene.owner_id == identity.user_id,
            Scene.deleted_at.is_(None),
        ]
        if q.strip():
            query = (
                "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            )
            filters.append(
                or_(
                    MeshModel.title.ilike(query, escape="\\"), Scene.title.ilike(query, escape="\\")
                )
            )
        if algorithm:
            filters.append(MeshModel.algorithm == algorithm)
        total = (
            self.db.scalar(select(func.count()).select_from(MeshModel).join(Scene).where(*filters))
            or 0
        )
        order = (
            [MeshModel.title.asc(), MeshModel.id]
            if sort == "title"
            else [MeshModel.created_at.desc(), MeshModel.id.desc()]
        )
        rows = (
            self.db.execute(
                select(MeshModel, Scene)
                .join(Scene)
                .where(*filters)
                .order_by(*order)
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            .unique()
            .all()
        )
        return MeshModelList(
            items=[self.output(row, scene) for row, scene in rows],
            total=total,
            page=page,
            pageSize=page_size,
        )

    def owned(self, model_id: uuid.UUID, identity: RequestIdentity) -> tuple[MeshModel, Scene]:
        found = (
            self.db.execute(
                select(MeshModel, Scene)
                .join(Scene)
                .where(
                    MeshModel.id == model_id,
                    MeshModel.owner_id == identity.user_id,
                    Scene.owner_id == identity.user_id,
                    Scene.deleted_at.is_(None),
                )
            )
            .unique()
            .first()
        )
        if found is None:
            raise NotFoundError("Mesh 模型不存在或无权查看")
        return found[0], found[1]

    def file(self, model_id: uuid.UUID, identity: RequestIdentity) -> tuple[Path, MeshModel]:
        row, _ = self.owned(model_id, identity)
        root = Path(self.settings.storage_root).resolve()
        path = (root / row.storage_key).resolve()
        if not path.is_relative_to(root / "meshes") or not path.is_file():
            raise NotFoundError("Mesh 文件不可用")
        return path, row
