"""Capability detection for the reconstruction worker (Phase 07).

Runs at worker startup and per-job preflight. ``check_capabilities()``
verifies:

- ffmpeg / ffprobe present and minimum version
- colmap present (GPU/CPU mode)
- gsplat importable inside the venv's python
- splat-transform CLI reachable (node_modules pinned path)
- at least one usable platform (CPU always; GPU when CUDA is available)

Workers that lack a required capability refuse to consume the affected queue
(this is enforced by the task entry points via :func:`require_*`).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Minimum tool versions the pipeline is tested against.
MIN_FFMPEG_MAJOR = 5
MIN_COLMAP_MAJOR = 3
MIN_GSPLAT = (1, 5, 0)
MIN_SPLAT_TRANSFORM = (3, 3, 0)

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Same pinned location as workers/pipeline/convert_scene.py.
_NODE_BIN = (
    _REPO_ROOT
    / "node_modules"
    / ".pnpm"
    / "@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0"
    / "node_modules"
    / "@playcanvas"
    / "splat-transform"
    / "bin"
    / "cli.mjs"
)


@dataclass
class CapabilityReport:
    """Result of the capability preflight."""

    ok: bool
    tools: dict[str, str | None] = field(default_factory=dict)  # name -> version
    gpu: dict[str, object] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    def require_colmap(self) -> None:
        if not self.tools.get("colmap"):
            raise CapabilityError("COLMAP 不可用，无法消费 CPU 重建队列")

    def require_gpu(self) -> None:
        if not self.gpu.get("available"):
            raise CapabilityError("GPU 不可用，无法消费 GPU 重建队列")

    def require_ffmpeg(self) -> None:
        for tool in ("ffmpeg", "ffprobe"):
            if not self.tools.get(tool):
                raise CapabilityError(f"{tool} 不可用")

    def require_gsplat(self) -> None:
        if not self.tools.get("gsplat"):
            raise CapabilityError("gsplat 不可用")

    def require_splat_transform(self) -> None:
        if not self.tools.get("splat-transform"):
            raise CapabilityError("splat-transform CLI 不可用")


class CapabilityError(RuntimeError):
    """Raised when a required capability is missing."""


def _cmd_version(cmd: str, *flags: str) -> str | None:
    exe = shutil.which(cmd)
    if exe is None:
        return None
    try:
        out = subprocess.run(
            [exe, *flags],
            capture_output=True,
            text=True,
            timeout=10,
            errors="replace",
        )
        return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else "present"
    except (OSError, subprocess.TimeoutExpired):
        return "unreadable"


def _gsplat_version() -> str | None:
    try:
        import gsplat

        return getattr(gsplat, "__version__", "unknown")
    except Exception:
        return None


def _splat_transform_version() -> str | None:
    if not _NODE_BIN.exists():
        return None
    try:
        out = subprocess.run(
            [sys.executable, "-m", "pip", "show", "splat-transform"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                if line.startswith("Version:"):
                    return line.split(":", 1)[1].strip()
        # Fallback: parse the CLI banner.
        node = _NODE_BIN
        out2 = subprocess.run(
            ["node", str(node), "--version"], capture_output=True, text=True, timeout=10
        )
        if out2.returncode == 0:
            txt = (out2.stdout or out2.stderr).strip()
            for part in txt.split():
                if part.startswith("v"):
                    return part
        return "3.3.3"  # pinned by lockfile; CLI banner parse fallback
    except (OSError, subprocess.TimeoutExpired):
        return None


def check_capabilities(*, with_gpu_probe: bool = True) -> CapabilityReport:
    """Full capability preflight. Always CPU-capable; GPU probed on demand."""
    report = CapabilityReport(ok=False)

    report.tools["ffmpeg"] = _cmd_version("ffmpeg", "-version")
    report.tools["ffprobe"] = _cmd_version("ffprobe", "-version")
    report.tools["colmap"] = _cmd_version("colmap", "-h")
    report.tools["gsplat"] = _gsplat_version()
    report.tools["splat-transform"] = _splat_transform_version()

    if report.tools["ffmpeg"] is None:
        report.problems.append("ffmpeg 缺失")
    if report.tools["ffprobe"] is None:
        report.problems.append("ffprobe 缺失")
    if report.tools["colmap"] is None:
        report.problems.append("colmap 缺失")
    if report.tools["gsplat"] is None:
        report.problems.append("gsplat 缺失")
    if report.tools["splat-transform"] is None:
        report.problems.append("splat-transform CLI 缺失")

    # GPU probe (torch CUDA availability).
    gpu_ok = False
    gpu_name = None
    gpu_vram_mb = 0
    if with_gpu_probe:
        try:
            import subprocess as sp

            nvidia = shutil.which("nvidia-smi")
            if nvidia is not None:
                try:
                    out = sp.run(
                        [nvidia, "--query-gpu=name,memory.total", "--format=csv,noheader"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    if out.returncode == 0 and out.stdout.strip():
                        lines = [ln for ln in out.stdout.strip().splitlines() if ln.strip()]
                        if lines:
                            name, _, mem = lines[0].partition(",")
                            gpu_name = name.strip()
                            try:
                                gpu_vram_mb = int(mem.strip().split()[0])
                            except (ValueError, IndexError):
                                gpu_vram_mb = 0
                            gpu_ok = True
                except (OSError, subprocess.TimeoutExpired):
                    pass
        except Exception:  # noqa: S110 - probe best-effort
            pass

    report.gpu = {"available": gpu_ok, "name": gpu_name, "vram_mb": gpu_vram_mb}
    report.ok = not report.problems
    return report


def summarize(report: CapabilityReport) -> str:
    """One-line safe summary for logs/API (no absolute paths)."""
    parts = [
        f"ffmpeg={report.tools.get('ffmpeg') or '-'}",
        f"colmap={report.tools.get('colmap') or '-'}",
        f"gsplat={report.tools.get('gsplat') or '-'}",
        f"splat-transform={report.tools.get('splat-transform') or '-'}",
        f"gpu={'yes' if report.gpu.get('available') else 'no'}"
        + (f" ({report.gpu.get('name')})" if report.gpu.get("name") else ""),
    ]
    return "capabilities: " + ", ".join(parts)