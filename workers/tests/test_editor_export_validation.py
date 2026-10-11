"""Validate the official uncompressed Gaussian PLY delivery contract."""

import struct

import pytest

from workers.pipeline.validate_editor_export import validate_editor_ply


def gaussian_ply(count=2):
    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    header = ("ply\nformat binary_little_endian 1.0\nelement vertex " + str(count) + "\n"
              + "".join(f"property float {name}\n" for name in names) + "end_header\n")
    return header.encode() + struct.pack("<" + "f" * len(names) * count,
                                         *([0.0] * len(names) * count))


def test_official_gaussian_properties_count_and_exact_bytes(tmp_path):
    source = tmp_path / "export.ply"
    source.write_bytes(gaussian_ply())
    validate_editor_ply(source, 3)


@pytest.mark.parametrize("payload", [
    b"not a ply", b"ply\n" + b"x" * 65536,
    gaussian_ply().replace(b"property float opacity", b"property float wrong"),
    gaussian_ply().replace(b"property float rot_3", b"property float rot_2"),
    gaussian_ply().replace(b"format binary_little_endian", b"format binary_big_endian"),
    gaussian_ply().replace(b"element vertex 2", b"element vertex 999999999"),
    gaussian_ply()[:-4], gaussian_ply() + b"extra data",
])
def test_malformed_oversized_wrong_properties_and_payload_rejected(tmp_path, payload):
    source = tmp_path / "export.ply"
    source.write_bytes(payload)
    with pytest.raises((ValueError, UnicodeError)):
        validate_editor_ply(source, 3)


def test_source_lod_count_cannot_be_misrepresented(tmp_path):
    source = tmp_path / "export.ply"
    source.write_bytes(gaussian_ply(3))
    with pytest.raises(ValueError):
        validate_editor_ply(source, 2)
