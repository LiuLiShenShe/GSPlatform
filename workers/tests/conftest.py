"""Worker test bootstrap — ensures the API package and workers package are importable."""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("GS_ENV", "development")
os.environ.setdefault("GS_DEV_IDENTITY_ENABLED", "true")

API_SRC = Path(__file__).resolve().parent.parent.parent / "apps" / "api"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # /fj/GSPlatform

for p in (str(API_SRC), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)
