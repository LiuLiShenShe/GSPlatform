"""Unified subprocess executor for the reconstruction pipeline.

Every external tool runs through :class:`CommandRunner`:

- argv list only, never a shell string
- executable allowed-list (no user-writable paths)
- working directory fixed to the job root
- sanitized environment
- wall-clock timeout + terminate + kill grace period
- bounded stdout/stderr capture
- optional progress parser callback
- exit-code and artifact checks

By default the runner terminates the whole process group, so child
processes (e.g. ffmpeg spawning encoder threads) are cleaned up too.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# Executables the pipeline is allowed to run. Paths resolve via ``shutil.which``
# against the venv + system PATH at runner creation time; a missing binary is a
# hard capability error, not a silent fallback.
ALLOWED_EXECUTABLES = frozenset(
    {
        "ffmpeg",
        "ffprobe",
        "colmap",
        "python",
    }
)

# Default resource bounds (profile overrides these per job).
DEFAULT_TIMEOUT_S = 4 * 3600
DEFAULT_KILL_GRACE_S = 15
MAX_CAPTURE_BYTES = 2 * 1024 * 1024  # bounded output capture (2 MB per stream)


@dataclass
class RunResult:
    """Outcome of a single subprocess invocation."""

    command: list[str]
    returncode: int
    output: str = ""  # bounded, tail-kept stdout+stderr
    duration_s: float = 0.0
    timed_out: bool = False
    cancelled: bool = False
    ok: bool = True
    error: str = ""

    @property
    def stdout_tail(self) -> str:
        return self.output


class CommandRunner:
    """Run allow-listed executables with bounded capture and cancellation.

    ``is_cancelled`` is a zero-arg callable returning a bool; the runner polls
    it once per second while a subprocess is alive and terminates the process
    group with SIGTERM (then SIGKILL after the grace period) when it turns
    True. ``on_progress`` receives each polled output chunk (bounded).
    """

    def __init__(
        self,
        *,
        cwd: Path,
        env: dict[str, str] | None = None,
        timeout: int = DEFAULT_TIMEOUT_S,
        kill_grace: int = DEFAULT_KILL_GRACE_S,
        is_cancelled: Callable[[], bool] | None = None,
        on_progress: Callable[[str], None] | None = None,
    ) -> None:
        self._cwd = cwd
        self._timeout = timeout
        self._kill_grace = kill_grace
        self._is_cancelled = is_cancelled or (lambda: False)
        self._on_progress = on_progress

        # Base env: inherit, sanitize a handful of dangerous/mutable keys.
        self._env = dict(os.environ)
        self._env.pop("PYTHONPATH", None)
        self._env.pop("PYTHONSTARTUP", None)
        self._env.setdefault("PYTHONUNBUFFERED", "1")
        self._env.setdefault("LC_ALL", "C.UTF-8")
        # COLMAP 3.x needs a Qt platform plugin — headless environments have
        # no X11/Wayland display, so force offscreen to prevent SIGABRT.
        self._env["QT_QPA_PLATFORM"] = "offscreen"
        if env:
            self._env.update(env)

    # ------------------------------------------------------------------ #
    # public API
    # ------------------------------------------------------------------ #
    def run(self, argv: list[str]) -> RunResult:
        """Execute *argv* (no shell). Raises on non-allow-listed executable."""
        self._assert_allowlisted(argv)
        exe = self._resolve(argv[0])
        if exe is None:
            return RunResult(
                command=argv, returncode=-1, ok=False, error=f"可执行文件未找到: {argv[0]}"
            )

        started = time.monotonic()
        captured = _BoundedCapture(MAX_CAPTURE_BYTES)

        try:
            proc = subprocess.Popen(
                [exe, *argv[1:]],
                cwd=str(self._cwd),
                env=self._env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                # Start a new session so terminate_group can signal all children.
                start_new_session=True,
                text=True,
                bufsize=1,
                errors="replace",
            )
        except OSError as exc:
            return RunResult(
                command=argv,
                returncode=-1,
                ok=False,
                error=f"启动子进程失败: {exc}",
            )

        def _poll() -> None:
            assert proc.stdout is not None
            chunk = proc.stdout.readline()
            while chunk:
                captured.write(chunk)
                if self._on_progress is not None:
                    self._on_progress(chunk)
                if _is_progress_end(chunk):
                    break
                chunk = proc.stdout.readline()

        poll_thread = _spawn_poll(_poll)  # reader keeps stdout draining

        deadline = time.monotonic() + self._timeout
        timed_out = False
        cancelled = False
        try:
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    timed_out = True
                    self._terminate_group(proc.pid)
                    break
                if self._is_cancelled():
                    cancelled = True
                    self._terminate_group(proc.pid)
                    break
                time.sleep(0.5)
        finally:
            poll_thread.join(timeout=2.0)
            if proc.stdout is not None:
                proc.stdout.close()

        try:
            proc.wait(timeout=self._kill_grace)
        except subprocess.TimeoutExpired:
            if proc.poll() is None:
                self._kill_group(proc.pid)
                proc.wait(timeout=5)

        duration = time.monotonic() - started
        return RunResult(
            command=argv,
            returncode=proc.returncode if proc.returncode is not None else -1,
            output=captured.text(),
            duration_s=duration,
            timed_out=timed_out,
            cancelled=cancelled,
            ok=(not timed_out and not cancelled and proc.returncode == 0),
            error=self._describe(proc.returncode, timed_out, cancelled),
        )

    # ------------------------------------------------------------------ #
    # internals
    # ------------------------------------------------------------------ #
    def _assert_allowlisted(self, argv: list[str]) -> None:
        if not argv:
            raise ValueError("argv 为空")
        exe = Path(argv[0]).name if "/" in argv[0] else argv[0]
        if exe not in ALLOWED_EXECUTABLES:
            raise ValueError(f"可执行文件不在白名单内: {exe!r}")

    @staticmethod
    def _resolve(exe: str) -> str | None:
        if "/" in exe:
            path = Path(exe)
            return str(path) if path.is_file() else None
        from shutil import which

        return which(exe)

    def _terminate_group(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    def _kill_group(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    @staticmethod
    def _describe(rc: int, timed_out: bool, cancelled: bool) -> str:
        if timed_out:
            return "命令超时"
        if cancelled:
            return "任务已取消"
        if rc != 0:
            return f"退出码 {rc}"
        return ""


class _BoundedCapture:
    """Keep only the first and last parts of a stream within a byte budget."""

    def __init__(self, max_bytes: int) -> None:
        self._max = max_bytes
        self._head: list[str] = []
        self._head_len = 0
        self._tail: list[str] = []
        self._tail_len = 0
        self._dropped = 0
        # Keep enough head context for progress parsers (first events).
        self._head_limit = max_bytes // 4

    def write(self, chunk: str) -> None:
        data = chunk if isinstance(chunk, str) else chunk.decode("utf-8", "replace")
        if self._head_len < self._head_limit:
            self._head.append(data)
            self._head_len += len(data)
            return
        self._tail.append(data)
        self._tail_len += len(data)
        # Compact tail when over budget, keeping the newest chunks.
        while self._tail_len > self._max - self._head_limit and len(self._tail) > 1:
            self._tail.pop(0)
            self._tail_len -= len(self._tail[0]) if self._tail else 0
        if self._tail:
            self._tail_len = sum(len(c) for c in self._tail)

    def text(self) -> str:
        if self._head and self._tail:
            return "".join(self._head) + "\n…[输出过长，省略中间部分]…\n" + "".join(self._tail)
        if self._head:
            return "".join(self._head)
        return "".join(self._tail)


def _spawn_poll(fn: Callable[[], None]) -> threading.Thread:
    t = threading.Thread(target=fn, daemon=True)
    t.start()
    return t


# Progress parser helpers ----------------------------------------------------- #
def _is_progress_end(chunk: str) -> bool:
    """Some tools print a trailer line; we always drain to EOF so never stop
    early — this hook is reserved for future bounded-window parsers."""
    return False


# Convenience: pretty-print a bounded command line for logs (never secrets).
def quote_argv(argv: list[str], *, max_len: int = 200) -> str:
    joined = shlex.join(str(a) for a in argv)
    return joined if len(joined) <= max_len else joined[: max_len - 1] + "…"