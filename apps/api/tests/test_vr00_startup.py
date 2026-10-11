from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
LAUNCHER = ROOT / "scripts" / "gsplatform-vr.sh"


@pytest.fixture
def runtime_environment(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    environment_file = tmp_path / "runtime.env"
    environment_file.write_text(
        f"GS_VR00_STATE_DIR='{state}'\n"
        "GS_ENV=production\n"
        "GS_DEV_IDENTITY_ENABLED=false\n"
        "GS_SESSION_SECURE_COOKIE=true\n"
    )
    environment_file.chmod(0o600)
    return state, environment_file, {**os.environ, "GS_VR00_ENV_FILE": str(environment_file)}


def invoke(environment, command):
    return subprocess.run(  # noqa: S603
        ["/usr/bin/bash", str(LAUNCHER), command],
        env=environment,
        capture_output=True,
        text=True,
        timeout=45,
    )


def record_process(state, process, *, stale=False, foreign=False):
    fields = Path(f"/proc/{process.pid}/stat").read_text().split(") ", 1)[1].split()
    (state / "api.pid").write_text(json.dumps({
        "pid": process.pid,
        "startTicks": str(int(fields[19]) + 1) if stale else fields[19],
        "commandDigest": "foreign" if foreign else hashlib.sha256(
            Path(f"/proc/{process.pid}/cmdline").read_bytes()
        ).hexdigest(),
    }))


def test_refuses_public_identity_bypass(runtime_environment):
    _, environment_file, environment = runtime_environment
    with environment_file.open("a") as stream:
        stream.write("GS_DEV_IDENTITY_ENABLED=true\n")
    result = invoke(environment, "up")
    assert result.returncode != 0
    assert "real identity" in result.stderr


def test_refuses_readable_secret_file(runtime_environment):
    _, environment_file, environment = runtime_environment
    environment_file.chmod(0o644)
    result = invoke(environment, "status")
    assert result.returncode != 0
    assert "mode 600" in result.stderr


@pytest.mark.parametrize("stale", [False, True])
def test_never_stops_foreign_or_reused_pid(runtime_environment, stale):
    state, _, environment = runtime_environment
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        env={**os.environ, "GS_VR00_STATE_DIR": str(state)},
    )
    try:
        record_process(state, process, stale=stale, foreign=not stale)
        result = invoke(environment, "down")
        assert result.returncode != 0
        assert "foreign or reused" in result.stderr
        assert process.poll() is None
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_down_is_idempotent_and_stops_only_owned_process(runtime_environment):
    state, _, environment = runtime_environment
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        env={**environment, "GS_VR00_STATE_DIR": str(state)},
    )
    try:
        record_process(state, process)
        result = invoke(environment, "down")
        assert result.returncode == 0, result.stderr
        process.wait(timeout=5)
        assert not (state / "api.pid").exists()
        assert invoke(environment, "down").returncode == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
