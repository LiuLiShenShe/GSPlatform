"""API v1 router — aggregates all v1 endpoint routers."""

from fastapi import APIRouter

from app.api.v1 import jobs, me, scenes, uploads

v1_router = APIRouter(prefix="/api/v1")
v1_router.include_router(scenes.router, prefix="/scenes", tags=["Scenes"])
v1_router.include_router(me.router, prefix="/me", tags=["My Work"])
v1_router.include_router(jobs.router, prefix="/jobs", tags=["Jobs"])
v1_router.include_router(uploads.router, prefix="/uploads", tags=["Uploads"])
