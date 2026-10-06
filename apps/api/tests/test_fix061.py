"""FIX-06.1 tests — final software closure gates.

Groups (spec §二 A–D):
  TestReconstructionRuntimeFile — tracked reconstruction contract file + verify
                                  script (GPU runtime reproducibility, issue A)
  TestSmokeManifestParser       — stream.entryUrl parser regression (issue C)
  TestProductionConfigGuard     — production refuses memory limiter, accepts redis (issue B)
  TestConcurrentComplete        — concurrent complete, 2 DB sessions + barrier →
                                  1 Scene / 1 Job / 1 dispatch / same jobId (issue D)
  TestUploadWriteCsrfMatrix     — PATCH / complete / DELETE CSRF matrix (issue D)
  TestComputeReconstructCsrf    — POST /compute/reconstruct CSRF reaches business
                                  validation, never mocked (issue D)
"""

from __future__ import annotations

import subprocess
import sys
import threading
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.identity import RequestIdentity, _resolve_dev_user_id
from app.core.paths import get_repo_root
from app.db.session import SessionLocal
from app.main import app
from app.storage import LocalDiskStorage

client = TestClient(app)


# ── helpers ─────────────────────────────────────────────────────────────────
def _repo() -> Path:
    return get_repo_root()


def _dev_identity() -> RequestIdentity:
    return RequestIdentity(
        user_id=_resolve_dev_user_id(settings),
        email="dev@gsplatform.local",
        display_name="本地开发用户",
        source="dev",
    )


