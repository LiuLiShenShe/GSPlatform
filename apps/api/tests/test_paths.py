"""FIX-05 §16/§17 — shared filesystem roots helpers.

``get_repo_root()`` must locate the repository root regardless of the caller's
working directory (services previously used ``Path(__file__).parents[N]``,
which broke when files moved — P1-7).
"""

from __future__ import annotations

import os
from pathlib import Path

from app.core.paths import get_repo_root, get_scene_storage_root


class TestGetRepoRoot:
    def test_repo_root_found_from_any_cwd(self, tmp_path, monkeypatch):
        # 从任意 cwd 调用都能找到 pnpm-workspace.yaml 所在的仓库根。
        monkeypatch.chdir(tmp_path)
        root = get_repo_root()
        assert (root / "pnpm-workspace.yaml").is_file()
        assert (root / "apps" / "api").is_dir()

    def test_repo_root_marks_scenes_tree(self):
        root = get_repo_root()
        scenes = root / "scenes"
        assert scenes.is_dir()  # git-ignored dev scene-origin tree

    def test_get_scene_storage_root_normalises(self):
        assert get_scene_storage_root("~/gsplatform-data") == (
            Path.home() / "gsplatform-data"
        ).resolve()
        assert get_scene_storage_root(".").is_absolute()
