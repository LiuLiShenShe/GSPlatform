"""Executed with the existing SAM3 Python, importing only the official model API."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    # Restrict visibility before importing torch/SAM3; never initialize GPU1.
    os.environ["CUDA_VISIBLE_DEVICES"] = "0"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    identity = request["model"]
    sys.path.insert(0, identity["source"])

    import numpy as np
    import torch
    from PIL import Image
    from sam3.model.sam3_image_processor import Sam3Processor
    from sam3.model_builder import build_sam3_image_model

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from workers.reconstruction.segmentation import file_sha256

    start = time.monotonic()
    model = build_sam3_image_model(
        checkpoint_path=identity["checkpoint"],
        bpe_path=str(
            Path(identity["source"]) / "sam3/assets/bpe_simple_vocab_16e6.txt.gz"
        ),
        device="cuda",
        load_from_HF=False,
        eval_mode=True,
    )
    processor = Sam3Processor(
        model, confidence_threshold=identity["confidenceThreshold"]
    )
    output_dir = Path(request["outputDir"])
    for name in ("masks", "previews", "records"):
        (output_dir / name).mkdir(parents=True, exist_ok=True)
    image_dir = Path(request["imagesDir"])
    paths = sorted(
        p
        for p in image_dir.iterdir()
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    frames = []
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        for index, path in enumerate(paths):
            image = Image.open(path).convert("RGB")
            record = output_dir / "records" / (path.name + ".json")
            mask_path = output_dir / "masks" / (path.name + ".png")
            image_hash = file_sha256(path)
            # Per-frame resume is accepted only for the exact input/prompt/model.
            frame = json.loads(record.read_text()) if record.is_file() else None
            fingerprint = {
                "imageSha256": image_hash,
                "prompt": request["prompt"],
                "model": identity,
            }
            if not (
                frame
                and frame.get("identity") == fingerprint
                and mask_path.is_file()
                and file_sha256(mask_path) == frame["maskSha256"]
                and (output_dir / frame["preview"]).is_file()
            ):
                state = processor.set_image(image)
                foreground = np.zeros((image.height, image.width), dtype=bool)
                concepts = []
                scores, boxes = [], []
                instances = 0
                # Explicit semicolons/newlines mean independent concepts. Each
                # uses the official text API; every matched instance is retained.
                for concept in filter(
                    None, (p.strip() for p in re.split(r"[;\n]", request["prompt"]))
                ):
                    result = processor.set_text_prompt(state=state, prompt=concept)
                    masks = result["masks"].detach().cpu().numpy()
                    visible = (
                        masks.reshape(-1, image.height, image.width).any(axis=0)
                        if masks.shape[0]
                        else np.zeros_like(foreground)
                    )
                    foreground |= visible
                    instances += int(masks.shape[0])
                    concepts.append(
                        {
                            "prompt": concept,
                            "instances": int(masks.shape[0]),
                            "foregroundPixels": int(visible.sum()),
                        }
                    )
                    scores.extend(result["scores"].detach().float().cpu().tolist())
                    boxes.extend(result["boxes"].detach().float().cpu().tolist())
                Image.fromarray(foreground.astype(np.uint8) * 255).save(mask_path)
                overlay = np.asarray(image).copy()
                overlay[foreground] = (
                    overlay[foreground] * 0.55 + np.array([40, 210, 110]) * 0.45
                ).astype(np.uint8)
                preview = output_dir / "previews" / (path.name + ".webp")
                # Original and real mask overlay side by side, never a synthetic highlight.
                comparison = Image.new("RGB", (image.width * 2, image.height))
                comparison.paste(image, (0, 0))
                comparison.paste(Image.fromarray(overlay), (image.width, 0))
                comparison.thumbnail((1600, 900))
                comparison.save(preview, quality=88)
                frame = {
                    "name": path.name,
                    "size": list(image.size),
                    "imageSha256": image_hash,
                    "maskSha256": file_sha256(mask_path),
                    "foregroundPixels": int(foreground.sum()),
                    "coverage": float(foreground.mean()),
                    "instances": instances,
                    "concepts": concepts,
                    "scores": scores,
                    "boxes": boxes,
                    "preview": "previews/" + preview.name,
                    "identity": fingerprint,
                }
                temporary = record.with_suffix(".tmp")
                temporary.write_text(json.dumps(frame, ensure_ascii=False))
                temporary.replace(record)
            frames.append(frame)
            print(
                f"SAM3FRAME done={index + 1} total={len(paths)} foreground={frame['foregroundPixels']}",
                flush=True,
            )
    manifest = {
        "schemaVersion": 1,
        "semantics": "white=keep; black=background",
        "prompt": request["prompt"],
        "model": identity,
        "frames": frames,
        "validViews": sum(f["foregroundPixels"] > 0 for f in frames),
        "runtime": {
            "python": sys.version,
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "device": torch.cuda.get_device_name(0),
            "seconds": time.monotonic() - start,
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(0),
        },
    }
    manifest_path = output_dir / "manifest.json"
    temporary_manifest = manifest_path.with_suffix(".tmp")
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    temporary_manifest.replace(manifest_path)
    if manifest["validViews"] < 3:
        print(
            f"SAM3_EMPTY_OR_INSUFFICIENT: {manifest['validViews']} valid views; need at least 3",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
