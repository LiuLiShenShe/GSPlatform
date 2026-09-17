"""FFmpeg frame extraction with real, parseable progress (Phase 07).

The extractor chooses an FPS/strategy from the profile, applies rotation and
pixel format, writes server-side sequential filenames, and emits machine-
readable progress via the tool's own ``-progress pipe:1`` output so the
orchestrator maps real frames/time to the EXTRACTING stage. Cancellation
terminates the whole ffmpeg process group.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from workers.reconstruction.command_runner import CommandRunner


@dataclass
class ExtractResult:
    ok: bool
    frame_count: int = 0
    width: int = 0
    height: int = 0
    frames_dir: Path | None = None
    error: str = ""


def extract_frames(
    *,
    video_path: Path,
    frames_dir: Path,
    runner: CommandRunner,
    profile: dict,
    total_seconds: float | None,
) -> ExtractResult:
    """Extract frames from *video_path* into *frames_dir* (server-side names).

    Uses ``-progress pipe:1`` to get real frame/time progress. The progress
    is communicated via the CommandRunner's on_progress callback, which the
    orchestrator attaches before calling this function.

    Returns an :class:`ExtractResult`; callers count the produced frames and
    enforce the profile's ``max_frames`` after extraction.
    """
    frames_dir.mkdir(parents=True, exist_ok=True)
    fps = float(profile.get("fps", 2))
    target_width = int(profile.get("target_width", 960))
    quality = int(profile.get("quality", 5))

    # Scale to target width preserving aspect; force pixel format yuv420p.
    scale = f"scale={target_width}:-2"
    vf = f"fps={fps:g},{scale},format=yuv420p"

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        vf,
        "-q:v",
        str(quality),
        "-progress",
        "pipe:1",
        "-nostats",
        str(frames_dir / "frame_%05d.jpg"),
    ]

    result = runner.run(cmd)
    if not result.ok:
        return ExtractResult(
            ok=False,
            error=result.error or result.output[-2000:],
        )

    frames = sorted(frames_dir.glob("frame_*.jpg"))
    if not frames:
        return ExtractResult(ok=False, error="抽帧完成但没有生成任何帧")

    # Verify a sample frame is decodable.
    check = runner.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            str(frames[0]),
        ]
    )
    dims = (0, 0)
    if check.ok:
        try:
            info = json.loads(check.output or "{}")
            streams = info.get("streams") or []
            if streams:
                dims = (int(streams[0]["width"]), int(streams[0]["height"]))
        except (json.JSONDecodeError, ValueError, KeyError):
            dims = (0, 0)

    return ExtractResult(
        ok=True,
        frame_count=len(frames),
        width=dims[0],
        height=dims[1],
        frames_dir=frames_dir,
    )


def parse_ffmpeg_progress_line(line: str) -> dict[str, str] | None:
    """Parse one key=value line from ffmpeg's ``-progress`` output."""
    line = line.strip()
    if "=" not in line:
        return None
    key, _, value = line.partition("=")
    return {key.strip(): value.strip()}


def ffmpeg_out_time_us_of(lines: str) -> float | None:
    """Extract the final ``out_time_us`` from a block of ffmpeg progress lines."""
    last_us: float | None = None
    for line in lines.splitlines():
        kv = parse_ffmpeg_progress_line(line)
        if kv is None:
            continue
        if "out_time_us" in kv:
            try:
                last_us = float(kv["out_time_us"]) / 1_000_000
            except (ValueError, TypeError):
                pass
    return last_us


def ffmpeg_frame_count(lines: str) -> int | None:
    """Extract the final ``frame`` value from a block of ffmpeg progress lines."""
    last_count: int | None = None
    for line in lines.splitlines():
        kv = parse_ffmpeg_progress_line(line)
        if kv is None:
            continue
        if "frame" in kv:
            try:
                last_count = int(float(kv["frame"]))
            except (ValueError, TypeError):
                pass
    return last_count