"""FIX-06.2 tests — production acceptance script final closure.

Covers the two confirmed software blockers + the runbook sync:

  TestAssetGetRoutes        — the real FastAPI asset GET surface (the API is
                             GET-only; the smoke must test GET, never HEAD):
                             current manifest → 200 + `public, no-cache`,
                             version manifest → 200 + immutable, Range 206 +
                             Content-Range + body, invalid Range → 416.
  TestSmokeUsesRealGet      — static regression: the smoke's asset block uses
                             the g()/hdr() GET helper and contains NO
                             `curl -I` / `-sI` / `--head` (SPA + root security
                             headers may keep HEAD — they are not assets).
  TestSmokeManifestFilename — smoke_manifest returns/emits the REAL entry
                             filename (the smoke must not re-hardcode
                             `lod-meta.json`), and the smoke wires `$ENTRY_FILE`.
  TestPreflightModes        — host mode passes on a fresh host with no
                             `current`; release mode REQUIRES a release; host
                             production enforces `GS_RATE_LIMIT_BACKEND=redis`;
                             host DB/Redis probes use pg_isready/redis-cli (not
                             SQLAlchemy / the Python redis package); release mode
                             keeps its full integrity contract.
  TestEnvFileLoading        — preflight reads GS_ENV_FILE safely (no expansion)
                             so host/deploy/systemd share one env source.

Everything runs against the REAL repo scripts; nothing is mocked away except
the PostgreSQL/Redis probe commands (PATH stubs) so a fresh-host simulation can
run on any machine.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.paths import get_repo_root
from app.main import app
from tests.conftest_scenes import create_scene

SCRIPTS = get_repo_root() / "deploy" / "scripts"
BASH = shutil.which("bash") or "/usr/bin/bash"
SMOKE_SH = SCRIPTS / "smoke_test.sh"
SMOKE_MANIFEST_PY = SCRIPTS / "smoke_manifest.py"
PREFLIGHT_SH = SCRIPTS / "preflight.sh"
LIB_ENV_SH = SCRIPTS / "lib_env.sh"


@pytest.fixture
def anon_client():
    from app.core.identity import get_optional_current_user

    app.dependency_overrides[get_optional_current_user] = lambda: None
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_optional_current_user, None)


# ── Real FastAPI asset GET surface (GET-only API; smoke must mirror it) ────
@pytest.fixture
def origin(tmp_path_factory, monkeypatch):
    root = tmp_path_factory.mktemp("fix062-origin")
    monkeypatch.setattr(settings, "scene_origin_root", str(root))
    return root


ENTRY_BYTES = b"L" * 4096


def _write_manifest_origin(origin, slug: str) -> None:
    """Publish the real manifest contract under <slug>/versions/v1/:
    manifest.json (stream.entryUrl=versions/v1/lod-meta.json) + lod-meta.json,
    with current -> versions/v1 (the mutable symlink the viewer reads).
    """
    import os

    ver = origin / slug / "versions" / "v1"
    ver.mkdir(parents=True, exist_ok=True)
    (ver / "manifest.json").write_text(
        json.dumps({"stream": {"entryUrl": "versions/v1/lod-meta.json"}}), encoding="utf-8"
    )
    (ver / "lod-meta.json").write_bytes(ENTRY_BYTES)
    current = origin / slug / "current"
    if not (current.is_symlink() or current.exists()):
        os.symlink("versions/v1", current, target_is_directory=True)


def _public_scene(db) -> str:
    scene = create_scene(
        session=db,
        visibility="PUBLIC",
        status="PUBLISHED",
        slug=f"f062-{uuid.uuid4().hex[:8]}",
    )
    return scene.slug


class TestAssetGetRoutes:
    def test_get_current_manifest_200_no_cache(self, db, origin, anon_client):
        slug = _public_scene(db)
        _write_manifest_origin(origin, slug)
        resp = anon_client.get(f"/api/v1/scenes/{slug}/assets/current/manifest.json")
        assert resp.status_code == 200
        # FIX-05C: current/* is the mutable alias → public, no-cache (never immutable).
        assert resp.headers["cache-control"] == "public, no-cache"
        assert json.loads(resp.content)["stream"]["entryUrl"] == "versions/v1/lod-meta.json"

    def test_get_version_manifest_200_immutable(self, db, origin, anon_client):
        slug = _public_scene(db)
        _write_manifest_origin(origin, slug)
        resp = anon_client.get(f"/api/v1/scenes/{slug}/assets/versions/v1/manifest.json")
        assert resp.status_code == 200
        # FIX-05C: versions/<ver>/* is content-addressed → immutable.
        assert (
            resp.headers["cache-control"] == "public, max-age=31536000, immutable"
        )

    def test_get_range_206_content_range_and_body(self, db, origin, anon_client):
        slug = _public_scene(db)
        _write_manifest_origin(origin, slug)
        resp = anon_client.get(
            f"/api/v1/scenes/{slug}/assets/current/lod-meta.json",
            headers={"Range": "bytes=0-1023"},
        )
        assert resp.status_code == 206
        assert resp.headers["content-range"] == "bytes 0-1023/4096"
        assert len(resp.content) == 1024
        assert resp.content == ENTRY_BYTES[:1024]

    def test_get_invalid_range_416(self, db, origin, anon_client):
        slug = _public_scene(db)
        _write_manifest_origin(origin, slug)
        resp = anon_client.get(
            f"/api/v1/scenes/{slug}/assets/current/lod-meta.json",
            headers={"Range": "bytes=999999999999-"},
        )
        assert resp.status_code == 416


# ── Static regression: the smoke's asset block must be real GET (FIX-06.2 §10) ──
class TestSmokeUsesRealGet:
    def _asset_block(self) -> str:
        text = SMOKE_SH.read_text(encoding="utf-8")
        start = text.index("── 4.")
        end = text.index("── 6.")
        return text[start:end]

    def test_asset_block_has_no_head(self):
        block = self._asset_block()
        for banned in ("curl -I", "curl -sI", "--head", "curl -skI", " -I "):
            assert banned not in block, f"scene-asset smoke must not use HEAD ({banned!r})"

    def test_whole_script_never_uses_curl_head_flag(self):
        text = SMOKE_SH.read_text(encoding="utf-8")
        assert "curl --head" not in text
        # The only HEAD usages are SPA routes + root security headers, which are
        # static Nginx files (legitimate, and NOT scene assets).
        assert text.count("C -sI") == 2

    def test_asset_block_uses_get_helper(self):
        block = self._asset_block()
        # Every asset status code comes from the real-GET helper g().
        assert block.count("$(g ") >= 4
        assert "hdr \"cache-control\"" in block
        assert "hdr \"content-range\"" in block


# ── smoke_manifest emits the real entry filename (§7) ──────────────────────
class TestSmokeManifestFilename:
    def _parse(self, manifest):
        sys.path.insert(0, str(SCRIPTS))
        import smoke_manifest  # noqa: PLC0415

        return smoke_manifest.parse_entry_url(manifest)

    def test_parse_returns_real_filename(self):
        # A contract drift (a different entry filename) must flow through.
        vp, fn = self._parse({"stream": {"entryUrl": "versions/abc/custom-entry.bin"}})
        assert vp == "versions/abc"
        assert fn == "custom-entry.bin"

    def test_cli_emits_version_path_and_filename(self, tmp_path):
        m = tmp_path / "manifest.json"
        m.write_text(
            '{"stream": {"entryUrl": "versions/abc123/lod-meta.json"}}', encoding="utf-8"
        )
        out = subprocess.run(  # noqa: S603 - our own tracked script
            [sys.executable, str(SMOKE_MANIFEST_PY), "--manifest", str(m)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert out.returncode == 0, out.stderr
        assert out.stdout.split() == ["versions/abc123", "lod-meta.json"]

    def test_smoke_wires_entry_filename(self):
        text = SMOKE_SH.read_text(encoding="utf-8")
        # The versioned-entry URL uses the parser's filename, not a hardcoded one.
        assert "ENTRY_FILE" in text
        assert "assets/$VER_PATH/$ENTRY_FILE" in text


# ── preflight host/release mode split (§13-§21, §23) ────────────────────────
def _write_probe_stubs(bin_dir: Path) -> None:
    """PATH stubs so a fresh-host simulation can run anywhere (no real PG/Redis)."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    (bin_dir / "pg_isready").write_text(
        "#!/bin/bash\necho 'localhost:5432 - accepting connections'\nexit 0\n"
    )
    (bin_dir / "redis-cli").write_text("#!/bin/bash\necho PONG\nexit 0\n")
    for name in ("pg_isready", "redis-cli"):
        os.chmod(bin_dir / name, 0o700)  # owner-exec stub; S103 wants non-777


