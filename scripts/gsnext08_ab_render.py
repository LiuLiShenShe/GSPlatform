"""GS-NEXT-08 A/B render driver.

Renders the SAME four camera poses through the official SplatTransform GPU
rasterizer (`.webp` output) for the original and each floater-filter candidate,
using one shared script so all camera/background/resolution settings are
byte-identical between A and B. No post-processing, no cross-tool comparison.

The rasterizer is not the SuperSplat Viewer; these images are an official-tool
rasterization A/B, not a claim of identical LOD/streaming behaviour to the
published scene. Each candidate gets its own aligned set.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from workers.pipeline.splat_transform_adapter import CLI_PATH, TOOL_VERSION  # noqa: E402

# Shared poses. These use the historical GS-NEXT-06 verified observation geometry
# expressed in SOURCE PLY coordinates. The Viewer runtime convention is
# (-sourceX, -sourceY, sourceZ), so the runtime poses from GS-NEXT-06 are mapped
# back to source space here: runtime (rx, ry, rz) -> source (-rx, -ry, rz).
RUNTIME_POSES = {
    "overall":  ([240, 80, 400],   [75, -25, 150],  60),
    "front":    ([400, 30, 180],   [75, -25, 150],  60),
    "side":     ([400, -100, 180], [75, -25, 150],  60),
    "detail":   ([100, -15, 175],  [75, -25, 150],  55),
}
BG = "0,0,0,1"
RESOLUTION = "1600x900"


def to_source(pos: list[float]) -> list[float]:
    return [-pos[0], -pos[1], pos[2]]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--gpu", default="0")
    args = parser.parse_args()

    source = Path(args.input).resolve(strict=True)
    out_dir = Path(args.out_dir).absolute()
    out_dir.mkdir(parents=True, exist_ok=True)
    receipt = {"label": args.label, "tool": f"splat-transform {TOOL_VERSION}",
               "input": str(source), "views": {}}

    for name, (pos, target, fov) in RUNTIME_POSES.items():
        src_pos = to_source(pos)
        out = out_dir / f"{args.label}-{name}.webp"
        command = [str(CLI_PATH), "--gpu", args.gpu, str(source),
                   "--projection", "pinhole",
                   "--camera-pos", ",".join(f"{v:g}" for v in src_pos),
                   "--camera-target", ",".join(f"{v:g}" for v in target),
                   "--camera-fov", str(fov),
                   "--resolution", RESOLUTION,
                   "--background", BG,
                   str(out), "--no-tty", "--max-workers", "0"]
        result = subprocess.run(command, capture_output=True, text=True,
                                cwd=out_dir, timeout=900)
        receipt["views"][name] = {
            "runtimePose": {"position": pos, "target": target, "fov": fov},
            "sourcePose": {"position": src_pos, "target": target, "fov": fov},
            "resolution": RESOLUTION, "background": BG,
            "command": command[1:],
            "exitCode": result.returncode,
            "bytes": out.stat().st_size if out.exists() else None,
            "stderrTail": (result.stderr or result.stdout or "")[-800:],
        }
        if result.returncode != 0 or not out.exists():
            (out_dir / f"{args.label}-{name}.failed.txt").write_text(
                result.stdout + result.stderr)
    (out_dir / f"{args.label}-render-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: {"exitCode": v["exitCode"], "bytes": v["bytes"]}
                      for k, v in receipt["views"].items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
