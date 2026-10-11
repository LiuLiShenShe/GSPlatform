"""Strict bounded envelope for the official uncompressed PLY export, not an encoder."""

import json
import zipfile
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
    count = None
    properties = []
    for line in lines[2:]:
        if line.startswith("comment ") or line.startswith("obj_info "):
            continue
        parts = line.split()
        if parts[:2] == ["element", "vertex"] and len(parts) == 3 and count is None:
            count = int(parts[2])
        elif parts[:2] == ["property", "float"] and len(parts) == 3:
            properties.append(parts[2])
        else:
            raise ValueError("编辑 PLY 存在不支持或重复的元素/属性")
    required = {"x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
                "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2"}
    if (count is None or not 0 < count <= maximum_count or len(properties) != len(set(properties))
            or not required.issubset(properties)):
        raise ValueError("编辑 PLY Gaussian 属性或顶点数量不合法")
    if marker + len(b"end_header\n") + count * len(properties) * 4 != path.stat().st_size:
        raise ValueError("编辑 PLY 字节长度与属性/顶点声明不符")


def validate_editor_sog(path: Path, maximum_count: int) -> None:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or "meta.json" not in names:
            raise ValueError("请提交官方导出的 bundled SOG，不接受重复条目或 Streamed ZIP")
        if archive.getinfo("meta.json").file_size > 262144:
            raise ValueError("SOG 元数据超过安全大小上限")
        metadata = json.loads(archive.read("meta.json"))
        if (not isinstance(metadata, dict) or metadata.get("version") != 2
                or type(metadata.get("count")) is not int
                or not 0 < metadata["count"] <= maximum_count):
            raise ValueError("SOG 版本或来源 LOD Gaussian 数量不合法")
