"""Explicit, isolated official-CLI experiments. No database, queue, or publishing path."""

from __future__ import annotations

import hashlib
import json
import math
import re
import resource
import shutil
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from workers.pipeline.gaussian_quality import (
    CHUNK_ROWS,
    compare_gaussian_ply,
    read_gaussian_ply,
)
from workers.pipeline.splat_transform_adapter import (
    CLI_PATH,
    ROOT,
    TOOL_VERSION,
    execution_record,
    run_cli_command,
    validate_cli,
)


@dataclass(frozen=True)
class OfficialFilter:
    kind: str
    parameters: tuple[float, ...] = ()
    seed: tuple[float, ...] | None = None
    column: str | None = None
    comparison: str | None = None

    def arguments(self, columns: tuple[str, ...]) -> list[str]:
        if any(not math.isfinite(value) for value in self.parameters):
            raise ValueError("Filter parameters must be finite")
        if self.kind != "value" and (self.column is not None or self.comparison is not None):
            raise ValueError("Column/comparison only apply to value filtering")
        if self.kind in ("floaters", "cluster"):
            if (len(self.parameters) != 3 or self.parameters[0] <= 0
                    or not 0 <= self.parameters[1] <= 1 or self.parameters[2] < 0):
                raise ValueError("Explicit positive resolution, opacity [0,1], contribution >=0 required")
            if self.kind == "cluster":
                if self.seed is None or len(self.seed) != 3 or not all(map(math.isfinite, self.seed)):
                    raise ValueError("Cluster filter requires an explicit finite source-space seed")
                runtime_seed = (-self.seed[0], -self.seed[1], self.seed[2])
                return ["--seed-pos", _csv(runtime_seed), "--filter-cluster", _csv(self.parameters)]
            if self.seed is not None:
                raise ValueError("Seed only applies to cluster filtering")
            return ["--filter-floaters", _csv(self.parameters)]
        if self.seed is not None:
            raise ValueError("Seed only applies to cluster filtering")
        if self.kind == "box":
            if len(self.parameters) != 6 or any(self.parameters[axis] >= self.parameters[axis + 3]
                                              for axis in range(3)):
                raise ValueError("ROI requires finite, strictly ordered min/max corners")
            source_box = self.parameters
            runtime_box = (-source_box[3], -source_box[4], source_box[2],
                           -source_box[0], -source_box[1], source_box[5])
            return ["--filter-box", _csv(runtime_box)]
        if self.kind == "nan" and not self.parameters:
            return ["--filter-nan"]
        if (self.kind == "value" and len(self.parameters) == 1 and self.column in columns
                and self.column not in ("x", "y", "z")
                and self.comparison in ("lt", "lte", "gt", "gte", "eq", "neq")):
            return ["--filter-value", f"{self.column},{self.comparison},{self.parameters[0]}"]
        raise ValueError("Unsupported official filter or parameter shape")


@dataclass(frozen=True)
class CleanupConfig:
    experiment_id: str
    filters: tuple[OfficialFilter, ...]
    rationale: str
    gpu: str = "cpu"
    timeout_seconds: int = 600
    minimum_free_bytes: int = 2 * 1024**3
    minimum_retained_fraction: float = 0.9
    visual_review: str = "PENDING"


def _csv(values: tuple[float, ...]) -> str:
    return ",".join(format(value, ".17g") for value in values)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(8 * 1024**2):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")


