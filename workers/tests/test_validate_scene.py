"""Tests for the upload validation pipeline (Phase 06)."""

from __future__ import annotations

import json
import zipfile

from workers.pipeline.validate_scene import validate_upload


def _make_ply(path, declared_count: int = 3):
    """Write a minimal but valid Gaussian-splat PLY header + a few vertices.

    FIX-UPLOAD-01 §5: a valid PLY upload must carry the full 3DGS attribute
    set (x/y/z + opacity + scale_* + rot_* + f_dc_*); a bare x/y/z point cloud
    is rejected.  Body rows are irrelevant to header validation.
    """
    gaussian_props = [
        b"property float x",
        b"property float y",
        b"property float z",
        b"property float f_dc_0",
        b"property float f_dc_1",
        b"property float f_dc_2",
        b"property float opacity",
        b"property float scale_0",
        b"property float scale_1",
        b"property float scale_2",
        b"property float rot_0",
        b"property float rot_1",
        b"property float rot_2",
        b"property float rot_3",
    ]
    header = [
        b"ply",
        b"format binary_little_endian 1.0",
        f"element vertex {declared_count}".encode(),
        *gaussian_props,
        b"end_header",
    ]
    # One binary row per vertex (14 float32) — content not inspected by tests.
    row = b"\x00" * (14 * 4)
    path.write_bytes(b"\n".join(header) + b"\n" + row * declared_count)
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

    # ── FIX-UPLOAD-01 §5/§6 — Gaussian-only PLY validation ────────────────
    def test_plain_point_cloud_ply_rejected(self, tmp_path):
        """x/y/z-only PLY (no opacity/scale/rot/f_dc) is NOT a Gaussian."""
        f = tmp_path / "cloud.ply"
        header = [
            b"ply", b"format ascii 1.0",
            b"element vertex 3",
            b"property float x", b"property float y", b"property float z",
            b"property uchar red", b"property uchar green", b"property uchar blue",
            b"end_header",
        ]
        f.write_bytes(b"\n".join(header) + b"\n0 0 0 255 0 0\n")
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok
        assert "opacity" in res.reason  # missing Gaussian shape attribute

    def test_point_cloud_with_opacity_but_no_sh_rejected(self, tmp_path):
        """Missing f_dc_* (color layer) → not Gaussian splat data."""
        f = tmp_path / "nosh.ply"
        header = [
            b"ply", b"format ascii 1.0",
            b"element vertex 2",
            b"property float x", b"property float y", b"property float z",
            b"property float opacity",
            b"property float scale_0", b"property float scale_1", b"property float scale_2",
            b"property float rot_0", b"property float rot_1", b"property float rot_2",
            b"property float rot_3",
            b"end_header",
        ]
        f.write_bytes(b"\n".join(header) + b"\n")
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok
        assert "f_dc_" in res.reason

    def test_zero_vertex_ply_rejected(self, tmp_path):
        f = _make_ply(tmp_path / "zero.ply", declared_count=0)
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok
        assert "vertex" in res.reason

    def test_malformed_ply_missing_end_header_rejected(self, tmp_path):
        f = tmp_path / "truncated.ply"
        f.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 3\n")
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok
        assert "end_header" in res.reason

    def test_ply_without_vertex_element_rejected(self, tmp_path):
        f = tmp_path / "novertex.ply"
        f.write_bytes(b"ply\nformat ascii 1.0\ncomment x\nend_header\n")
        res = validate_upload(
            f, declared_format="ply", declared_mime="model/ply",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok
        assert "vertex" in res.reason

    def test_mismatched_declared_format_rejected(self, tmp_path):
        """Gaussian PLY bytes declared as a SOG container → magic mismatch."""
        f = _make_ply(tmp_path / "declared_sog.ply", declared_count=3)
        res = validate_upload(
            f, declared_format="sog", declared_mime="application/octet-stream",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res.ok
        assert "ZIP" in res.reason
        res2 = validate_upload(
            f, declared_format="zip", declared_mime="application/zip",
            expected_size=f.stat().st_size, expected_sha256=None,
        )
        assert not res2.ok
        assert "ZIP" in res2.reason


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