"""Pipeline — file & archive validation (Phase 06).

Validates extension/MIME/magic consistency, byte counts, SHA-256 and (for
SOG) structural parsing, and enforces safe archive rules. Each validator is a
pure function so it can be unit-tested without Celery or a running server.
"""

from __future__ import annotations

import hashlib
import zipfile
from dataclasses import dataclass
from pathlib import Path

# Magic numbers we trust over the browser-declared MIME type.
_PLY_MAGIC = b"ply"
_SOG_MAGIC_PREFIX = b"PK\x03\x04"  # .sog is a ZIP container (PlayCanvas SOG)
_SPLAT_MAGIC = None  # detected further down if needed

# Small cap on decompressed archive expansion (压缩比 + 条目数), 200:1 / 2000.
MAX_ARCHIVE_ENTRIES = 2000
MAX_EXPANSION_RATIO = 200


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: str = ""
    sha256: str = ""
    real_magic: str = ""
    detected_format: str = ""
    info_json: dict | None = None


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _detect_magic(path: Path) -> str:
    with path.open("rb") as f:
        head = f.read(16)
    if head.startswith(_PLY_MAGIC):
        return "ply"
    if head.startswith(_SOG_MAGIC_PREFIX):
        # .sog containers are ZIP; distinguish zip uploads by extension logic.
        return "zip"
    if len(head) >= 8 and head[:4] in (b"splAt", b"spla", b"spl "):
        return "splat"
    return "unknown"


def validate_upload(
    path: Path,
    *,
    declared_format: str,
    declared_mime: str,
    expected_size: int,
    expected_sha256: str | None,
) -> ValidationResult:
    """Validate an uploaded file before it can be enqueued.

    - declared_format must be in the allowlist (checked earlier at API, but
      re-checked here in case of a bypass)
    - actual byte count must equal ``expected_size``
    - magic must be consistent with the declared format
    - SHA-256 must match when provided by the client
    - archives must pass safe-unpack rules
    """
    if declared_format not in {"ply", "sog", "splat", "zip"}:
        return ValidationResult(False, f"不支持的格式: {declared_format}")

    if not path.exists():
        return ValidationResult(False, "暂存文件缺失")

    real_size = path.stat().st_size
    if real_size != expected_size:
        return ValidationResult(False, f"实际字节数不符: {real_size} != {expected_size}")

    real_magic = _detect_magic(path)

    # Map declared format to expected magic family.
    if declared_format in ("ply",) and real_magic != "ply":
        return ValidationResult(False, f"扩展名 ply 与魔数不符 ({real_magic})")
    if declared_format == "sog" and real_magic != "zip":
        return ValidationResult(False, f"扩展名 sog 但文件不是 ZIP 容器 ({real_magic})")
    if declared_format == "zip" and real_magic != "zip":
        return ValidationResult(False, f"扩展名 zip 但文件不是 ZIP ({real_magic})")

    sha = _sha256_of(path)
    if expected_sha256 and expected_sha256.lower() != sha:
        return ValidationResult(False, "SHA-256 与客户端声明不符")

    # Structural validation per type.
    if declared_format in ("sog", "zip"):
        info = _validate_archive(path, declared_format)
        if info is None:
            return ValidationResult(
                False,
                "归档结构不安全或不符合 streamed-SOG 要求",
                sha256=sha,
                real_magic=real_magic,
            )
        return ValidationResult(
            True,
            "归档验证通过",
            sha256=sha,
            real_magic=real_magic,
            detected_format=declared_format,
            info_json=info,
        )

    if declared_format == "ply":
        if not _validate_ply_header(path):
            return ValidationResult(False, "PLY 头部无效", sha256=sha, real_magic=real_magic)
    # .splat single-file: magic is trust-based (ASCII header) — skip deep parse.

    return ValidationResult(
        True, "验证通过", sha256=sha, real_magic=real_magic, detected_format=declared_format
    )


def _validate_ply_header(path: Path) -> bool:
    with path.open("rb") as f:
        header = f.read(4096)
    if not header.startswith(b"ply"):
        return False
    if b"end_header" not in header:
        return False
    return True


def _validate_archive(path: Path, declared_format: str) -> dict | None:
    """Safe-unpack a (potentially compressed) archive.

    Rejects:
    - absolute / ``..`` archive member paths
    - symlink members
    - more than ``MAX_ARCHIVE_ENTRIES`` files
    - total uncompressed size beyond ``expected_size * MAX_EXPANSION_RATIO``
    """
    try:
        with zipfile.ZipFile(path) as zf:
            entries = [i for i in zf.infolist() if not i.is_dir()]
            if len(entries) > MAX_ARCHIVE_ENTRIES:
                return None
            compressed = path.stat().st_size
            total_uncompressed = 0
            for info in entries:
                name = info.filename
                if name.startswith("/") or ".." in name.split("/") or ".." in name:
                    return None
                # ELF/sh exec bits are not our concern; directories are skipped
                # and per-file mode is ignored. Only reject symlinks explicitly.
                if info.external_attr >> 16 & 0o170000 == 0o120000:
                    return None
                total_uncompressed += info.file_size
            if compressed and total_uncompressed // max(1, compressed) > MAX_EXPANSION_RATIO:
                return None

            # streamed-SOG container must contain lod-meta.json (or for plain
            # zip → it's the source archive; require no traversal only).
            if declared_format == "sog":
                if not any("lod-meta.json" == n.rsplit("/", 1)[-1] or "meta.json" == n.rsplit("/", 1)[-1] for n in (i.filename for i in entries)):
                    return None
            return {"entries": len(entries), "uncompressed": total_uncompressed}
    except (zipfile.BadZipFile, OSError, ValueError):
        return None


def safe_unpack_zip(
    src: Path,
    dst_dir: Path,
    *,
    expected_size: int,
    max_entries: int = MAX_ARCHIVE_ENTRIES,
    max_ratio: int = MAX_EXPANSION_RATIO,
) -> dict:
    """Extract a validated zip into *dst_dir* (created).

    *dst_dir* must already be a freshly-created empty dir; member names are
    resolved inside it and rejected if they escape.
    """
    src_abs = src.resolve()
    dst_abs = dst_dir.resolve()
    dst_abs.mkdir(parents=True, exist_ok=True)
    total_uncompressed = 0
    entries = 0
    with zipfile.ZipFile(src_abs) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if name.startswith("/") or ".." in name.split("/") or ".." in name:
                raise ValueError(f"归档包含非法路径: {name!r}")
            entries += 1
            if entries > max_entries:
                raise ValueError("归档条目过多")
            total_uncompressed += info.file_size
            compressed = src_abs.stat().st_size
            if compressed and total_uncompressed // max(1, compressed) > max_ratio:
                raise ValueError("归档压缩比异常 (疑似 zip bomb)")
            target = (dst_abs / name).resolve()
            if not str(target).startswith(str(dst_abs)):
                raise ValueError(f"归档条目逃逸目标目录: {name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as member, target.open("wb") as out:
                while True:
                    chunk = member.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
    return {"entries": entries, "uncompressed": total_uncompressed}