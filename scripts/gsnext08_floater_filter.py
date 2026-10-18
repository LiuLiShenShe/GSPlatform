"""GS-NEXT-08 experiment B driver.

Runs ONLY the official SplatTransform `--filter-floaters` action on an isolated
copy of the historical Building PLY. Reuses the single approved CLI process
manager (`splat_transform_adapter.run_cli_command`); it does not add a second
process manager, does not stack other filters, and never writes to the source.

Invoke under a cgroup memory cap, e.g.:

  systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0 \
    PYTHONPATH=apps/api:. apps/api/.venv/bin/python scripts/gsnext08_floater_filter.py \
    --source <copy.ply> --expected-sha256 <sha> --out-dir <dir> \
    --params 0.05,0.1,0.00392156862745098 --label B-official-default
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import resource
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from workers.pipeline.gaussian_quality import CHUNK_ROWS, read_gaussian_ply  # noqa: E402
from workers.pipeline.splat_transform_adapter import (  # noqa: E402
    CLI_PATH,
    TOOL_VERSION,
    execution_record,
    run_cli_command,
    validate_cli,
)

LOG_LIMIT = 8 * 1024 * 1024


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(8 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def header_properties(path: Path) -> tuple[list[str], int]:
    with path.open("rb") as stream:
        head = stream.read(1 << 20)
    marker = head.index(b"end_header\n")
    lines = head[:marker].decode("ascii").splitlines()
    names = [line.split()[2] for line in lines if line.startswith("property float ")]
    count = next(int(line.split()[2]) for line in lines if line.startswith("element vertex "))
    return names, count


def finite_ok(path: Path) -> bool:
    rows = read_gaussian_ply(path)
    names = rows.dtype.names or ()
    for start in range(0, len(rows), CHUNK_ROWS):
        block = rows[start:start + CHUNK_ROWS]
        for name in names:
            if not np.isfinite(block[name]).all():
                return False
    return True


def ordered_subsequence_fraction(original: Path, candidate: Path) -> dict:
    """Stream both files (field-order normalized) and check the candidate is an
    ordered subsequence of the original: the official filter removes rows and
    preserves row order, though it may reorder columns. Consumes input one window
    at a time and candidate rows advance only by the number matched, so a removal
    never desynchronizes the window alignment. No full-file key sets."""
    a = read_gaussian_ply(original)
    b = read_gaussian_ply(candidate)
    names = a.dtype.names or ()
    if set(names) != set(b.dtype.names or ()):
        return {"comparable": False, "reason": "field set differs"}
    packed = np.dtype([(name, "<f4") for name in names])

    def pack(rows: np.ndarray) -> np.ndarray:
        table = np.empty(len(rows), dtype=packed)
        for name in names:
            table[name] = rows[name]
        return table.view(f"V{packed.itemsize}")

    win = CHUNK_ROWS
    total = len(b)
    matched = 0
    ai = 0
    cidx = 0
    while cidx < total and ai < len(a):
        akeys = pack(a[ai:ai + win])
        ckeys = pack(b[cidx:cidx + win])
        bi = 0
        ci = 0
        while bi < len(akeys) and ci < len(ckeys):
            if akeys[bi] == ckeys[ci]:
                matched += 1
                bi += 1
                ci += 1
            else:
                bi += 1
        ai += win
        cidx += ci
    return {"comparable": True, "candidateRows": total, "matchedInOrder": matched,
            "fraction": matched / total if total else None,
            "orderPreservedSubsequence": matched == total}


def verify_candidate(source: Path, out: Path, src_names: list[str], src_count: int,
                     manifest: dict) -> None:
    """Validate a produced candidate: same field SET (order may differ, per the
    official writer), finite values, and rows an ordered subsequence of source."""
    if not out.exists():
        raise RuntimeError("official CLI produced no output file")
    out_names, out_count = header_properties(out)
    if set(out_names) != set(src_names):
        raise RuntimeError("output changed the Gaussian field set")
    manifest.update({
        "outputGaussianCount": out_count,
        "removedGaussianCount": src_count - out_count,
        "removedPercentage": (src_count - out_count) / src_count * 100,
        "outputSha256": sha256(out),
        "outputBytes": out.stat().st_size,
        "outputPropertyCount": len(out_names),
        "schemaFieldSetIdentical": set(out_names) == set(src_names),
        "schemaFieldOrderPreserved": out_names == src_names,
    })
    if not 0 < out_count <= src_count:
        raise RuntimeError("output Gaussian count out of range")
    manifest["outputAllFinite"] = finite_ok(out)
    if not manifest["outputAllFinite"]:
        raise RuntimeError("output contains non-finite values")
    manifest["orderedSubsequence"] = ordered_subsequence_fraction(source, out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--params", required=True, help="voxelSize,opacityCutoff,minContribution")
    parser.add_argument("--label", required=True)
    parser.add_argument("--gpu", default="0")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--verify-only", action="store_true",
                        help="re-validate an existing candidate dir without re-running the CLI")
    args = parser.parse_args()

    source = Path(args.source).resolve(strict=True)
    out_dir = Path(args.out_dir).absolute()
    if args.verify_only:
        manifest = json.loads((out_dir / "manifest.json").read_text())
        src_names, src_count = header_properties(source)
        verify_candidate(source, out_dir / "candidate.ply", src_names, src_count, manifest)
        manifest["status"] = "WAITING_FOR_APPROVAL"
        manifest.pop("error", None)
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps(manifest, indent=2))
        return 0
    if out_dir.exists():
        raise SystemExit(f"output dir already exists: {out_dir}")
    out_dir.mkdir(parents=True, mode=0o700)
    out = out_dir / "candidate.ply"

    params = tuple(float(x) for x in args.params.split(","))
    assert len(params) == 3, "expect voxelSize,opacityCutoff,minContribution"

    source_sha = sha256(source)
    if source_sha != args.expected_sha256:
        raise SystemExit("source SHA256 mismatch before run")

    src_names, src_count = header_properties(source)

    manifest = {
        "schemaVersion": 1,
        "experimentId": f"GS_NEXT_08_{args.label}",
        "label": args.label,
        "officialToolVersion": TOOL_VERSION,
        "cliPath": str(CLI_PATH),
        "filterCoordinateSpace": "SOURCE_PLY (official PLY convention; identity world transform)",
        "filters": [{"kind": "floaters", "parameters": list(params)}],
        "constraint": "single official filter-floaters only; no cluster/box/opacity-stacking",
        "status": "RUNNING",
        "source": {"path": str(source), "sha256": source_sha, "bytes": source.stat().st_size,
                   "inputGaussianCount": src_count, "propertyCount": len(src_names)},
        "publishingEnabled": False,
        "approvalStatus": "HOLD_NOT_APPROVED",
    }
    (out_dir / "source-checksum.json").write_text(json.dumps(
        {"sha256": source_sha, "bytes": source.stat().st_size}, indent=2) + "\n")
    (out_dir / "filter-config.json").write_text(json.dumps(
        {"label": args.label, "parameters": list(params), "gpu": args.gpu,
         "timeoutSeconds": args.timeout}, indent=2) + "\n")
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    command = [str(CLI_PATH), "--gpu", args.gpu, str(source),
               "--filter-floaters", ",".join(format(p, ".17g") for p in params),
               "--info", "json", "--stats", "json", str(out),
               "--no-tty", "--memory", "--max-workers", "0"]
    started = time.monotonic()
    record: dict = {"arguments": command[1:], "exitCode": None}
    try:
        validate_cli(CLI_PATH, cwd=out_dir)
        output = run_cli_command(command, cwd=out_dir, timeout=args.timeout)
        record = execution_record(command, output)
        (out_dir / "cli.log").write_text(output[-LOG_LIMIT:])
        if not out.exists():
            raise RuntimeError("official CLI produced no output file")
        verify_candidate(source, out, src_names, src_count, manifest)
        manifest["status"] = "WAITING_FOR_APPROVAL"
    except BaseException as error:  # noqa: BLE001
        manifest.update({"status": "FAILED", "error": str(error)[:4096]})
        record["error"] = str(error)[:4096]
        raise
    finally:
        manifest["durationSeconds"] = time.monotonic() - started
        record.update({"durationSeconds": manifest["durationSeconds"],
                       "peakChildRssKiBCumulativeProcess":
                           resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss})
        record["sourceUnchanged"] = sha256(source) == source_sha
        (out_dir / "cli-execution.json").write_text(json.dumps(record, indent=2) + "\n")
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: manifest.get(k) for k in
                      ("label", "status", "outputGaussianCount",
                       "removedGaussianCount", "removedPercentage", "durationSeconds")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