# ── issue A: reconstruction runtime files (tracked + pinned) ────────────────
class TestReconstructionRuntimeFile:
    def test_requirements_contract_file_tracked(self):
        reqs = _repo() / "deploy" / "requirements-reconstruction.txt"
        assert reqs.is_file(), "deploy/requirements-reconstruction.txt missing"
        text = reqs.read_text(encoding="utf-8")
        assert "torch==2.14.0+cu126" in text, "contract must pin torch==2.14.0+cu126"
        assert "gsplat==1.5.3" in text, "contract must pin gsplat==1.5.3"
        assert "cu126" in text, "contract must point at the CUDA 12.6 index"

    def test_verify_script_present_and_contractual(self):
        verify = _repo() / "deploy" / "scripts" / "verify_reconstruction_runtime.py"
        assert verify.is_file(), "verify_reconstruction_runtime.py missing"
        text = verify.read_text(encoding="utf-8")
        assert 'CONTRACT_TORCH = "2.14.0+cu126"' in text
        assert 'CONTRACT_GSPLAT = "1.5.3"' in text
        # The CUDA check must be a real rasterization, exit-non-zero on failure —
        # never a try/except swallow or a print-and-pass.
        assert "from gsplat import rasterization" in text
        assert "torch.cuda.is_available()" in text
        assert "return 1" in text

    def test_verify_script_runs_on_real_venv(self):
        """The working venv must pass the runtime gate (this host has GPUs).

        Skips when the venv lacks the reconstruction runtime: the API-only
        fresh venv in the clean-checkout gate is exactly that case — the
        torch/gsplat runtime is verified there by verify_release_source.sh
        section 8 (fresh recon venv + this same script).
        """
        verify = _repo() / "deploy" / "scripts" / "verify_reconstruction_runtime.py"
        venv_py = _repo() / "apps" / "api" / ".venv" / "bin" / "python"
        if not (venv_py.is_file() and venv_py.exists()):
            pytest.skip("apps/api/.venv not present — nothing to verify")
        probe = subprocess.run(  # noqa: S603 - our own tracked venv
            [str(venv_py), "-c", "import torch, gsplat; print('RUNTIME_OK')"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if probe.returncode != 0:
            pytest.skip("apps/api/.venv has no torch/gsplat — recon runtime gate is separate")
        out = subprocess.run(  # noqa: S603 - our own tracked venv + verify script
            [str(venv_py), str(verify)],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(_repo()),
        )
        assert out.returncode == 0, (
            f"runtime verify failed ({out.returncode}):\n{out.stdout}\n{out.stderr}"
        )
        assert "RESULT: PASS" in out.stdout
        assert "torch 2.14.0+cu126" in out.stdout
        assert "gsplat 1.5.3" in out.stdout


# ── issue C: smoke entryUrl parser regression ───────────────────────────────
class TestSmokeManifestParser:
    @pytest.fixture(scope="class", autouse=True)
    def _import_parser(self):
        sys.path.insert(0, str(_repo() / "deploy" / "scripts"))

    def _parse(self, manifest):
        import smoke_manifest

        return smoke_manifest.parse_entry_url(manifest)

    def test_valid_entry_url(self):
        assert self._parse(
            {"stream": {"entryUrl": "versions/abc123def456/lod-meta.json"}}
        ) == ("versions/abc123def456", "lod-meta.json")

    def test_valid_long_ver(self):
        ver = "v-" + "0" * 40
        assert self._parse({"stream": {"entryUrl": f"versions/{ver}/lod-meta.json"}}) == (
            f"versions/{ver}",
            "lod-meta.json",
        )

    def test_invalid_not_dict(self):
        with pytest.raises(ValueError, match="JSON 对象"):
            self._parse(["versions/a/b.json"])

    def test_invalid_missing_stream(self):
        with pytest.raises(ValueError, match="stream"):
            self._parse({"entryUrl": "versions/a/lod-meta.json"})

    def test_invalid_stream_not_object(self):
        with pytest.raises(ValueError, match="stream"):
            self._parse({"stream": "versions/a/b"})

    def test_invalid_missing_entry_url(self):
        with pytest.raises(ValueError, match="entryUrl"):
            self._parse({"stream": {"counts": [1]}})

    def test_invalid_empty_entry_url(self):
        with pytest.raises(ValueError, match="entryUrl"):
            self._parse({"stream": {"entryUrl": ""}})

    def test_invalid_entry_url_not_string(self):
        with pytest.raises(ValueError, match="entryUrl"):
            self._parse({"stream": {"entryUrl": ["versions", "a", "b"]}})

    def test_invalid_current_prefix(self):
        # current/* is the mutable pointer — never a version path.
        with pytest.raises(ValueError, match="versions/<ver>/<file>"):
            self._parse({"stream": {"entryUrl": "current/lod-meta.json"}})

    def test_invalid_traversal(self):
        with pytest.raises(ValueError):
            self._parse(
                {"stream": {"entryUrl": "versions/../secrets/x.json"}}
            )
        with pytest.raises(ValueError):
            self._parse(
                {"stream": {"entryUrl": "../versions/x/lod-meta.json"}}
            )

    def test_invalid_too_few_segments(self):
        with pytest.raises(ValueError, match="versions/<ver>/<file>"):
            self._parse({"stream": {"entryUrl": "versions/abc123"}})

    def test_invalid_too_many_segments(self):
        with pytest.raises(ValueError, match="versions/<ver>/<file>"):
            self._parse(
                {"stream": {"entryUrl": "versions/a/b/lod-meta.json"}}
            )

    def test_invalid_empty_version(self):
        with pytest.raises(ValueError):
            self._parse({"stream": {"entryUrl": "versions//lod-meta.json"}})

    def test_invalid_empty_filename(self):
        with pytest.raises(ValueError):
            self._parse({"stream": {"entryUrl": "versions/abc123/"}})

    def test_invalid_dotted_filename(self):
        with pytest.raises(ValueError):
            self._parse({"stream": {"entryUrl": "versions/abc123/.."}})

    def test_cli_prints_version_path(self, tmp_path):
        m = tmp_path / "manifest.json"
        m.write_text(
            '{"stream": {"entryUrl": "versions/abc123/lod-meta.json"}}',
            encoding="utf-8",
        )
        out = subprocess.run(  # noqa: S603 - our own tracked parser script
            [
                sys.executable,
                str(_repo() / "deploy" / "scripts" / "smoke_manifest.py"),
                "--manifest",
                str(m),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert out.returncode == 0, out.stderr
        assert out.stdout.strip() == "versions/abc123"

    def test_cli_fails_on_invalid(self, tmp_path):
        m = tmp_path / "manifest.json"
        m.write_text('{"stream": {"counts": [1]}}', encoding="utf-8")
        out = subprocess.run(  # noqa: S603 - our own tracked parser script
            [
                sys.executable,
                str(_repo() / "deploy" / "scripts" / "smoke_manifest.py"),
                "--manifest",
                str(m),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert out.returncode == 1
        assert "entryUrl" in out.stderr


# ── issue B: production rate-limiter config guard ───────────────────────────
class TestProductionConfigGuard:
    def _simulate_production(self, config_mod, *, backend: str):
        """Flip the cached settings singleton to production semantics and back."""
        original_env = config_mod.settings.env
        original_backend = config_mod.settings.rate_limit_backend
        original_dev = config_mod.settings.dev_identity_enabled
        config_mod.settings.env = "production"
        config_mod.settings.rate_limit_backend = backend
        config_mod.settings.dev_identity_enabled = False  # else the dev-identity guard fires first

        def _restore():
            config_mod.settings.env = original_env
            config_mod.settings.rate_limit_backend = original_backend
            config_mod.settings.dev_identity_enabled = original_dev

        return _restore

    def test_production_rejects_memory_limiter(self, monkeypatch):
        import app.core.config as config_mod
        from app.main import create_app

        restore = self._simulate_production(config_mod, backend="memory")
        try:
            with pytest.raises(RuntimeError, match="GS_RATE_LIMIT_BACKEND"):
                create_app()
        finally:
            restore()

    def test_production_accepts_redis_limiter(self, monkeypatch):
        import app.core.config as config_mod
        from app.main import create_app

        restore = self._simulate_production(config_mod, backend="redis")
        try:
            create_app()  # must not raise
        finally:
            restore()

    def test_development_default_memory_still_boots(self):
        from app.main import create_app

        # Development/test default backend is memory and must keep working.
        assert settings.env == "development"
        assert settings.rate_limit_backend == "memory"
        create_app()

    def test_production_env_example_locks_redis(self):
        example = _repo() / "deploy" / "env" / "production.env.example"
        text = example.read_text(encoding="utf-8")
        assert "GS_RATE_LIMIT_BACKEND=redis" in text


# ── issue D: concurrent complete on real PostgreSQL ─────────────────────────
class TestConcurrentComplete:
    def test_two_sessions_concurrent_complete_one_scene_one_job_one_dispatch(
        self, db
    ):
        from app.db.models.enums import JobKind
        from app.db.models.job import Job
        from app.db.models.scene import Scene
        from app.db.models.upload_session import UploadSession
        from app.services.upload_service import UploadService

        # Set up one finished upload via the dev-identity API path (real bytes).
        uid = self._create_full_upload(size=48)

        dispatched: list[tuple[str, list]] = []
        dispatch_lock = threading.Lock()

        def fake_send(name: str, args=None):
            with dispatch_lock:
                dispatched.append((name, list(args or [])))
            return None

        barrier = threading.Barrier(2)
        results: dict[int, object] = {}

        def run_complete(i: int) -> None:
            session = SessionLocal()
            svc = UploadService(
                session,
                LocalDiskStorage(settings.storage_root),
                settings,
                send_task=fake_send,
            )
            try:
                barrier.wait(timeout=30)
                results[i] = svc.complete(
                    uuid.UUID(uid), _dev_identity(), expected_size=None, client_sha256=None
                )
            finally:
                session.close()

        t1 = threading.Thread(target=run_complete, args=(1,))
        t2 = threading.Thread(target=run_complete, args=(2,))
        t1.start()
        t2.start()
        t1.join(timeout=60)
        t2.join(timeout=60)
        assert not t1.is_alive() and not t2.is_alive(), "complete threads hung"

        out1, out2 = results[1], results[2]
        job1 = getattr(out1, "jobId", None)
        job2 = getattr(out2, "jobId", None)
        assert job1 is not None and job2 is not None
        assert job1 == job2, "both completions must resolve to the SAME job"

        # Exactly one scene, one PUBLISH job, one dispatch.
        us = db.query(UploadSession).filter(UploadSession.id == uuid.UUID(uid)).first()
        assert us is not None and us.scene_id is not None
        scene_count = db.query(Scene).filter(Scene.id == us.scene_id).count()
        assert scene_count == 1, f"expected 1 Scene, got {scene_count}"
        jobs = (
            db.query(Job)
            .filter(Job.scene_id == us.scene_id, Job.kind == JobKind.PUBLISH.value)
            .all()
        )
        assert len(jobs) == 1, f"expected 1 PUBLISH job, got {len(jobs)}"
        assert jobs[0].id == uuid.UUID(str(job1))
        assert len(dispatched) == 1, f"expected 1 dispatch, got {len(dispatched)}"
        assert dispatched[0][0] == "tasks.publish_scene"

    def _create_full_upload(self, size: int) -> str:
        payload = {
            "filename": "test.sog",
            "mime_type": "application/octet-stream",
            "size": size,
            "format": "sog",
            "title": "FIX061 并发",
            "category": "experiment",
            "visibility": "PRIVATE",
        }
        created = client.post("/api/v1/uploads", json=payload)
        assert created.status_code == 201, created.text
        uid = created.json()["uploadId"]
        patched = client.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * size,
            headers={
                "Upload-Offset": "0",
                "Content-Type": "application/octet-stream",
            },
        )
        assert patched.status_code == 200, patched.text
        return uid


# ── issue D: upload write CSRF matrix (PATCH / complete / DELETE) ───────────
class TestUploadWriteCsrfMatrix:
    """Session-mode upload writes: no token → 403, wrong token → 403, correct
    token → passes.  POST create is already covered by FIX-06 TestUploadCsrf;
    this lays the matrix over the three remaining write verbs."""

    @pytest.fixture
    def scope(self, monkeypatch):
        """Real session client + dev_identity off + broker stubbed."""
        import app.core.config as config_mod

        original = config_mod.settings.dev_identity_enabled
        config_mod.settings.dev_identity_enabled = False
        try:
            with TestClient(app) as c:
                email = f"fix061-{uuid.uuid4().hex[:10]}@example.com"
                resp = c.post(
                    "/api/v1/auth/register",
                    json={
                        "email": email,
                        "password": "password-123",
                        "displayName": "FIX061 user",
                    },
                )
                assert resp.status_code == 200, resp.text
                import app.api.v1.uploads as uploads_mod

                monkeypatch.setattr(
                    uploads_mod, "send_task", lambda name, args=None: None
                )
                yield c
        finally:
            config_mod.settings.dev_identity_enabled = original

    def _csrf(self, c) -> str:
        token = c.cookies.get("gs_csrf")
        assert token, "csrf cookie missing"
        return token

    def _create(self, c, csrf: str, **overrides) -> str:
        payload = {
            "filename": "t.sog",
            "mime_type": "application/octet-stream",
            "size": 20,
            "format": "sog",
            "title": "csrf-matrix",
            "category": "experiment",
            "visibility": "PRIVATE",
        }
        payload.update(overrides)
        resp = c.post(
            "/api/v1/uploads",
            json=payload,
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["uploadId"]

    def test_patch_matrix(self, scope, monkeypatch):
        c = scope
        csrf = self._csrf(c)
        uid = self._create(c, csrf)

        for label, headers, want in (
            ("no token", {}, 403),
            ("wrong token", {"X-CSRF-Token": "deadbeef"}, 403),
        ):
            resp = c.patch(
                f"/api/v1/uploads/{uid}",
                content=b"\x00" * 4,
                headers={
                    "Upload-Offset": "0",
                    "Content-Type": "application/octet-stream",
                    **headers,
                },
            )
            assert resp.status_code == want, f"{label}: {resp.text}"

        resp = c.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * 4,
            headers={
                "Upload-Offset": "0",
                "Content-Type": "application/octet-stream",
                "X-CSRF-Token": csrf,
            },
        )
        assert resp.status_code == 200, resp.text

    def test_complete_matrix(self, scope, monkeypatch):
        c = scope
        csrf = self._csrf(c)
        uid = self._create(c, csrf)
        up = c.patch(
            f"/api/v1/uploads/{uid}",
            content=b"\x00" * 20,
            headers={
                "Upload-Offset": "0",
                "Content-Type": "application/octet-stream",
                "X-CSRF-Token": csrf,
            },
        )
        assert up.status_code == 200, up.text

        for label, headers, want in (
            ("no token", {}, 403),
            ("wrong token", {"X-CSRF-Token": "nope"}, 403),
        ):
            resp = c.post(f"/api/v1/uploads/{uid}/complete", json={}, headers=headers)
            assert resp.status_code == want, f"{label}: {resp.text}"

        resp = c.post(
            f"/api/v1/uploads/{uid}/complete",
            json={},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json().get("jobId") is not None

    def test_delete_matrix(self, scope, monkeypatch):
        c = scope
        csrf = self._csrf(c)
        uid = self._create(c, csrf)

        for label, headers, want in (
            ("no token", {}, 403),
            ("wrong token", {"X-CSRF-Token": "wrong"}, 403),
        ):
            resp = c.delete(f"/api/v1/uploads/{uid}", headers=headers)
            assert resp.status_code == want, f"{label}: {resp.text}"

        resp = c.delete(
            f"/api/v1/uploads/{uid}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text


# ── issue D: compute reconstruct CSRF reaches business validation ───────────
class TestComputeReconstructCsrf:
    """The CSRF dependency must never be mocked out — with a correct token the
    request must reach submit_reconstruction's business validation (a 404 for an
    unknown upload), not fail at the CSRF gate (403)."""

    @pytest.fixture
    def session_client(self, monkeypatch):
        import app.core.config as config_mod

        original = config_mod.settings.dev_identity_enabled
        config_mod.settings.dev_identity_enabled = False
        try:
            with TestClient(app) as c:
                email = f"fix061c-{uuid.uuid4().hex[:10]}@example.com"
                resp = c.post(
                    "/api/v1/auth/register",
                    json={
                        "email": email,
                        "password": "password-123",
                        "displayName": "FIX061 compute",
                    },
                )
                assert resp.status_code == 200, resp.text
                yield c
        finally:
            config_mod.settings.dev_identity_enabled = original

    def _body(self) -> dict:
        return {
            "uploadIds": [uuid.uuid4().hex],  # nobody's upload
            "profile": "draft",
            "sceneTitle": "csrf 重建",
            "visibility": "PRIVATE",
        }

    def test_post_without_csrf_403(self, session_client):
        resp = session_client.post("/api/v1/compute/reconstruct", json=self._body())
        assert resp.status_code == 403, resp.text

    def test_post_wrong_csrf_403(self, session_client):
        resp = session_client.post(
            "/api/v1/compute/reconstruct",
            json=self._body(),
            headers={"X-CSRF-Token": "wrong-token"},
        )
        assert resp.status_code == 403, resp.text

    def test_post_correct_csrf_reaches_business_validation(self, session_client):
        csrf = session_client.cookies.get("gs_csrf")
        assert csrf
        # Correct CSRF → CSRF gate passes → business validation runs → the
        # unknown upload must yield 404 (NOT_FOUND), NOT 403.  This proves the
        # require_csrf dependency was exercised for real, never mocked.
        resp = session_client.post(
            "/api/v1/compute/reconstruct",
            json=self._body(),
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 404, resp.text
        assert resp.json().get("code") == "NOT_FOUND"
