"""Tests for storage path resolution, LocalDiskStorage and chunk uploads."""

from __future__ import annotations

import hashlib
from io import BytesIO

import pytest

from app.storage import LocalDiskStorage, resolve_within


# ──── resolve_within ────────────────────────────────────────────────────────
class TestResolveWithin:
    def test_simple_relative(self, tmp_path):
        result = resolve_within(tmp_path, "foo/bar.txt")
        assert result == (tmp_path / "foo" / "bar.txt").resolve()

    def test_rejects_absolute(self, tmp_path):
        with pytest.raises(ValueError, match="绝对路径"):
            resolve_within(tmp_path, "/etc/passwd")

    def test_rejects_dotdot(self, tmp_path):
        with pytest.raises(ValueError, match="\\.\\."):
            resolve_within(tmp_path, "../escape")

    def test_rejects_symlink_escape(self, tmp_path):
        link = tmp_path / "sneaky"
        link.symlink_to("/etc")
        with pytest.raises(ValueError, match="逃逸"):
            resolve_within(tmp_path, "sneaky/passwd")

    def test_rejects_dotdot_in_middle(self, tmp_path):
        with pytest.raises(ValueError):
            resolve_within(tmp_path, "foo/../../etc/passwd")


# ──── LocalDiskStorage ──────────────────────────────────────────────────────
class TestLocalDiskStorage:
    def test_write_read(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.write("a/b.bin", b"hello")
        assert store.read("a/b.bin") == b"hello"
        assert store.size("a/b.bin") == 5
        assert store.exists("a/b.bin")

    def test_append(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.write("x.bin", b"aaa")
        new_size = store.append("x.bin", b"bb")
        assert new_size == 5
        assert store.read("x.bin") == b"aaabb"

    def test_read_range(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.write("r.bin", b"abcdefghij")
        assert store.read_range("r.bin", 3, 4) == b"defg"

    def test_sha256(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        data = b"test-sha256"
        store.write("s.bin", data)
        expected = hashlib.sha256(data).hexdigest()
        assert store.sha256("s.bin") == expected

    def test_atomic_rename_dir(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.mkdir("src")
        store.write("src/file.txt", b"in src")
        store.atomic_rename_dir("src", "dst")
        assert store.read("dst/file.txt") == b"in src"
        assert not store.exists("src")

    def test_atomic_rename_fails_if_dst_exists(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.mkdir("a")
        store.mkdir("b")
        with pytest.raises(FileExistsError):
            store.atomic_rename_dir("a", "b")

    def test_delete_file(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.write("del.bin", b"data")
        store.delete("del.bin")
        assert not store.exists("del.bin")

    def test_delete_dir(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        store.mkdir("dir")
        store.write("dir/f.txt", b"data")
        store.delete("dir")
        assert not store.exists("dir")

    def test_write_binary_stream(self, tmp_path):
        store = LocalDiskStorage(tmp_path)
        total = store.write_binary("stream.bin", BytesIO(b"streamed-data"))
        assert total == 13
        assert store.read("stream.bin") == b"streamed-data"
