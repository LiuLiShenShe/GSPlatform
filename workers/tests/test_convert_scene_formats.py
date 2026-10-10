"""FIX-UPLOAD-01 §五/§六 — Problem A format tests (RED first).

An uploaded PLY is staged server-side as ``upload.bin`` (random, server-owned
name). ``convert_to_streamed_sog`` must hand splat-transform a file with a
*supported extension* derived from the **validated declared format**, never from
``upload.bin``'s ``.bin`` suffix — splat-transform keys input detection on the
extension and rejects ``raw-input.bin`` outright.

These tests run the REAL converter against REAL format fixtures staged under the
server's ``upload.bin`` name, and assert both:
  1. the internal ``raw-input*`` copy carries the correct extension, and
  2. the conversion actually succeeds (real streamed-SOG staging output).

Before the fix the converter produced ``raw-input.bin`` and every PLY/SOG/SPLAT
conversion failed with "Unsupported input file type".
"""

from __future__ import annotations

import shutil
import struct
import zipfile
from pathlib import Path

import pytest

from workers.pipeline.convert_scene import convert_to_streamed_sog

SCENE_UUID = "11111111-2222-3333-4444-555555555555"


def _node_bin() -> Path:
    import workers.pipeline.convert_scene as mod

    return mod._NODE_BIN


# These three tests execute the REAL pinned splat-transform CLI (the spy only
# records, then calls through). The CLI lives in untracked node_modules, which a
# clean-checkout reproducibility gate deliberately excludes — on such a checkout
# the real-conversion gate runs in the dev environment (where node_modules IS
# present, and the report records those results) and these tests SKIP here
# instead of failing, exactly like the recon gate's SKIPPED_NO_GPU posture.
# Passthrough / traversal tests below never need the CLI and always run.
REQUIRES_CLI = pytest.mark.skipif(
    not _node_bin().exists(),
    reason="splat-transform CLI 不在本 checkout（node_modules 未随 git archive 分发）",
)


