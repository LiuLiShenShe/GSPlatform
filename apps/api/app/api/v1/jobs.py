"""Job endpoints — owner-gated reads."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from starlette.responses import FileResponse

from app.core.identity import RequestIdentity, get_current_user
from app.db.session import get_db_session
from app.schemas.job import JobOut
from app.services.jobs import JobService

router = APIRouter()


@router.get("/{job_id}", response_model=JobOut)
def get_job(
    job_id: str,
    identity: RequestIdentity = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> JobOut:
    """查询任务详情，仅任务所有者可访问。"""
    return JobService(db).get_owned(uuid.UUID(job_id), identity.user_id)


@router.get("/{job_id}/segmentation")
def get_segmentation(
    job_id: uuid.UUID,
    identity: RequestIdentity = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> dict:
    import json
    from pathlib import Path

    from app.core.config import get_settings
    from app.core.errors import NotFoundError
    from app.repositories.jobs import JobRepository

    job = JobRepository(db).get_owned(job_id, identity.user_id)
    if job is None or job.kind != "RECONSTRUCT":
        raise NotFoundError("重建任务不存在")
    directory = (
        Path(get_settings().storage_root)
        / "jobs"
        / str(job_id)
        / f"attempt-{job.attempt}"
        / "segmentation"
    )
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return {"ready": False, "frames": []}
    manifest = json.loads(manifest_path.read_text())
    frames = manifest["frames"]
    selected = sorted({0, len(frames) // 2, len(frames) - 1}) if frames else []
    return {
        "ready": True,
        "validViews": manifest["validViews"],
        "totalViews": len(frames),
        "prompt": manifest["prompt"],
        "frames": [
            {
                "name": frames[i]["name"],
                "coverage": frames[i]["coverage"],
                "instances": frames[i]["instances"],
                "previewUrl": (
                    f"/api/v1/jobs/{job_id}/segmentation/previews/{frames[i]['name']}.webp"
                ),
            }
            for i in selected
        ],
    }


@router.get("/{job_id}/segmentation/previews/{name}")
def get_segmentation_preview(
    job_id: uuid.UUID,
    name: str,
    identity: RequestIdentity = Depends(get_current_user),
    db: Session = Depends(get_db_session),
) -> FileResponse:
    from pathlib import Path

    from app.core.config import get_settings
    from app.core.errors import NotFoundError
    from app.repositories.jobs import JobRepository

    job = JobRepository(db).get_owned(job_id, identity.user_id)
    if job is None or job.kind != "RECONSTRUCT" or Path(name).name != name:
        raise NotFoundError("分割预览不存在")
    directory = (
        Path(get_settings().storage_root)
        / "jobs"
        / str(job_id)
        / f"attempt-{job.attempt}"
        / "segmentation/previews"
    )
    path = directory / name
    if (
        path.suffix != ".webp"
        or not path.is_file()
        or not path.resolve().is_relative_to(directory.resolve())
    ):
        raise NotFoundError("分割预览不存在")
    return FileResponse(
        path, media_type="image/webp", headers={"Cache-Control": "private, no-store"}
    )
