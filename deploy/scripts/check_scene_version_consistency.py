#!/usr/bin/env python3
"""GS-NEXT-12 §B — DB current-version pointer ↔ scene-origin entry checker.

Read-only by default.  ``--repair`` only re-points the *mutable* aliases
(``<origin>/<slug>/current`` and ``<origin>/<slug>/versions/<ver>``) at the
version the database already designates; it never deletes, overwrites or
rewrites an immutable version directory, manifest or asset.

Exit codes
    0  every checked scene is consistent (or was safely repaired)
    2  at least one inconsistency remains (including "needs manual intervention")
    1  the checker itself could not run (DB/config error)

Usage
    PYTHONPATH=apps/api apps/api/.venv/bin/python \\
        deploy/scripts/check_scene_version_consistency.py --json
    ... --scene my-scene
    ... --limit 500
    ... --repair            # safe self-heal of the alias only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--scene", help="only this slug")
    parser.add_argument("--limit", type=int, default=None, help="max scenes")
    parser.add_argument(
        "--repair",
        action="store_true",
        help="re-point mutable aliases at the DB-designated version (never touches immutable bytes)",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument(
        "--db-url",
        default=None,
        help="override GS_DATABASE_URL (must be set before settings are imported)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.db_url:
        os.environ["GS_DATABASE_URL"] = args.db_url

    try:
        from app.db.session import SessionLocal
        from app.services.version_consistency import check_scenes
    except Exception as exc:  # pragma: no cover - configuration error
        print(f"ERROR: cannot import the API package: {exc}", file=sys.stderr)
        return 1

    try:
        with SessionLocal() as session:
            results = check_scenes(
                session, slug=args.scene, limit=args.limit, repair=args.repair
            )
    except Exception as exc:  # pragma: no cover - DB error
        print(f"ERROR: consistency check failed: {exc}", file=sys.stderr)
        return 1

    payload = [result.as_dict() for result in results]
    if args.json:
        print(json.dumps({"scenes": payload, "ok": all(r.ok for r in results)}, indent=2))
    else:
        for item in payload:
            if item["ok"]:
                status = "OK"
            elif item["repairable"]:
                status = "REPAIRABLE"
            else:
                status = "FAIL"
            print(f"[{status}] {item['slug']} current={item['assetVersion'] or '-'}")
            for problem in item["problems"]:
                print(f"    problem: {problem}")
            for repaired in item["repaired"]:
                print(f"    repaired: {repaired}")
            for note in item["notes"]:
                print(f"    note: {note}")
        total = len(results)
        bad = sum(1 for item in results if not item["ok"])
        print(f"\n{total} scene(s) checked, {bad} inconsistent, "
              f"{'repair requested' if args.repair else 'read-only'}")

    return 0 if all(result.ok for result in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
