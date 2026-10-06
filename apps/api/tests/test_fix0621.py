"""FIX-06.2.1 tests — final deploy-path closure.

Closes the three confirmed items without touching SuperSplat/Viewer/XR/LOD/
cache/schema/UI:

  TestReleasePreflightCwd (1-4) — A: release preflight is cwd-INDEPENDENT.
      Reproduces the real deploy chain (deploy_release step 5 leaves the shell
      in <release>/apps/api; step 6b runs preflight --mode release from that
      cwd).  `workers` is NOT in the wheel (packages = ["app"]) so
      `import workers.celery_app` only resolves from the release ROOT.  The
      preflight must root its own import closure at CURRENT_ROOT — never the
      caller's cwd and never PYTHONPATH (the tests explicitly unset it).
      The release tree is built from `git archive HEAD` (a CLEAN tracked tree,
      not the dev checkout) + the real shared venv (recon contract) + a real
      web dist.

  TestRollbackFailClosed (5-8) — B: first-deploy failure removes `current`;
      upgrade failure restores the previous release; the failed release dir is
      never deleted; an unknown `current` target is REFUSED (no destructive
      action).  Uses REAL temp dirs + symlinks and the real lib_rollback.sh —
      ln/mv/readlink/rm are never mocked.

  TestSmokeTls (9-11) — C: production smoke is strict-TLS by default (no -k);
      `--insecure` is forbidden in production and an explicit staging opt-in.

  TestSmokeAssetStillGet (12) — regression guard: the scene-asset smoke block
      remains real GET (no curl -I / --head), per FIX-06.2 §24.

Nothing here touches SceneAssetService / cache policy / nginx cache semantics.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

from app.core.paths import get_repo_root

REPO = get_repo_root()
SCRIPTS = REPO / "deploy" / "scripts"
BASH = shutil.which("bash") or "/usr/bin/bash"
GIT = shutil.which("git") or "/usr/bin/git"
TAR = shutil.which("tar") or "/usr/bin/tar"
PREFLIGHT_SH = SCRIPTS / "preflight.sh"
SMOKE_SH = SCRIPTS / "smoke_test.sh"
LIB_ROLLBACK_SH = SCRIPTS / "lib_rollback.sh"
LIB_ENV_SH = SCRIPTS / "lib_env.sh"
SHARED_VENV = REPO / "apps" / "api" / ".venv"
WEB_DIST = REPO / "apps" / "web" / "dist"

# The same dev PostgreSQL the backend suite runs against (already at the single
# alembic head) — used so release-mode [L] (alembic current == head) is a REAL
# check, and pg_isready/redis-cli probes pass via PATH stubs.
DEV_DATABASE_URL = "postgresql+psycopg2://postgres:postgres@127.0.0.1:5432/gsplatform"


# ── Clean release tree from `git archive HEAD` (§28) ────────────────────────
@dataclass
class ReleaseFixture:
    release: Path            # <deploy_root>/releases/r1 (archived tracked tree)
    deploy_root: Path        # DEPLOY_ROOT
    current: Path            # DEPLOY_ROOT/current → release
    env: dict                # subprocess env for preflight (PYTHONPATH removed)


@pytest.fixture(scope="module")
def release_tree(tmp_path_factory) -> ReleaseFixture:
    """Build a clean release exactly like deploy_release.sh step 2/3 does —
    `git archive HEAD` into releases/r1, then materialize the venv (the shared
    recon-contract venv) + a real web dist + release metadata.  Scope is
    MODULE: gsplat's JIT CUDA extension recompiles per working directory
    (verified empirically), so all cwd tests share ONE release tree and the
    single one-time ~2-3min compile happens in fixture setup; every test's
    [K] recon verify is then warm.  The real clean-venv dimension is covered
    by the clean-checkout gate (verify_release_source.sh §34)."""
    if not (WEB_DIST / "index.html").is_file():
        pytest.skip("apps/web/dist missing — run `pnpm build` first")
    tmp_path = tmp_path_factory.mktemp("fix0621-release")
    deploy_root = tmp_path / "deploy_root"
    (deploy_root / "releases").mkdir(parents=True)
    release = deploy_root / "releases" / "r1"
    release.mkdir()

    # 1. clean tracked tree (never the working checkout)
    tar = subprocess.run(  # noqa: S603 - our own tracked git/tar, fixed args
        [GIT, "archive", "--format=tar", "HEAD"],
        cwd=REPO, capture_output=True, check=True, timeout=60,
    ).stdout
    subprocess.run(  # noqa: S603 - our own tracked git/tar, fixed args
        [TAR, "-xf", "-", "-C", str(release)],
        input=tar, check=True, timeout=60,
    )
    head = subprocess.run(  # noqa: S603 - our own tracked git, fixed args
        [GIT, "rev-parse", "HEAD"], cwd=REPO,
        capture_output=True, check=True,
    ).stdout.decode().strip()
    (release / ".git-commit-hash").write_text(head + "\n", encoding="utf-8")

    # 2. real venv (recon contract: torch/gsplat/celery) + real web dist
    (release / "apps" / "api" / ".venv").symlink_to(SHARED_VENV, target_is_directory=True)
    shutil.copytree(WEB_DIST, release / "apps" / "web" / "dist")

    # 3. storage skeleton (so host [A] dir checks + df pass)
    storage = tmp_path / "storage"
    for sub in ("staging", "published", "quarantine", "logs", "scene-origin"):
        (storage / sub).mkdir(parents=True, exist_ok=True)

    # 4. current → release (step 6 of deploy_release)
    (deploy_root / "current").symlink_to(release, target_is_directory=True)

    # 5. PATH stubs for the host DB/Redis probes (test_fix062 style)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    (bin_dir / "pg_isready").write_text(
        "#!/bin/bash\necho 'localhost:5432 - accepting connections'\nexit 0\n")
    (bin_dir / "redis-cli").write_text("#!/bin/bash\necho PONG\nexit 0\n")
    for name in ("pg_isready", "redis-cli"):
        (bin_dir / name).chmod(0o700)

    # 6. env WITHOUT PYTHONPATH (§27): the release must not depend on the
    #    developer shell; a fresh host has no PYTHONPATH.
    env = {**os.environ}
    env.pop("PYTHONPATH", None)
    env.update({
        "DEPLOY_ROOT": str(deploy_root),
        "GS_STORAGE_ROOT": str(storage),
        "GS_SCENE_ORIGIN_ROOT": str(storage / "scene-origin"),
        "GS_ENV_FILE": str(tmp_path / "no-such.env"),  # staging: env file absent → warn
        "GS_DATABASE_URL": DEV_DATABASE_URL,           # real alembic current==head check
        "PATH": f"{bin_dir}:{env['PATH']}",
    })
    # Warm the one-time gsplat CUDA JIT compile now (setup, not test time) so
    # every test's [K] recon verify is fast.  Runs with the real venv python —
    # the same interpreter the preflight [K] check uses.
    warm = subprocess.run(  # noqa: S603 - our own tracked script, fixed inputs
        [str(SHARED_VENV / "bin" / "python"),
         str(release / "deploy" / "scripts" / "verify_reconstruction_runtime.py")],
        cwd=str(release), env=env, capture_output=True, text=True, timeout=400,
    )
    if warm.returncode != 0:
        raise RuntimeError(
            "recon runtime warm-up FAILED:\n" + warm.stdout + warm.stderr
        )
    return ReleaseFixture(release=release, deploy_root=deploy_root,
                          current=deploy_root / "current", env=env)


def _run_release_preflight(rf: ReleaseFixture, cwd: Path, *, use_archived: bool = True):
    """Invoke preflight --mode release from a given cwd, PYTHONPATH unset."""
    script = rf.release / "deploy" / "scripts" / "preflight.sh" if use_archived \
        else PREFLIGHT_SH
    res = subprocess.run(  # noqa: S603 - our own tracked script, fixed inputs
        [BASH, str(script), "--environment", "staging", "--mode", "release"],
        cwd=str(cwd), env=rf.env, capture_output=True, text=True, timeout=240,
    )
    return res


class TestReleasePreflightCwd:
    def test_from_release_root_passes(self, release_tree):
        """§6 Case A — cwd = <release root> → PASS."""
        res = _run_release_preflight(release_tree, release_tree.release)
        assert res.returncode == 0, res.stdout + res.stderr
        assert "release import closure" in res.stdout
        assert "RESULT: PASS" in res.stdout

    def test_from_release_apps_api_passes_pythonpath_unset(self, release_tree):
        """§6 Case B — cwd = <release>/apps/api (deploy step 5 leaves the shell
        here) + PYTHONPATH explicitly absent → workers import PASS."""
        assert "PYTHONPATH" not in release_tree.env  # §27: must be documented
        res = _run_release_preflight(release_tree, release_tree.release / "apps" / "api")
        assert res.returncode == 0, res.stdout + res.stderr
        assert "workers.celery_app" in res.stdout
        assert "release import closure" in res.stdout

    def test_from_tmp_passes_pythonpath_unset(self, release_tree, tmp_path):
        """§6 Case C — cwd = /tmp + PYTHONPATH absent → workers import PASS."""
        assert "PYTHONPATH" not in release_tree.env
        res = _run_release_preflight(release_tree, tmp_path)
        assert res.returncode == 0, res.stdout + res.stderr
        assert "release import closure" in res.stdout

    def test_deploy_real_cwd_simulation_passes(self, release_tree):
        """§7 — the actual deploy chain: step 5 cd apps/api → step 6 current →
        step 6b invoke RELEASE_DIR/deploy/scripts/preflight.sh --mode release
        from that cwd, PYTHONPATH unset → workers import PASS.  This is the A
        item's final acceptance basis."""
        deploy = release_tree
        # current must resolve to the release (step 6 already done in fixture)
        assert os.path.realpath(str(deploy.current)) == os.path.realpath(str(deploy.release))
        res = subprocess.run(  # noqa: S603 - our own tracked script, fixed inputs
            [BASH, str(deploy.release / "deploy" / "scripts" / "preflight.sh"),
             "--environment", "staging", "--mode", "release"],
            cwd=str(deploy.release / "apps" / "api"),
            env=deploy.env, capture_output=True, text=True, timeout=240,
        )
        assert res.returncode == 0, res.stdout + res.stderr
        assert "workers.celery_app" in res.stdout
        assert "release import closure" in res.stdout

    def test_preflight_uses_current_root_cwd_contract(self):
        """Static contract: [I] roots its imports at CURRENT_ROOT (subshell cd),
        never the caller's cwd, and never injects a global PYTHONPATH."""
        text = PREFLIGHT_SH.read_text(encoding="utf-8")
        assert 'cd "$CURRENT_ROOT" &&' in text
        assert "import workers.celery_app" in text
        assert "export PYTHONPATH" not in text  # no global PYTHONPATH pollution


