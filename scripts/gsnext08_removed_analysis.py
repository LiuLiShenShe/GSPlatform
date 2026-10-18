"""GS-NEXT-08 removed-row analysis.

Aligns each floater-filter candidate back to the source PLY (the candidate is a
verified byte-identical ordered subsequence) and reports exactly which source
Gaussian rows were removed, their property distribution, and whether specific
previously-investigated artifact rows are inside the removed set.

Read-only. No rendering, no writes to any model.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from workers.pipeline.gaussian_quality import CHUNK_ROWS, read_gaussian_ply  # noqa: E402

# Rows investigated in earlier phases (0-based source row indices).
KNOWN_ROWS = {
    11183581: "GS-NEXT-07C/07D single-point ablation target (large-scale, high-opacity)",
    13011461: "GS-NEXT-07C controlled-deletion test row (not a deletion recommendation)",
}


def align_matched_source_indices(source: Path, candidate: Path) -> np.ndarray:
    """Return the source row index matched to each candidate row (order-preserving)."""
    a = read_gaussian_ply(source)
    b = read_gaussian_ply(candidate)
    names = a.dtype.names or ()
    packed = np.dtype([(name, "<f4") for name in names])

    def pack(rows: np.ndarray) -> np.ndarray:
        table = np.empty(len(rows), dtype=packed)
        for name in names:
            table[name] = rows[name]
        return table.view(f"V{packed.itemsize}")

    win = CHUNK_ROWS
    matched = np.empty(len(b), dtype=np.int64)
    mi = 0
    ai = 0
    cidx = 0
    while cidx < len(b) and ai < len(a):
        akeys = pack(a[ai:ai + win])
        ckeys = pack(b[cidx:cidx + win])
        bi = 0
        ci = 0
        while bi < len(akeys) and ci < len(ckeys):
            if akeys[bi] == ckeys[ci]:
                matched[mi] = ai + bi
                mi += 1
                bi += 1
                ci += 1
            else:
                bi += 1
        ai += win
        cidx += ci
    assert mi == len(b), f"alignment incomplete: {mi}/{len(b)}"
    return matched


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = Path(args.source).resolve(strict=True)
    candidate = Path(args.candidate).resolve(strict=True)
    rows = read_gaussian_ply(source)
    names = rows.dtype.names or ()
    total = len(rows)

    matched = align_matched_source_indices(source, candidate)
    kept_mask = np.zeros(total, dtype=bool)
    kept_mask[matched] = True
    removed_idx = np.nonzero(~kept_mask)[0]

    opacity = np.exp(-np.logaddexp(0, -np.asarray(rows["opacity"], dtype=np.float64)))
    max_scale = np.zeros(total, dtype=np.float64)
    for axis in range(3):
        with np.errstate(over="ignore"):
            lin = np.exp(np.asarray(rows[f"scale_{axis}"], dtype=np.float64))
        np.maximum(max_scale, lin, out=max_scale)

    def dist(values: np.ndarray) -> dict:
        if not len(values):
            return {"count": 0}
        return {"count": int(values.size), "min": float(values.min()),
                "median": float(np.median(values)), "max": float(values.max()),
                "mean": float(values.mean())}

    removed_op = opacity[removed_idx]
    removed_sc = max_scale[removed_idx]
    report = {
        "label": args.label,
        "sourceRows": int(total),
        "keptRows": int(kept_mask.sum()),
        "removedRows": int(removed_idx.size),
        "removedPct": float(removed_idx.size / total * 100),
        "removedOpacitySigmoid": dist(removed_op),
        "removedMaxLinearScale": dist(removed_sc),
        "removedOpacityBelow0.01": int((removed_op < 0.01).sum()),
        "removedMaxScaleOver2": int((removed_sc > 2).sum()),
        "removedMaxScaleOver10": int((removed_sc > 10).sum()),
        "removedYposPercentiles": {f"P{p}": float(np.percentile(rows['y'][removed_idx], p))
                                   for p in (1, 50, 99)}
        if removed_idx.size else {},
        "knownRowsRemoved": {str(r): bool(r in set(removed_idx.tolist()))
                             for r in KNOWN_ROWS},
        "knownRowNotes": KNOWN_ROWS,
    }
    Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
    np.save(str(Path(args.out).with_suffix(".removed.npy")), removed_idx)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