def _run_preflight(
    tmp_path: Path,
    *,
    environment: str = "staging",
    mode: str | None = "host",
    extra_env: dict | None = None,
    stubs: bool = True,
) -> subprocess.CompletedProcess:
    deploy_root = tmp_path / "deploy"
    deploy_root.mkdir(exist_ok=True)
    storage = tmp_path / "storage"
    (storage / "scene-origin").mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "DEPLOY_ROOT": str(deploy_root),
        "GS_STORAGE_ROOT": str(storage),
        "GS_SCENE_ORIGIN_ROOT": str(storage / "scene-origin"),
        "GS_ENV_LOADED": "1",  # do not pick up a stray /etc/gsplatform/env
        "GS_DATABASE_URL": "postgresql+psycopg2://u:p@127.0.0.1:5432/gsplatform",
        "GS_REDIS_URL": "redis://127.0.0.1:6379/0",
    }
    if stubs:
        bin_dir = tmp_path / "bin"
        _write_probe_stubs(bin_dir)
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
    if extra_env:
        env.update(extra_env)
    argv = ["bash", str(PREFLIGHT_SH), "--environment", environment]
    if mode:
        argv += ["--mode", mode]
    return subprocess.run(  # noqa: S603 - our own tracked script
        argv, capture_output=True, text=True, timeout=120, env=env
    )