# ── B: fail-closed `current` rollback (real symlinks, real lib_rollback.sh) ──
def _run_rollback(deploy_root: Path, new_release: str, previous: str):
    script = (
        'set -euo pipefail\n'
        f'. "{LIB_ROLLBACK_SH}"\n'
        f'export DEPLOY_ROOT="{deploy_root}"\n'
        f'rollback_current "{new_release}" "{previous}"\n'
    )
    return subprocess.run(  # noqa: S603 - our own tracked script, fixed inputs
        [BASH, "-c", script], capture_output=True, text=True, timeout=30,
    )


class TestRollbackFailClosed:
    def _mk(self, p: Path) -> Path:
        p.mkdir()
        return p

    def test_first_deploy_failure_removes_current(self, tmp_path):
        """§12 — CASE 2: first deploy (no previous), forced preflight failure:
        `current` must be REMOVED (never left pointing at the failed release)."""
        deploy_root = self._mk(tmp_path / "deploy_root")
        new_rel = self._mk(tmp_path / "new_release")
        (deploy_root / "current").symlink_to(new_rel, target_is_directory=True)
        res = _run_rollback(deploy_root, str(new_rel), "")
        assert res.returncode == 0, res.stdout + res.stderr
        assert not (deploy_root / "current").exists()  # symlink gone
        assert not os.path.islink(str(deploy_root / "current"))

    def test_first_deploy_keeps_failed_release_dir(self, tmp_path):
        """§12/§13 — rollback must NEVER delete the release directory (kept for
        diagnostics); only the `current` symlink is unlinked."""
        deploy_root = self._mk(tmp_path / "deploy_root")
        new_rel = self._mk(tmp_path / "new_release")
        (new_rel / "build-artifact").write_text("keep me", encoding="utf-8")
        (deploy_root / "current").symlink_to(new_rel, target_is_directory=True)
        res = _run_rollback(deploy_root, str(new_rel), "")
        assert res.returncode == 0, res.stdout + res.stderr
        assert new_rel.is_dir()
        assert (new_rel / "build-artifact").is_file()

    def test_upgrade_failure_restores_previous(self, tmp_path):
        """§13 — CASE 1: previous release exists; forced preflight failure
        restores `current` → previous."""
        deploy_root = self._mk(tmp_path / "deploy_root")
        prev_rel = self._mk(tmp_path / "prev_release")
        new_rel = self._mk(tmp_path / "new_release")
        (deploy_root / "current").symlink_to(new_rel, target_is_directory=True)
        res = _run_rollback(deploy_root, str(new_rel), str(prev_rel))
        assert res.returncode == 0, res.stdout + res.stderr
        assert os.path.realpath(str(deploy_root / "current")) == \
            os.path.realpath(str(prev_rel))
        assert os.path.realpath(str(deploy_root / "current")) != \
            os.path.realpath(str(new_rel))

    def test_refuses_unknown_current_target(self, tmp_path):
        """§11 — current not resolving to the failed release: refuse (no
        destructive action), non-zero exit, symlink untouched."""
        deploy_root = self._mk(tmp_path / "deploy_root")
        new_rel = self._mk(tmp_path / "new_release")
        other = self._mk(tmp_path / "other_operator_release")
        (deploy_root / "current").symlink_to(other, target_is_directory=True)
        res = _run_rollback(deploy_root, str(new_rel), "")
        assert res.returncode != 0  # refuse → fail-closed
        assert os.path.realpath(str(deploy_root / "current")) == \
            os.path.realpath(str(other))  # untouched
        assert "REFUSE" in res.stdout + res.stderr


