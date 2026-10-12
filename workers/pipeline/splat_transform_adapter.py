"""Pinned official CLI and bounded, owned subprocess execution."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = (
    ROOT / "node_modules" / ".pnpm"
    / "@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0"
    / "node_modules" / "@playcanvas" / "splat-transform" / "bin" / "cli.mjs"
)
TOOL_VERSION = "3.3.3"
LOG_LIMIT_BYTES = 16 * 1024 * 1024
TAIL_LIMIT_BYTES = 65536
logger = logging.getLogger("gsplatform.workers.splat_transform")


def run_process(
    command: list[str], *, cwd: Path | None = None, timeout: int = 7200,
    environment: dict[str, str] | None = None,
) -> str:
    if not command or timeout <= 0:
        raise ValueError("A command and positive finite timeout are required")
    log_file = (cwd / "cli.log").open("a+b") if cwd else tempfile.TemporaryFile()
    tail = bytearray()
    with log_file as output:
        process = subprocess.Popen(
            command, cwd=cwd, env=environment, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, start_new_session=True,
        )

        def drain() -> None:
            assert process.stdout is not None
            output.seek(0, os.SEEK_END)
            remaining = max(0, LOG_LIMIT_BYTES - output.tell())
            while chunk := process.stdout.read(8192):
                tail.extend(chunk)
                if len(tail) > TAIL_LIMIT_BYTES:
                    del tail[:-TAIL_LIMIT_BYTES]
                if remaining:
                    written = min(remaining, len(chunk))
                    output.write(chunk[:written])
                    remaining -= written

        reader = threading.Thread(target=drain, name="splat-cli-log", daemon=True)
        reader.start()
        try:
            returncode = process.wait(timeout=timeout)
            reader.join(timeout=5)
            if reader.is_alive():
                raise RuntimeError("CLI descendants retained stdout after exit")
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=10)
            reader.join(timeout=5)
            if reader.is_alive():
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                reader.join(timeout=5)
            raise
        finally:
            if process.stdout is not None:
                process.stdout.close()
        output.flush()
    result = tail.decode("utf-8", errors="replace")
    logger.info("CLI exit=%s", returncode)
    if returncode != 0:
        raise RuntimeError(f"命令失败 (rc={returncode}): {result}")
    return result


def validate_cli(cli: Path, *, cwd: Path | None = None) -> str:
    if not cli.is_file():
        raise FileNotFoundError(f"splat-transform CLI 不可用: {cli}")
    node = shutil.which("node")
    if not node:
        raise FileNotFoundError("Node executable is unavailable")
    telemetry = Path(__file__).with_name("splat_device_telemetry.mjs")
    version = run_process([node, "--import", str(telemetry), str(cli), "--version"],
                          cwd=cwd, timeout=30)
    if not re.search(r"splat-transform v3\.3\.3(?:\s|$)", version):
        raise ValueError(f"Expected SplatTransform {TOOL_VERSION}; got {version.strip()}")
    return version.strip()


def run_cli_command(command: list[str], *, cwd: Path | None, timeout: int) -> str:
    executable = Path(command[0])
    if executable.name != "cli.mjs":
        return run_process(command, cwd=cwd, timeout=timeout)
    validate_cli(executable, cwd=cwd)
    telemetry = Path(__file__).with_name("splat_device_telemetry.mjs")
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("Node executable is unavailable")
    return run_process(
        [node, "--import", str(telemetry), *command], cwd=cwd, timeout=timeout,
        environment=dict(os.environ),
    )


def execution_record(command: list[str], output: str) -> dict:
    observation = {"backend": "unknown", "adapter": None}
    for line in output.splitlines():
        if line.startswith("GS_SPLAT_DEVICE "):
            observation = json.loads(line.removeprefix("GS_SPLAT_DEVICE "))
    return {
        "arguments": [Path(argument).name if Path(argument).is_absolute() else argument
                      for argument in command[1:]],
        "exitCode": 0,
        "observedDevice": observation,
    }


def inspect_source(source: Path, source_format: str | None = None, *, decode: bool = False) -> dict:
    extension = {"ply": ".ply", "splat": ".splat", "sog": ".sog", "zip": ".sog"}.get(
        source_format, source.suffix
    )
    if extension not in {".ply", ".splat", ".sog", ".spz", ".ksplat", ".gz"}:
        raise ValueError("Unsupported official inspection input")
    with tempfile.TemporaryDirectory(prefix="gs-splat-inspect-") as directory:
        workdir = Path(directory)
        input_path = workdir / f"input{extension}"
        try:
            os.link(source, input_path)
        except OSError:
            shutil.copyfile(source, input_path)
        arguments = [str(CLI_PATH), "-g", "cpu", str(input_path), "--info", "json"]
        if decode:
            arguments.extend(["--stats", "json"])
        arguments.extend(["null", "--no-tty", "--max-workers", "0"])
        output = run_cli_command(arguments, cwd=workdir, timeout=300)
        result = None
        for start, character in enumerate(output):
            if character != "{":
                continue
            try:
                metadata, _ = json.JSONDecoder().raw_decode(output[start:])
            except json.JSONDecodeError:
                continue
            if (isinstance(metadata, dict) and "numGaussians" in metadata
                    and "gaussian" in metadata and "format" in metadata):
                count = metadata.get("numGaussians")
                if metadata.get("gaussian") is not True or type(count) is not int or count <= 0:
                    raise ValueError("Official tool did not identify valid Gaussians")
                result = {key: value for key, value in metadata.items() if key != "stats"}
                if decode and "stats" in metadata:
                    for lod in metadata["stats"]:
                        statistics = lod.get("data", {})
                        if any(statistics.get("nanCount", [])) or any(statistics.get("infCount", [])):
                            raise ValueError("Gaussian source contains non-finite values")
        if result is not None:
            return result
    raise ValueError("Official tool returned no structural metadata")