def run_cleanup_experiment(source: Path, directory: Path, expected_sha256: str,
                           config: CleanupConfig) -> dict:
    source = source.resolve(strict=True)
    directory = directory.absolute()
    resolved = directory.resolve()
    if (resolved.is_relative_to(ROOT) or source.is_relative_to(resolved)
            or set(resolved.parts).intersection({"published", "versions", "quarantine", ".staging"})
            or directory.is_symlink() or resolved != directory or directory.exists()):
        raise ValueError("Experiment output must be a new isolated directory outside repository/storage")
    if (source.suffix != ".ply" or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", config.experiment_id)
            or not config.filters or not config.rationale.strip()
            or type(config.timeout_seconds) is not int or not 0 < config.timeout_seconds <= 7200
            or type(config.minimum_free_bytes) is not int or config.minimum_free_bytes < 0
            or not math.isfinite(config.minimum_retained_fraction)
            or not 0 < config.minimum_retained_fraction <= 1
            or config.visual_review not in ("PENDING", "REJECTED")
            or not re.fullmatch(r"cpu|[0-9]+", config.gpu)):
        raise ValueError("Invalid explicit experiment configuration")
    rows = read_gaussian_ply(source)
    if (len(rows) > 1_000_000
            and not (len(config.filters) == 1 and config.filters[0].kind == "box")):
        raise ValueError("Large-scene filtering is disabled until separately reviewed full-scene preflight")
    arguments = [argument for action in config.filters for argument in
                 action.arguments(rows.dtype.names or ())]
    if config.gpu == "cpu" and any(action.kind in ("cluster", "floaters") for action in config.filters):
        raise ValueError("Official voxel filters require an explicit GPU adapter (software adapter permitted)")
    if sum(action.kind == "cluster" for action in config.filters) > 1:
        raise ValueError("Multiple cluster seeds require separate reviewed experiments")
    for action in config.filters:
        if (action.kind == "cluster" and action.seed is not None
                and any(not float(rows[axis].min()) <= value <= float(rows[axis].max())
                        for axis, value in zip(("x", "y", "z"), action.seed, strict=True))):
            raise ValueError("Cluster seed must be inside source bounds; connectivity still needs review")
    actual_sha256 = _sha256(source)
    if actual_sha256 != expected_sha256:
        raise ValueError("Input PLY SHA256 mismatch")
    ancestor = resolved.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    required_free = 3 * source.stat().st_size + config.minimum_free_bytes
    if shutil.disk_usage(ancestor).free < required_free:
        raise ValueError("Insufficient disk space for output, working data and safety reserve")
    directory.mkdir(parents=True, mode=0o700)
    output = directory / "candidate.ply"
    manifest = {"schemaVersion": 1, "experimentId": config.experiment_id, "status": "RUNNING",
                "sourceSha256": actual_sha256, "sourceBytes": source.stat().st_size,
                "inputGaussianCount": len(rows), "officialToolVersion": TOOL_VERSION,
                "filters": [asdict(action) for action in config.filters],
                "publishingEnabled": False, "visualReview": config.visual_review,
                "filterCoordinateSpace": "SOURCE_PLY",
                "sourceToCliRuntime": "(-x,-y,z); official PLY Z180 convention",
                "outputCoordinateSpace": "SOURCE_PLY; official PLY writer convention"}
    _write_json(directory / "source-checksum.json", {"sha256": actual_sha256,
                                                     "bytes": source.stat().st_size})
    _write_json(directory / "filter-config.json", asdict(config))
    _write_json(directory / "candidate-manifest.json", manifest)
    started = time.monotonic()
    command = [str(CLI_PATH), "--gpu", config.gpu, str(source), *arguments, "--info", "json",
               "--stats", "json", str(output), "--no-tty", "--memory", "--max-workers", "0"]
    record = {"arguments": command[1:], "exitCode": None}
    try:
        validate_cli(CLI_PATH, cwd=directory)
        cli_output = run_cli_command(command, cwd=directory, timeout=config.timeout_seconds)
        record = execution_record(command, cli_output)
        candidate = read_gaussian_ply(output)
        retained = len(candidate) / len(rows)
        manifest.update({"outputGaussianCount": len(candidate),
                         "removedGaussianCount": len(rows) - len(candidate),
                         "removedPercentage": (1 - retained) * 100,
                         "outputSha256": _sha256(output), "outputBytes": output.stat().st_size})
        if not 0 < len(candidate) <= len(rows) or retained < config.minimum_retained_fraction:
            raise ValueError("Abnormal output Gaussian count / removal exceeds explicit limit")
        if set(candidate.dtype.names or ()) != set(rows.dtype.names or ()):
            raise ValueError("Output changed Gaussian columns / SH schema")
        for start in range(0, len(candidate), CHUNK_ROWS):
            block = candidate[start:start + CHUNK_ROWS]
            if any(not np.isfinite(block[name]).all() for name in candidate.dtype.names or ()):
                raise ValueError("Candidate contains NaN/Inf")
        comparison = compare_gaussian_ply(source, output)
        _write_json(directory / "quality-comparison.json", comparison)
        if comparison["retainedRowsBitIdenticalIncludingSH"] is False:
            raise ValueError("Candidate modified retained Gaussian values / SH")
        manifest["status"] = "REJECTED" if config.visual_review == "REJECTED" else "WAITING_FOR_APPROVAL"
        return manifest
    except BaseException as error:
        manifest.update({"status": "FAILED", "error": str(error)[:4096]})
        record["error"] = str(error)[:4096]
        raise
    finally:
        unchanged = _sha256(source) == expected_sha256
        manifest["sourceUnchanged"] = unchanged
        manifest["durationSeconds"] = time.monotonic() - started
        record.update({"durationSeconds": manifest["durationSeconds"],
                       "peakChildRssKiBCumulativeProcess": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss})
        if not unchanged:
            manifest.update({"status": "FAILED", "error": "Source changed during experiment"})
        _write_json(directory / "cli-execution.json", record)
        _write_json(directory / "candidate-manifest.json", manifest)
        if not unchanged:
            raise ValueError("Source changed during experiment")
