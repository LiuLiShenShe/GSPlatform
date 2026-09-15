"""Tests for the upload validation pipeline (Phase 06)."""

from __future__ import annotations

import json
import zipfile

from workers.pipeline.validate_scene import validate_upload


def _make_ply(path, declared_count: int = 3):
    """Write a minimal but structurally-valid PLY header + a few vertices."""
    header = [
        b"ply",
        b"format ascii 1.0",
        f"element vertex {declared_count}".encode(),
        b"property float x",
        b"property float y",
        b"property float z",
        b"end_header",
    ]
    body = b"\n".join(b"0 0 0" for _ in range(declared_count))
    path.write_bytes(b"\n".join(header) + b"\n" + body + b"\n")
    return path


def _make_streamed_zip(path):
    """Create a zip that looks like a pre-built streamed-SOG container."""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("lod-meta.json", json.dumps({
            "version": 1,
            "counts": [10, 20, 30],
            "filenames": [],
            "tree": {},
        }))
        zf.writestr("manifest.json", json.dumps({"schemaVersion": 1}))
    return path


class TestValidateUpload:
    def test_valid_ply(self, tmp_path):
        f = _make_ply(tmp_path / "a.ply", 3)
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert res.ok
        assert res.detected_format == "ply"
        assert res.sha256  # non-empty hex digest

    def test_sog_zip_structure(self, tmp_path):
        f = _make_streamed_zip(tmp_path / "s.sog")
        res = validate_upload(
            f, declared_format="sog", declared_mime="application/octet-stream",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert res.ok
        assert res.info_json is not None

    def test_sha256_mismatch_rejected(self, tmp_path):
        f = _make_ply(tmp_path / "b.ply", 3)
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256="0" * 64,
        )
        assert not res.ok
        assert "SHA-256" in res.reason

    def test_wrong_magic_rejected(self, tmp_path):
        f = tmp_path / "c.ply"
        f.write_bytes(b"not-a-ply-file")
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok

    def test_size_mismatch_rejected(self, tmp_path):
        f = tmp_path / "d.ply"
        f.write_bytes(b"ply\n")
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=99999, expected_sha256=None,
        )
        assert not res.ok
        assert "字节数" in res.reason

    def test_unsupported_format_rejected(self, tmp_path):
        f = tmp_path / "e.exe"
        f.write_bytes(b"MZ")
        res = validate_upload(
            f, declared_format="exe", declared_mime="application/x-msdownload",
            expected_size=2, expected_sha256=None,
        )
        assert not res.ok


class TestSafeUnpackZip:
    def test_dotdot_entries_rejected(self, tmp_path):
        zpath = tmp_path / "evil.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("../escape.txt", b"boom")
        from workers.pipeline.validate_scene import safe_unpack_zip

        with _raises_valueerror():
            safe_unpack_zip(zpath, tmp_path / "out", expected_size=zpath.stat().st_size)

    def test_absolute_entries_rejected(self, tmp_path):
        zpath = tmp_path / "abs.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("/etc/passwd", b"escape")
        from workers.pipeline.validate_scene import safe_unpack_zip

        with _raises_valueerror():
            safe_unpack_zip(zpath, tmp_path / "out", expected_size=zpath.stat().st_size)


class _Context:
    def __init__(self):
        self.caught = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is ValueError:
            self.caught = True
            return True
        return False


def _raises_valueerror():
    return _Context()