class TestPreflightModes:
    def test_host_mode_passes_on_fresh_host_without_current(self, tmp_path):
        """Case 1 / §40: a fresh host has no current/venv/dist/torch/gsplat —
        host mode must still PASS (only the host contract is checked)."""
        res = _run_preflight(tmp_path, environment="staging", mode="host")
        assert res.returncode == 0, res.stdout + res.stderr
        assert "RESULT: PASS" in res.stdout
        assert "mode=host" in res.stdout

    def test_default_mode_is_host(self, tmp_path):
        """Legacy calls without --mode must not deadlock on a fresh host."""
        res = _run_preflight(tmp_path, environment="staging", mode=None)
        assert res.returncode == 0, res.stdout + res.stderr
        assert "mode=host" in res.stdout

    def test_release_mode_requires_current(self, tmp_path):
        """Case 2: release mode with no current release MUST fail."""
        res = _run_preflight(tmp_path, environment="staging", mode="release")
        assert res.returncode == 1, res.stdout
        assert "RESULT: FAIL" in res.stdout
        assert "current" in res.stdout

    def test_host_production_rejects_memory_rate_limiter(self, tmp_path):
        """Case 3: production + GS_RATE_LIMIT_BACKEND=memory MUST fail (host gate)."""
        res = _run_preflight(
            tmp_path,
            environment="production",
            mode="host",
            extra_env={
                "GS_RATE_LIMIT_BACKEND": "memory",
                # Satisfy the other production host checks so only the limiter fails.
                "GS_DEV_IDENTITY_ENABLED": "false",
                "GS_ENV_FILE": str(_write_env_file(tmp_path)),
            },
        )
        assert res.returncode == 1, res.stdout
        assert "GS_RATE_LIMIT_BACKEND" in res.stdout
        assert "redis" in res.stdout

    def test_host_production_accepts_redis_backend(self, tmp_path):
        res = _run_preflight(
            tmp_path,
            environment="production",
            mode="host",
            extra_env={
                "GS_RATE_LIMIT_BACKEND": "redis",
                "GS_DEV_IDENTITY_ENABLED": "false",
                "GS_ENV_FILE": str(_write_env_file(tmp_path)),
            },
        )
        assert res.returncode == 0, res.stdout + res.stderr
        assert "RESULT: PASS" in res.stdout

    def test_host_probes_use_cli_tools_not_python_packages(self):
        """Case 4: host DB/Redis probes must not import SQLAlchemy / the Python
        redis package — a fresh host has neither installed."""
        text = PREFLIGHT_SH.read_text(encoding="utf-8")
        assert "pg_isready" in text
        assert "redis-cli" in text
        # The old python-based host probes must be gone.
        assert "from sqlalchemy import create_engine" not in text
        assert "_r.Redis.from_url" not in text
        assert "import redis" not in text

    def test_release_mode_keeps_full_integrity_contract(self):
        """Splitting the modes must not weaken the release checks."""
        text = PREFLIGHT_SH.read_text(encoding="utf-8")
        assert 'if [[ "$MODE" == "release" ]]' in text
        for marker in (
            ".git-commit-hash",
            "apps/web/dist/index.html",
            "app/storage/base.py",
            'CELERY_BIN="${API_VENV}/bin/celery"',
            "workers.celery_app",
            "verify_reconstruction_runtime.py",
            "alembic current == head",
            "nginx -t",
        ):
            assert marker in text, f"release-mode check lost: {marker}"

    def test_postgresql_driver_suffix_stripped_for_pg_isready(self):
        """libpq rejects SQLAlchemy's +psycopg2 suffix — the host probe must
        strip the driver suffix before passing GS_DATABASE_URL to pg_isready."""
        text = PREFLIGHT_SH.read_text(encoding="utf-8")
        # The safe suffix-strip is present (only the driver suffix is removed).
        assert "${GS_DATABASE_URL//+psycopg2/}" in text
        assert 'pg_isready -d "$LIBPQ_URL"' in text


