"""Strict bounded envelope for the official uncompressed PLY export, not an encoder."""

from pathlib import Path


def validate_editor_ply(path: Path, maximum_count: int) -> None:
    with path.open("rb") as stream:
        header = stream.read(65536)
    marker = header.find(b"end_header\n")
    if marker < 0:
        raise ValueError("编辑 PLY 缺少有限长度的完整头部")
    lines = header[:marker].decode("ascii", errors="strict").splitlines()
    if lines[:2] != ["ply", "format binary_little_endian 1.0"]:
        raise ValueError("请使用官方 Export PLY，不启用 Compress PLY")
    count = 0
    properties = []
    for line in lines[2:]:
        if line.startswith("comment ") or line.startswith("obj_info "):
            continue
        parts = line.split()
        if parts[:2] == ["element", "vertex"] and len(parts) == 3 and count == 0:
            count = int(parts[2])
        elif parts[:2] == ["property", "float"] and len(parts) == 3:
            properties.append(parts[2])
        else:
            raise ValueError("编辑 PLY 存在不支持或重复的元素/属性")
    required = {"x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
                "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2"}
    if (not 0 < count <= maximum_count or len(properties) != len(set(properties))
            or not required.issubset(properties)):
        raise ValueError("编辑 PLY Gaussian 属性或顶点数量不合法")
    if marker + len(b"end_header\n") + count * len(properties) * 4 != path.stat().st_size:
        raise ValueError("编辑 PLY 字节长度与属性/顶点声明不符")