# ── C: production smoke strict TLS (§16-§22) ─────────────────────────────────
def _run_smoke(environment: str, extra: list[str]):
    argv = [BASH, str(SMOKE_SH), "--environment", environment, *extra]
    return subprocess.run(  # noqa: S603 - our own tracked script, fixed inputs
        argv, capture_output=True, text=True, timeout=120,
    )


class TestSmokeTls:
    def test_production_default_strict_tls(self):
        """§16/§19/§21 — no global -k/--insecure; TLS args are conditional."""
        text = SMOKE_SH.read_text(encoding="utf-8")
        assert "CURL_TLS_ARGS=()" in text                 # default: strict
        assert 'C() { curl -sS "${CURL_TLS_ARGS[@]}"' in text
        assert "curl -sk" not in text                     # old insecure default gone
        assert "curl --insecure" not in text              # never a raw curl flag
        assert '[[ "$INSECURE" -eq 1 ]] && CURL_TLS_ARGS=(-k)' in text

    def test_production_rejects_insecure(self):
        """§18/§21 — production + --insecure → non-zero, forbidden message."""
        res = _run_smoke("production", ["--insecure", "--base-url", "https://127.0.0.1:1"])
        assert res.returncode != 0
        assert "forbidden in production" in res.stdout + res.stderr

    def test_staging_accepts_insecure(self):
        """§17/§21 — staging + --insecure is an accepted explicit opt-in (the
        run proceeds; it FAILs only because the target site is unreachable)."""
        res = _run_smoke("staging", ["--insecure", "--base-url", "https://127.0.0.1:1"])
        out = res.stdout + res.stderr
        assert "forbidden in production" not in out        # accepted, not rejected
        assert "GSPlatform Smoke Test" in out              # proceeded past arg parse
        assert res.returncode != 0                          # site unreachable → smoke FAIL


class TestSmokeAssetStillGet:
    def _asset_block(self) -> str:
        text = SMOKE_SH.read_text(encoding="utf-8")
        return text[text.index("── 4."):text.index("── 6.")]

    def test_asset_block_remains_real_get(self):
        """§24 — scene assets stay GET (no curl -I / -sI / --head re-introduced
        by the TLS refactor)."""
        block = self._asset_block()
        for banned in ("curl -I", "curl -sI", "--head", "curl -skI", " -I "):
            assert banned not in block, f"scene-asset smoke must not use HEAD ({banned!r})"
        assert block.count("$(g ") >= 4
        assert 'hdr "cache-control"' in block
        assert 'hdr "content-range"' in block