def _write_env_file(tmp_path: Path) -> Path:
    env_file = tmp_path / "env"
    env_file.write_text(
        "# comment line\n"
        "GS_DATABASE_URL=postgresql+psycopg2://u:p@127.0.0.1:5432/gsplatform\n"
        "GS_REDIS_URL=redis://127.0.0.1:6379/0\n"
        "GS_RATE_LIMIT_BACKEND=redis\n"
        "GS_DEV_IDENTITY_ENABLED=false\n",
        encoding="utf-8",
    )
    return env_file


class TestEnvFileLoading:
    def test_preflight_loads_env_file_safely(self, tmp_path):
        """§24: preflight must read GS_ENV_FILE so host/deploy/systemd share one
        env source; values must NOT be shell-expanded (a '$' in a password stays)."""
        env_file = tmp_path / "env"
        env_file.write_text(
            "# comment\n"
            "GS_RATE_LIMIT_BACKEND=redis\n"
            "GS_SECRET_KEY=pa$$word$with$dollars\n",
            encoding="utf-8",
        )
        res = subprocess.run(  # noqa: S603 - our own tracked script
            [
                BASH,
                str(PREFLIGHT_SH),
                "--environment",
                "production",
                "--mode",
                "host",
            ],
            capture_output=True,
            text=True,
            timeout=120,
            env={
                **os.environ,
                "DEPLOY_ROOT": str(tmp_path / "deploy"),
                "GS_STORAGE_ROOT": str(tmp_path),
                "GS_ENV_FILE": str(env_file),
                # strip inherited env so the file is the only source
                **{k: "" for k in ("GS_RATE_LIMIT_BACKEND",)},
            },
        )
        # The rate-limiter gate must read GS_RATE_LIMIT_BACKEND=redis from the file.
        assert "GS_RATE_LIMIT_BACKEND=redis" in res.stdout, res.stdout + res.stderr
        # And the secret must never appear in the log output.
        assert "pa$$word" not in res.stdout

    def test_lib_env_loader_does_not_expand(self, tmp_path):
        # Direct loader test: '$' in a value is preserved verbatim.
        script = tmp_path / "load.sh"
        env_file = tmp_path / "env"
        env_file.write_text('GS_SECRET_KEY=pa$$word\n', encoding="utf-8")
        script.write_text(
            f'. "{LIB_ENV_SH}"\nGS_ENV_FILE="{env_file}"\nload_gsplatform_env\n'
            'printf "%s" "$GS_SECRET_KEY"\n',
            encoding="utf-8",
        )
        out = subprocess.run(  # noqa: S603 - our own tracked script
            [BASH, str(script)], capture_output=True, text=True, timeout=30
        )
        assert out.stdout == "pa$$word"
