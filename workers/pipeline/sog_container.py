"""Strict bundled SOG validation using container integrity and the pinned decoder."""

from __future__ import annotations

import json
import struct
import zipfile
from pathlib import Path, PurePosixPath

from workers.pipeline.splat_transform_adapter import inspect_source
from workers.pipeline.validate_scene import MAX_ARCHIVE_ENTRIES, MAX_EXPANSION_RATIO


def validate_sog_container(source: Path) -> dict:
    try:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if (not entries or len(entries) > MAX_ARCHIVE_ENTRIES or len(set(names)) != len(names)
                    or "meta.json" not in names or "lod-meta.json" in names):
                raise ValueError("Invalid bundled SOG entries")
            expanded = sum(entry.file_size for entry in entries)
            if expanded > source.stat().st_size * MAX_EXPANSION_RATIO:
                raise ValueError("SOG expansion exceeds safety limit")
            for entry in entries:
                name = PurePosixPath(entry.filename)
                if (name.is_absolute() or ".." in name.parts or "\\" in entry.filename
                        or entry.flag_bits & 1 or entry.external_attr >> 16 & 0o170000 == 0o120000):
                    raise ValueError("Unsafe SOG member")
            metadata_entry = archive.getinfo("meta.json")
            if not 0 < metadata_entry.file_size <= 16 * 1024 * 1024:
                raise ValueError("Invalid SOG metadata size")
            metadata = json.loads(archive.read("meta.json"))
            count = metadata.get("count")
            if metadata.get("version") not in (1, 2) or type(count) is not int or count <= 0:
                raise ValueError("Invalid SOG version/count")
            referenced = {"meta.json"}
            for layer, minimum in (("means", 2), ("scales", 1), ("quats", 1), ("sh0", 1)):
                files = metadata.get(layer, {}).get("files", [])
                if not isinstance(files, list) or len(files) != minimum:
                    raise ValueError(f"Invalid SOG {layer} files")
                referenced.update(files)
            if "shN" in metadata:
                files = metadata["shN"].get("files", [])
                if not isinstance(files, list) or len(files) != 2:
                    raise ValueError("Invalid SOG SH files")
                referenced.update(files)
            if set(names) != referenced:
                raise ValueError("SOG resources do not match metadata")
            for name in referenced - {"meta.json"}:
                payload = archive.read(name)
                if (len(payload) < 20 or payload[:4] != b"RIFF" or payload[8:12] != b"WEBP"
                        or struct.unpack("<I", payload[4:8])[0] + 8 != len(payload)):
                    raise ValueError("Invalid SOG WebP payload")
            if archive.testzip() is not None:
                raise ValueError("Corrupt SOG CRC")
    except (zipfile.BadZipFile, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid SOG container: {exc}") from exc
    official = inspect_source(source, "sog", decode=True)
    if official["numGaussians"] != count:
        raise ValueError("Official SOG count disagrees with metadata")
    return official
