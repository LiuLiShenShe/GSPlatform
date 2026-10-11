"""Compatibility entry point for the shared artifact validator."""

from workers.pipeline.artifact_validator import validate_artifact_tree

verify_published_version = validate_artifact_tree
