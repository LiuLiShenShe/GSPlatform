"""Tests for the publish verification pipeline (Phase 06)."""

from __future__ import annotations

import json

import pytest

from workers.pipeline.verify_publish import verify_published_version


def _write_version_dir(tmp_path, *, counts=(10, 20, 30), schema=1, format_k="streamed-sog"):
    """Create a version dir with manifest.json + lod-meta.json."""
    version_dir = tmp_path / "versions" / "abc123"
    version_dir.mkdir(parents=True)
    (version_dir / "lod-meta.json").write_text(
        json.dumps({"version": 1, "counts": list(counts), "tree": {}, "filenames": []}),
        encoding="utf-8",
    )
    (version_dir / "manifest.json").write_text(
        json.dumps({
            "schemaVersion": schema,
            "sceneId": "s1",
            "format": format_k,
            "stream": {
                "entryUrl": "versions/abc123/lod-meta.json",
                "byteLength": (version_dir / "lod-meta.json").stat().st_size,
            },
        }),
        encoding="utf-8",
    )
    return version_dir


class TestVerifyPublishedVersion:
    def test_valid_version(self, tmp_path):
        vdir = _write_version_dir(tmp_path)
        result = verify_published_version(vdir)
        assert result["entry_bytes"] > 0
        assert result["counts"] == [10, 20, 30]

    def test_missing_manifest(self, tmp_path):
        vdir = _write_version_dir(tmp_path)
        (vdir / "manifest.json").unlink()
        with pytest.raises(ValueError, match="manifest.json 缺失"):
            verify_published_version(vdir)

    def test_bad_format(self, tmp_path):
        vdir = _write_version_dir(tmp_path, format_k="ply")
        with pytest.raises(ValueError, match="format"):
            verify_published_version(vdir)

    def test_bad_counts(self, tmp_path):
        vdir = _write_version_dir(tmp_path, counts=(0, 1, 1))
        with pytest.raises(ValueError, match="counts"):
            verify_published_version(vdir)

    def test_missing_entry(self, tmp_path):
        vdir = _write_version_dir(tmp_path)
        (vdir / "lod-meta.json").unlink()
        # fallback to lod-meta.json at version dir root also fails
        with pytest.raises(ValueError, match="entryUrl"):
            verify_published_version(vdir)