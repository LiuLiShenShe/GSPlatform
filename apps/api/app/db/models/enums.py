"""Domain enums as plain str values with CHECK constraints.

Stored as strings with explicit check constraints (per Phase 05 guidance) so
allowed values evolve via explicit migrations instead of PG enum rewrites.
"""

from __future__ import annotations

import enum


class SceneStatus(enum.StrEnum):
    DRAFT = "DRAFT"
    VALIDATING = "VALIDATING"
    PROCESSING = "PROCESSING"
    READY = "READY"
    PUBLISHED = "PUBLISHED"
    FAILED = "FAILED"
    ARCHIVED = "ARCHIVED"


class Visibility(enum.StrEnum):
    PRIVATE = "PRIVATE"
    UNLISTED = "UNLISTED"
    PUBLIC = "PUBLIC"


class SceneCategory(enum.StrEnum):
    URBAN = "urban"
    ARCHITECTURE = "architecture"
    INTERIOR = "interior"
    NATURE = "nature"
    PORTRAIT = "portrait"
    EXPERIMENT = "experiment"


class JobKind(enum.StrEnum):
    VALIDATE_UPLOAD = "VALIDATE_UPLOAD"
    BUILD_STREAMED_SOG = "BUILD_STREAMED_SOG"
    RECONSTRUCT = "RECONSTRUCT"
    PUBLISH = "PUBLISH"
    DELETE_ASSETS = "DELETE_ASSETS"
    BUILD_COLLISION = "BUILD_COLLISION"


class JobStatus(enum.StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCEL_REQUESTED = "CANCEL_REQUESTED"
    CANCELLED = "CANCELLED"


class CollisionStatus(enum.StrEnum):
    NONE = "NONE"
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class AssetKind(enum.StrEnum):
    SOURCE = "SOURCE"
    POSTER = "POSTER"
    MANIFEST = "MANIFEST"
    SOG = "SOG"
    STREAM_INDEX = "STREAM_INDEX"
    STREAM_CHUNK = "STREAM_CHUNK"
    LOG_SUMMARY = "LOG_SUMMARY"
    COLLISION_GLB = "COLLISION_GLB"


class UploadSessionStatus(enum.StrEnum):
    CREATED = "CREATED"
    UPLOADING = "UPLOADING"
    UPLOADED = "UPLOADED"
    QUEUED = "QUEUED"
    VALIDATING = "VALIDATING"
    CONVERTING = "CONVERTING"
    VERIFYING = "VERIFYING"
    PUBLISHING = "PUBLISHING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"
