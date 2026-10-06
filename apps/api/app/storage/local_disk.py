"""LocalDiskStorage — local-filesystem implementation of ``Storage``.

Safety contract:
- every key passes through :func:`app.storage.paths.resolve_within`, which
  rejects absolute paths, ``..`` and symlink escapes;
- files are written with tight permissions (0o600) and directories with
  restrictive parent-chain permissions (0o700);
- atomic directory publish uses ``os.rename`` on the same filesystem so a
  failed publish never leaves a half-written version.

The root is intentionally not part of any web-visible tree (staging,
quarantine and published all live under the configured storage root).
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import BinaryIO

from app.storage.base import Storage
from app.storage.paths import resolve_within

_FILE_MODE = 0o600
_DIR_MODE = 0o700


class LocalDiskStorage(Storage):
    """Filesystem-backed storage rooted at ``root``."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _path(self, key: str) -> Path:
        return resolve_within(self.root, key)

    def _ensure_parent(self, path: Path) -> None:
        parent = path.parent
        if not parent.exists():
            parent.mkdir(parents=True, exist_ok=True, mode=_DIR_MODE)
        os.chmod(parent, _DIR_MODE)

    # ------------------------------------------------------------------ #
    # Storage interface
    # ------------------------------------------------------------------ #
    def write(self, key: str, data: bytes) -> None:
        path = self._path(key)
        self._ensure_parent(path)
        # write to a temp file then rename so readers never see partial bytes
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, _FILE_MODE)
        os.replace(tmp, path)

    def write_binary(self, key: str, source: BinaryIO) -> int:
        """Stream *source* into *key*; returns total bytes written."""
        path = self._path(key)
        self._ensure_parent(path)
        tmp = path.with_suffix(path.suffix + ".tmp")
        total = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, _FILE_MODE)
        os.replace(tmp, path)
        return total

    def append(self, key: str, data: bytes) -> int:
        path = self._path(key)
        self._ensure_parent(path)
        with open(path, "ab") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        return self.size(key)

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def read_range(self, key: str, offset: int, length: int) -> bytes:
        with open(self._path(key), "rb") as f:
            f.seek(offset)
            return f.read(length)

    def size(self, key: str) -> int:
        path = self._path(key)
        return path.stat().st_size if path.exists() else 0

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.exists():
            if path.is_dir() and not path.is_symlink():
                import shutil

                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)

    def sha256(self, key: str) -> str:
        digest = hashlib.sha256()
        with open(self._path(key), "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        return digest.hexdigest()

    def mkdir(self, key: str) -> None:
        path = self._path(key)
        path.mkdir(parents=True, exist_ok=True, mode=_DIR_MODE)
        os.chmod(path, _DIR_MODE)

    def atomic_rename_dir(self, src_key: str, dst_key: str) -> None:
        src = self._path(src_key)
        dst = self._path(dst_key)
        if not src.is_dir():
            raise FileNotFoundError(f"源目录不存在: {src_key!r}")
        dst.parent.mkdir(parents=True, exist_ok=True, mode=_DIR_MODE)
        os.chmod(dst.parent, _DIR_MODE)
        if dst.exists():
            raise FileExistsError(f"目标已存在: {dst_key!r}")
        os.rename(src, dst)
        os.chmod(dst, _DIR_MODE)
