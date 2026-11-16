"""Decode the confirmed saved geometry into the original cameras' coordinate units."""

import argparse
import math
from pathlib import Path

from workers.pipeline.splat_transform_adapter import CLI_PATH, run_cli_command


def prepare(source: Path, output: Path, factor: float) -> None:
    if not math.isfinite(factor) or factor <= 0:
        raise ValueError("Invalid calibration scale")
    output.parent.mkdir(parents=True, exist_ok=True)
    selection = ["--select-lod", "0"] if source.name == "lod-meta.json" else []
    # Published files retain source coordinates; viewer's baked Z180 is only
    # a display transform. Undo the metric scale once to reuse original poses.
    run_cli_command(
        [
            str(CLI_PATH),
            "-g",
            "cpu",
            *selection,
            str(source),
            "--scale",
            str(1 / factor),
            str(output),
            "--no-tty",
            "--max-workers",
            "0",
            "-w",
        ],
        cwd=output.parent,
        timeout=3600,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scale", type=float, required=True)
    args = parser.parse_args()
    print("MESHPROGRESS PREPARING 5", flush=True)
    prepare(args.input, args.output, args.scale)
