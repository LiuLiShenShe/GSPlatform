"""API v1 router — aggregates all v1 endpoint routers."""

from fastapi import APIRouter

from app.api.v1 import (
    assistant,
    auth,
    compute,
    favorites,
    jobs,
    me,
    scenes,
    shares,
    uploads,
)

v1_router = APIRouter(prefix="/api/v1")
v1_router.include_router(auth.router, prefix="/auth", tags=["Auth"])
v1_router.include_router(scenes.router, prefix="/scenes", tags=["Scenes"])
v1_router.include_router(me.router, prefix="/me", tags=["My Work"])
v1_router.include_router(jobs.router, prefix="/jobs", tags=["Jobs"])
v1_router.include_router(uploads.router, prefix="/uploads", tags=["Uploads"])
v1_router.include_router(compute.router, prefix="/compute", tags=["Compute"])
v1_router.include_router(favorites.router, prefix="/favorites", tags=["Favorites"])
v1_router.include_router(shares.router, prefix="/shares", tags=["Shares"])
v1_router.include_router(assistant.router, prefix="/assistant", tags=["Assistant"])
