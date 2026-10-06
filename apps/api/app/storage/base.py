"""Storage interface — the single abstraction for persisted assets.

Phase 06 stores on local disk; the interface is deliberately free of
filesystem concepts so a future object-storage backend can implement the
same contract without changing callers. All keys passed to this interface
are **server-generated** storage keys; a client filename is never used as a
key.
"""

from __future__ import annotations

import abc
from typing import BinaryIO


class Storage(abc.ABC):
    """Create, read, delete and atomically publish stored resources."""

    @abc.abstractmethod
    def write(self, key: str, data: bytes) -> None:
        """Create or atomically overwrite *key* with *data*."""

    @abc.abstractmethod
    def write_binary(self, key: str, source: BinaryIO) -> int:
        """Stream *source* into *key*, returning the number of bytes written."""

    @abc.abstractmethod
    def append(self, key: str, data: bytes) -> int:
        """Append *data* at the current end of *key*, returning new size."""

    @abc.abstractmethod
    def read(self, key: str) -> bytes:
        """Return the full contents of *key*."""

    @abc.abstractmethod
    def read_range(self, key: str, offset: int, length: int) -> bytes:
        """Return bytes ``[offset, offset+length)`` of *key*."""

    @abc.abstractmethod
    def size(self, key: str) -> int:
        """Return the current byte size of *key* (0 if absent)."""

    @abc.abstractmethod
    def exists(self, key: str) -> bool:
        """Return True if *key* exists."""

    @abc.abstractmethod
    def delete(self, key: str) -> None:
        """Remove *key* (no-op if absent)."""

    @abc.abstractmethod
    def sha256(self, key: str) -> str:
        """Return the hex SHA-256 of the contents of *key*."""

    @abc.abstractmethod
    def mkdir(self, key: str) -> None:
        """Create a directory at *key* (parents included, no-op if exists)."""

    @abc.abstractmethod
    def atomic_rename_dir(self, src_key: str, dst_key: str) -> None:
        """Atomically move a directory (same filesystem) from *src_key* to *dst_key*."""
