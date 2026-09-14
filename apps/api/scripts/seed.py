"""Seed the dev database with the five real local scenes.

Populates ``gsplatform`` (never the test DB) with the scenes backed by the
git-ignored ``scenes/`` tree, so the public homepage has real rows served by
the actual API. Idempotent: re-running replaces the same rows by slug.

The five scenes map 1:1 to directories under ``/fj/GSPlatform/scenes/``:

- stream-small / stream-medium / stream-large : streamed-SOG (versions tree)
- local-garden / progressive-test              : classic SOG with LOD tiers

Run from ``apps/api``:

    GS_DATABASE_URL=postgresql+psycopg2://postgres@127.0.0.1:5432/gsplatform \
        python -m scripts.seed
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models.enums import Visibility
from app.db.models.scene import Scene, SceneVersion
from app.db.models.user import User
from app.db.session import SessionLocal

# ---------------------------------------------------------------------------
# Seed definition — mirrors the real manifests in /fj/GSPlatform/scenes/**
# ---------------------------------------------------------------------------

# (slug, title, description, category, splat_count, size_bytes)
# splat_count / size_bytes come from the source SOG assets:
#   stream-*: high-tier count + total version-tree size
_SCENES: list[tuple[str, str, str, str, int | None, int | None]] = [
    (
        "stream-small",
        "流式小场景（低负载示例）",
        "三个 LOD 层级、~2.4 万高斯的流式 SOG 小场景，用于验证 Range 请求与渐进加载。",
        "architecture",
        23_760,
        286_684,
    ),
    (
        "stream-medium",
        "流式中等场景",
        "~5.9 万高斯的流式 SOG 中等场景，覆盖爪排序数量中等时的加载曲线。",
        "urban",
        59_400,
        770_642,
    ),
    (
        "stream-large",
        "流式大场景（高负载示例）",
        "~17.6 万高斯的流式 SOG 大场景，验证大规模 chunk 调度与内存边界。",
        "nature",
        176_418,
        2_254_615,
    ),
    (
        "local-garden",
        "示例庭院",
        "经典 SOG 单资产场景（scene.sog），Phase 02 起作为 Viewer 默认场景使用。",
        "interior",
        None,
        18_809,
    ),
    (
        "progressive-test",
        "渐进加载测试场景",
        "low/medium/high 三档 LOD 的 SOG 场景，来源为包含 5.94 万高斯的扫描点云。",
        "experiment",
        59_400,
        292_618,
    ),
]

# Manifest content is stored verbatim on SceneVersion.manifest for the API
# to serve back as business URLs; only the externally visible fields are
# declared here, matching each scene's real manifest.json.
_MANIFESTS: dict[str, dict] = {
    "stream-small": {
        "schemaVersion": 1,
        "sceneId": "stream-small",
        "assetVersion": "b013bcb8741c",
        "format": "streamed-sog",
        "stream": {
            "entryUrl": "versions/b013bcb8741c/lod-meta.json",
            "byteLength": 2961,
            "sha256": "b013bcb8741c79b5c2a46db473a8b5e2677c7b2509a277bf81eb42a23d4a173c",
            "transport": "range",
            "lodLevels": 3,
            "counts": [2376, 7128, 23760],
        },
    },
    "stream-medium": {
        "schemaVersion": 1,
        "sceneId": "stream-medium",
        "assetVersion": "320ed57f6098",
        "format": "streamed-sog",
        "stream": {
            "entryUrl": "versions/320ed57f6098/lod-meta.json",
            "byteLength": 11586,
            "sha256": "320ed57f6098fdcec32a2e0cfec665a78cc74bc3cbe6a7088ca8c654d732cf29",
            "transport": "range",
            "lodLevels": 3,
            "counts": [5940, 17820, 59400],
        },
    },
    "stream-large": {
        "schemaVersion": 1,
        "sceneId": "stream-large",
        "assetVersion": "8940e6486ff0",
        "format": "streamed-sog",
        "stream": {
            "entryUrl": "versions/8940e6486ff0/lod-meta.json",
            "byteLength": 23373,
            "sha256": "8940e6486ff0fa35ba05e8c96ccaf780d5015c4cdd30eddc58cdbc31a7aa1dce",
            "transport": "range",
            "lodLevels": 3,
            "counts": [17642, 52925, 176418],
        },
    },
    "local-garden": {
        "id": "local-garden",
        "title": "示例庭院",
        "format": "sog",
        "assetUrl": "/local-scenes/local-garden/scene.sog",
        "posterUrl": "/local-scenes/local-garden/poster.webp",
        "sha256": "f6d87e67dc76e7af93f9ec899a98ef2b4d01cbb633e15cf325ce7be503e5fb29",
    },
    "progressive-test": {
        "id": "progressive-test",
        "title": "渐进加载测试场景",
        "format": "sog",
        "sha256": "f68200c27c6346cf9e617954cdd6c4cbdf554126f80911125511078293940223",
        "sourceSize": 14732730,
        "sourceGaussians": 59400,
        "lod": [
            {
                "level": "low",
                "assetUrl": "low.sog",
                "gaussians": 5940,
                "size": 75460,
                "sha256": "1e255bf74c472bd30d169126e52794d78edbb26afd786b00e8ad4cc9ea3e61f3",
            },
            {
                "level": "medium",
                "assetUrl": "medium.sog",
                "gaussians": 20800,
                "size": 207414,
                "sha256": "47c69af6127a0811c8deb5ae40dedd497fcfcee55f2a5868d0b7c027d0bd9c36",
            },
            {
                "level": "high",
                "assetUrl": "high.sog",
                "gaussians": 59400,
                "size": 292618,
                "sha256": "393bb062f2bf45fcf8ecb66316f99759ffe05d9a70d8e831699829e79cc49962",
            },
        ],
    },
}

# Asset keys served to the format shown to the viewer; manifest version string
# is the immutable SceneVersion.asset_version.
_VERSION_IDS: dict[str, str] = {
    "stream-small": "b013bcb8741c",
    "stream-medium": "320ed57f6098",
    "stream-large": "8940e6486ff0",
    "local-garden": "f6d87e67dc76e7af",  # shortened sha256 prefix
    "progressive-test": "393bb062f2bf45fc",
}


def _ensure_dev_user(session) -> User:
    """Return the fixed dev user (same as the dev-identity bypass)."""
    from app.core.identity import DEV_USER_DISPLAY_NAME, DEV_USER_EMAIL

    user = session.execute(
        select(User).where(User.email == DEV_USER_EMAIL)
    ).scalar_one_or_none()
    if user is None:
        user = User(email=DEV_USER_EMAIL, display_name=DEV_USER_DISPLAY_NAME)
        session.add(user)
        session.flush()
    return user


def seed() -> None:
    if settings.database_url.endswith("gsplatform_test"):
        raise RuntimeError(
            "Refusing to seed the test database; point GS_DATABASE_URL at gsplatform."
        )

    with SessionLocal() as session:
        # Idempotent: drop rows for the slugs we manage, then recreate.
        slugs = [slug for slug, *_ in _SCENES]
        existing_ids = session.execute(
            select(Scene.id).where(Scene.slug.in_(slugs))
        ).scalars().all()
        if existing_ids:
            session.execute(delete(SceneVersion).where(SceneVersion.scene_id.in_(existing_ids)))
            session.execute(delete(Scene).where(Scene.id.in_(existing_ids)))
            session.flush()

        owner = _ensure_dev_user(session)
        now = datetime.now(UTC)

        for slug, title, description, category, splat_count, size_bytes in _SCENES:
            scene = Scene(
                id=uuid.uuid4(),
                owner_id=owner.id,
                slug=slug,
                title=title,
                description=description,
                category=category,
                visibility=Visibility.PUBLIC.value,
                status="PUBLISHED",
                splat_count=splat_count,
                size_bytes=size_bytes,
                views=1_000 + len(slugs) * 100,  # plausible demo counters
                likes=100,
                created_at=now,
                updated_at=now,
                published_at=now,
            )
            session.add(scene)
            session.flush()

            manifest = _MANIFESTS[slug]
            asset_version = _VERSION_IDS[slug]
            version = SceneVersion(
                id=uuid.uuid4(),
                scene_id=scene.id,
                asset_version=asset_version,
                format="streamed-sog" if slug.startswith("stream-") else "sog",
                size_bytes=size_bytes or 0,
                sha256=(
                    manifest.get("stream", {}).get("sha256")
                    if slug.startswith("stream-")
                    else manifest.get("sha256")
                ),
                manifest=manifest,
                created_at=now,
            )
            session.add(version)
            session.flush()

            scene.current_version_id = version.id

        session.commit()
        print(f"Seeded {len(slugs)} scenes for owner {owner.email} ({settings.database_url})")


if __name__ == "__main__":
    seed()