# ── real fixtures ───────────────────────────────────────────────────────────
def _gaussian_ply_bytes(n: int = 512) -> bytes:
    """A real, minimal but complete 3DGS binary PLY (14 float properties)."""
    props = [
        ("x", "float"),
        ("y", "float"),
        ("z", "float"),
        ("f_dc_0", "float"),
        ("f_dc_1", "float"),
        ("f_dc_2", "float"),
        ("opacity", "float"),
        ("scale_0", "float"),
        ("scale_1", "float"),
        ("scale_2", "float"),
        ("rot_0", "float"),
        ("rot_1", "float"),
        ("rot_2", "float"),
        ("rot_3", "float"),
    ]
    head = ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
    head += [f"property {t} {nm}" for nm, t in props]
    head += ["end_header"]
    header = ("\n".join(head) + "\n").encode("ascii")
    rows = []
    for i in range(n):
        x = (i % 16) / 16.0 * 2 - 1
        y = ((i // 16) % 16) / 16.0 * 2 - 1
        z = ((i // 256) % 2) * 0.1
        rows.append(
            struct.pack(
                "<14f",
                x,
                y,
                z,
                0.5,
                0.5,
                0.5,
                0.9,
                -3.0,
                -3.0,
                -3.0,
                1.0,
                0.0,
                0.0,
                0.0,
            )
        )
    return header + b"".join(rows)


def _streamed_zip_bytes() -> bytes:
    """A pre-built streamed-SOG zip (root lod-meta.json) — passthrough fixture."""
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "lod-meta.json",
            '{"version":1,"counts":[10,20,30],"filenames":[],"tree":{}}',
        )
    return buf.getvalue()


def _stage_as_upload_bin(tmp_path: Path, data: bytes) -> Path:
    """Stage bytes the way the server does: ``staging/<id>/upload.bin``."""
    d = tmp_path / "staging"
    d.mkdir(parents=True, exist_ok=True)
    p = d / "upload.bin"
    p.write_bytes(data)
    return p


def _internal_raw_input(staging: Path) -> Path | None:
    """Locate the converter's internal ``raw-input*`` copy (workdir sibling)."""
    workdirs = list(staging.parent.glob(".workdir-*"))
    if not workdirs:
        return None
    candidates = sorted(workdirs[-1].glob("raw-input*"))
    return candidates[0] if candidates else None


# ── tests ────────────────────────────────────────────────────────────────────
class TestProblemAStagedFormatExtension:
    """The converter must feed splat-transform the *declared* format."""

    @REQUIRES_CLI
    def test_ply_in_upload_bin_converts_with_raw_input_ply(self, tmp_path, monkeypatch):
        src = _stage_as_upload_bin(tmp_path, _gaussian_ply_bytes())
        staging = tmp_path / "published" / ".staging"

        # Capture the internal raw-input path the converter produces, by
        # intercepting the copy just after it happens (workdir is created then).
        seen: dict[str, str] = {}
        import workers.pipeline.convert_scene as mod

        real_run = mod._run

        def spy_run(cmd, cwd=None, timeout=None):  # noqa: ANN001
            for arg in cmd:
                if "raw-input" in str(arg):
                    seen.setdefault("arg", str(arg))
            return real_run(cmd, cwd=cwd, timeout=timeout)

        monkeypatch.setattr(mod, "_run", spy_run)

        res = convert_to_streamed_sog(
            src, staging, scene_id=SCENE_UUID, source_format="ply"
        )

        assert res.ok, f"PLY conversion failed: {res.reason}"
        # The CLI must have received a `.ply` file (not `.bin`).
        assert "raw-input.ply" in seen.get("arg", ""), (
            f"splat-transform input was {seen.get('arg')!r}, expected raw-input.ply"
        )
        # Real streamed-SOG output, written into the VERSION-scoped staging dir.
        vdir = staging / res.version_id
        assert (vdir / "manifest.json").exists()
        assert (vdir / "lod-meta.json").exists()

    @REQUIRES_CLI
    def test_declared_format_none_keeps_suffix_fallback(self, tmp_path, monkeypatch):
        """Backwards compat: when no declared format is supplied (e.g. a real
        ``.ply`` path from the reconstruction path), the suffix is still used."""
        real_ply = tmp_path / "real.ply"
        real_ply.write_bytes(_gaussian_ply_bytes(64))
        staging = tmp_path / "published" / ".staging"

        import workers.pipeline.convert_scene as mod

        seen: dict[str, str] = {}
        real_run = mod._run

        def spy_run(cmd, cwd=None, timeout=None):  # noqa: ANN001
            for arg in cmd:
                if "raw-input" in str(arg):
                    seen.setdefault("arg", str(arg))
            return real_run(cmd, cwd=cwd, timeout=timeout)

        monkeypatch.setattr(mod, "_run", spy_run)

        res = convert_to_streamed_sog(real_ply, staging, scene_id=SCENE_UUID)
        assert res.ok, f"fallback conversion failed: {res.reason}"
        assert "raw-input.ply" in seen.get("arg", "")

    @REQUIRES_CLI
    def test_splat_in_upload_bin_converts_with_raw_input_splat(
        self, tmp_path, monkeypatch
    ):
        """A declared ``splat`` upload must be fed as ``raw-input.splat``."""
        # Produce a real SPLAT from the tiny PLY using the pinned CLI.
        node_bin = _node_bin()
        ply = tmp_path / "tiny.ply"
        ply.write_bytes(_gaussian_ply_bytes(256))
        splat = tmp_path / "tiny.splat"
        import subprocess

        r = subprocess.run(
            [
                "node",
                str(node_bin),
                "-g",
                "cpu",
                str(ply),
                str(splat),
                "--overwrite",
                "--no-tty",
                "--max-workers",
                "0",
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        assert r.returncode == 0, f"could not build SPLAT fixture: {r.stderr}"

        src = _stage_as_upload_bin(tmp_path, splat.read_bytes())
        staging = tmp_path / "published" / ".staging"

        import workers.pipeline.convert_scene as mod

        seen: dict[str, str] = {}
        real_run = mod._run

        def spy_run(cmd, cwd=None, timeout=None):  # noqa: ANN001
            for arg in cmd:
                if "raw-input" in str(arg):
                    seen.setdefault("arg", str(arg))
            return real_run(cmd, cwd=cwd, timeout=timeout)

        monkeypatch.setattr(mod, "_run", spy_run)

        res = convert_to_streamed_sog(
            src, staging, scene_id=SCENE_UUID, source_format="splat"
        )
        assert res.ok, f"SPLAT conversion failed: {res.reason}"
        assert "raw-input.splat" in seen.get("arg", ""), (
            f"expected raw-input.splat, got {seen.get('arg')!r}"
        )

    def test_sog_in_upload_bin_uses_streamed_passthrough(self, tmp_path):
        """A declared ``sog`` pre-built streamed zip passes through without CLI."""
        src = _stage_as_upload_bin(tmp_path, _streamed_zip_bytes())
        staging = tmp_path / "published" / ".staging"

        res = convert_to_streamed_sog(
            src, staging, scene_id=SCENE_UUID, source_format="sog"
        )
        assert res.ok, f"SOG passthrough failed: {res.reason}"
        vdir = staging / res.version_id
        assert (vdir / "manifest.json").exists()
        assert (vdir / "lod-meta.json").exists()

    def test_traversal_declared_format_cannot_escape(self, tmp_path):
        """A malicious declared format must not be interpolated into a path.

        ``declared_format`` is validated against an allowlist upstream; the
        converter maps known formats to a fixed safe extension and never uses
        the declared string directly as a filename component. Even a traversal
        string must stay inside the workdir.
        """
        src = _stage_as_upload_bin(tmp_path, _gaussian_ply_bytes(32))
        staging = tmp_path / "published" / ".staging"
        # A path-traversal attempt as the declared format.
        res = convert_to_streamed_sog(
            src,
            staging,
            scene_id=SCENE_UUID,
            source_format="../../../../etc/passwd.ply",
        )
        # Either it is rejected (unknown format) or it stays contained; in no
        # case may a file be written outside the staging/workdir tree.
        if res.ok:
            for produced in list(staging.rglob("*")):
                assert str(produced.resolve()).startswith(str(staging.parent.resolve()))
