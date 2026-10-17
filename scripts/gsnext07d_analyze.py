#!/usr/bin/env python3
"""Analyze the raw screenshots from the GS-NEXT-07D one-point ablation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps


VIEWS = ("overall", "side", "bottom", "front")
# Fixed rectangles of the official Editor DOM captured over the canvas. They
# exclude menus/panels, view cube, toolbar, pose text and version label only.
# Coordinates use [x0, y0, x1, y1), in the native 1500 x 934 screenshot.
UI_RECTS = (
    (16, 16, 536, 82), (16, 94, 352, 394), (1414, 295, 1484, 639),
    (1375, 10, 1490, 129), (318, 847, 1182, 918), (0, 873, 315, 925),
    (1345, 887, 1500, 923),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)


def bbox(mask: np.ndarray):
    ys, xs = np.where(mask)
    if not len(xs):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]


def metrics(a: np.ndarray, b: np.ndarray, include: np.ndarray | None = None) -> dict:
    delta = np.abs(a.astype(np.float64) - b.astype(np.float64))
    magnitude = delta.max(axis=2)
    if include is None:
        include = np.ones(magnitude.shape, dtype=bool)
    values = delta[include]
    result = {
        "shape": list(a.shape),
        "evaluated_pixels": int(include.sum()),
        "mae_8bit": float(values.mean()),
        "rmse_8bit": float(np.sqrt(np.mean(values * values))),
        "max_channel_delta": int(values.max()),
        "mean_channel_delta": [float(v) for v in values.mean(axis=0)],
        "thresholds": {},
    }
    for threshold in (1, 4, 16, 32):
        mask = (magnitude >= threshold) & include
        result["thresholds"][str(threshold)] = {
            "changed_fraction": float(mask.sum() / include.sum()),
            "changed_pixels": int(mask.sum()),
            "bbox_xyxy": bbox(mask),
        }
    return result


def write_heatmap(a: np.ndarray, b: np.ndarray, output: Path, threshold: int = 4,
                  include: np.ndarray | None = None) -> None:
    delta = np.abs(a - b).max(axis=2)
    if include is not None:
        delta = np.where(include, delta, 0)
    # Keep the source images untouched. The derived map uses a square-root
    # lift so both small and large changes remain visible to a reviewer.
    lifted = np.clip(np.sqrt(delta.astype(np.float32) / 255.0) * 255.0, 0, 255).astype(np.uint8)
    gray = Image.fromarray(lifted, mode="L")
    heat = ImageOps.colorize(gray, black=(0, 0, 0), mid=(255, 196, 0), white=(255, 0, 0)).convert("RGB")
    draw = ImageDraw.Draw(heat)
    box = bbox(delta >= threshold)
    if box:
        draw.rectangle(box, outline=(0, 255, 255), width=3)
        draw.text((box[0] + 6, box[1] + 6), f"delta >= {threshold}", fill=(0, 255, 255))
    heat.save(output)


def write_blend(a: np.ndarray, b: np.ndarray, output: Path) -> None:
    first = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), mode="RGB")
    second = Image.fromarray(np.clip(b, 0, 255).astype(np.uint8), mode="RGB")
    Image.blend(first, second, 0.5).save(output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True, help="Experiment root containing screenshots/")
    parser.add_argument("--out", type=Path, required=True, help="Directory for derived analysis files")
    args = parser.parse_args()

    screenshots = args.root / "screenshots"
    args.out.mkdir(parents=True, exist_ok=True)
    report = {
        "sourceRoot": str(args.root),
        "imageKind": "canvas",
        "views": {},
        "rawSha256": {},
        "sceneOnlyMask": {"uiRectsXYXYExclusive": UI_RECTS,
                          "note": "Metrics exclude fixed DOM UI rectangles; raw PNGs remain untouched."},
    }

    for view in VIEWS:
        paths = {
            "a": screenshots / f"a-{view}-canvas.png",
            "aRepeat": screenshots / f"a-repeat-{view}-canvas.png",
            "b": screenshots / f"b-{view}-canvas.png",
            "undo": screenshots / f"undo-{view}-canvas.png",
        }
        arrays = {name: load_rgb(path) for name, path in paths.items()}
        assert arrays["a"].shape == (934, 1500, 3), "UI mask requires the recorded native canvas size"
        assert all(array.shape == arrays["a"].shape for array in arrays.values())
        scene = np.ones((934, 1500), dtype=bool)
        for x0, y0, x1, y1 in UI_RECTS:
            scene[y0:y1, x0:x1] = False
        report["views"][view] = {
            "aVsB": metrics(arrays["a"], arrays["b"]),
            "aVsARepeat": metrics(arrays["a"], arrays["aRepeat"]),
            "aVsUndo": metrics(arrays["a"], arrays["undo"]),
            "sceneOnly": {
                "aVsB": metrics(arrays["a"], arrays["b"], scene),
                "aVsARepeat": metrics(arrays["a"], arrays["aRepeat"], scene),
                "aVsUndo": metrics(arrays["a"], arrays["undo"], scene),
            },
        }
        Image.fromarray(np.abs(arrays["a"] - arrays["b"]).astype(np.uint8)).save(
            args.out / f"diff-{view}-absolute-rgb.png")
        write_heatmap(arrays["a"], arrays["b"], args.out / f"diff-{view}-canvas.png")
        write_heatmap(arrays["a"], arrays["b"], args.out / f"diff-{view}-scene-only.png", include=scene)
        write_blend(arrays["a"], arrays["b"], args.out / f"blend-{view}-canvas.png")
        for label, path in paths.items():
            report["rawSha256"][path.name] = sha256(path)

    (args.out / "metrics.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
