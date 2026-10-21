"""Guard: the project must not depend on conda any more (2026-10 规定).

The Python environment is managed by **uv** (``apps/api/pyproject.toml`` +
``apps/api/uv.lock``).  This test fails if any tracked file starts *using*
conda again — activating it, installing into it, or pointing at a conda
environment path.  Prose that merely says "conda is not used" is fine: only
actionable patterns are rejected.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

#: Actionable conda usage.  Deliberately narrow: documentation that states
#: "conda is NOT used" must not trip the guard.
FORBIDDEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("conda activate", re.compile(r"conda\s+activate")),
    ("conda run", re.compile(r"conda\s+run\b")),
    ("conda install", re.compile(r"conda\s+install\b")),
    ("conda env var", re.compile(r"\bCONDA_(PREFIX|EXE|DEFAULT_ENV|SHLVL)\b")),
    ("conda environment path", re.compile(r"/envs/[\w.-]+/bin/python")),
    ("conda distribution", re.compile(r"\b(miniconda|anaconda)\b", re.IGNORECASE)),
)

#: Paths whose contents are generated / vendored and are not our contract.
SKIP_PREFIXES = (
    "apps/api/uv.lock",
    "apps/web/node_modules/",
    "apps/viewer/",
)


def _tracked_files() -> list[Path]:
    git = shutil.which("git") or "git"
    result = subprocess.run(  # noqa: S603 - absolute git path, our own listing
        [git, "-C", str(REPO_ROOT), "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,
    )
    files: list[Path] = []
    for raw in result.stdout.split("\0"):
        if not raw or raw.startswith(SKIP_PREFIXES):
            continue
        path = REPO_ROOT / raw
        if path.is_file():
            files.append(path)
    return files


def test_no_tracked_file_uses_conda() -> None:
    offenders: list[str] = []
    for path in _tracked_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for label, pattern in FORBIDDEN_PATTERNS:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                offenders.append(
                    f"{path.relative_to(REPO_ROOT)}:{line} — {label}"
                )
    assert not offenders, "conda usage found in tracked files:\n" + "\n".join(offenders)


def test_python_environment_is_uv_managed() -> None:
    """pyproject declares uv, the lockfile is committed, the venv is uv's."""
    pyproject = (REPO_ROOT / "apps/api/pyproject.toml").read_text(encoding="utf-8")
    assert "[tool.uv]" in pyproject, "apps/api/pyproject.toml must declare [tool.uv]"
    assert 'python-preference = "only-managed"' in pyproject, (
        "the venv must never be built on a system/conda interpreter"
    )
    lock = REPO_ROOT / "apps/api/uv.lock"
    assert lock.is_file(), "apps/api/uv.lock must be committed (uv lock)"
    assert "gsplatform-api" in lock.read_text(encoding="utf-8")

    venv_python = REPO_ROOT / "apps/api/.venv/bin/python"
    if not venv_python.exists():
        # A fresh checkout has no venv yet — the lockfile is the contract.
        return
    resolved = venv_python.resolve()
    assert "uv" in str(resolved) or "share/uv" in str(resolved), (
        f"apps/api/.venv must be a uv-managed environment, got {resolved}"
    )
    assert "conda" not in str(resolved)
