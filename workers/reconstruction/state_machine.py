"""Reconstruction stage state machine and completion markers (Phase 07).

The pipeline runs as a linear DAG of stages. Each stage is:

- *idempotent*: writes a completion marker (``stage-state/<STAGE>.done``) into
  the job attempt directory containing {input_hash, param_hash, tool_versions,
  output_hash}. A stage whose marker is present and matches the current
  parameters is skipped.
- *cancellable*: the orchestrator polls ``cancel_requested`` at every stage
  boundary and between tool polls.
- *journaled*: progress/status transitions are persisted to the DB by the
  orchestrator task; this module owns the *stage sequence* and the marker file
  format only.

The stage sequence is defined once here so orchestrator, tasks, and the
compute API all agree on order and weights.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

RECONSTRUCTION_STAGES: tuple[str, ...] = (
    "PROBING",
    "EXTRACTING",
    "PRECHECK",
    "FEATURES",
    "MATCHING",
    "MAPPING",
    "TRAINING",
    "CONVERTING",
    "VERIFYING",
    "PUBLISHING",
    "SUCCEEDED",
)

TERMINAL_STAGES = {"SUCCEEDED", "FAILED", "CANCELLED"}


@dataclass(frozen=True)
class CompletionMarker:
    """Metadata proving a stage already produced its artifact."""

    stage: str
    input_hash: str
    param_hash: str
    tool_versions: dict[str, str]
    output_hash: str

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "input_hash": self.input_hash,
            "param_hash": self.param_hash,
            "tool_versions": self.tool_versions,
            "output_hash": self.output_hash,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CompletionMarker":
        return cls(
            stage=str(data["stage"]),
            input_hash=str(data["input_hash"]),
            param_hash=str(data["param_hash"]),
            tool_versions={str(k): str(v) for k, v in (data.get("tool_versions") or {}).items()},
            output_hash=str(data["output_hash"]),
        )


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_of_text(text: str) -> str:
    return sha256_of_bytes(text.encode("utf-8"))


def param_hash(**kwargs) -> str:
    """Stable hash of a stage's parameter dict (sorted keys)."""
    return sha256_of_text(json.dumps(kwargs, sort_keys=True, ensure_ascii=False))


class StageManager:
    """Read/write completion markers for a job attempt."""

    def __init__(self, stage_state_dir: Path) -> None:
        self._dir = stage_state_dir
        self._dir.mkdir(parents=True, exist_ok=True)

    def marker_path(self, stage: str) -> Path:
        return self._dir / f"{stage}.done"

    def read(self, stage: str) -> CompletionMarker | None:
        path = self.marker_path(stage)
        if not path.exists():
            return None
        try:
            return CompletionMarker.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (ValueError, KeyError, OSError):
            return None

    def write(self, marker: CompletionMarker) -> None:
        """Atomically write the marker (tmp + rename)."""
        path = self.marker_path(marker.stage)
        tmp = self._dir / f".{marker.stage}.done.tmp"
        tmp.write_text(
            json.dumps(marker.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(path)

    def is_complete(self, stage: str, *, input_hash: str, param_hash: str) -> bool:
        marker = self.read(stage)
        return (
            marker is not None
            and marker.input_hash == input_hash
            and marker.param_hash == param_hash
        )

    def completed_stages(self) -> set[str]:
        result: set[str] = set()
        for path in self._dir.glob("*.done"):
            result.add(path.name[: -len(".done")])
        return result


def next_incomplete_stage(
    stages: tuple[str, ...],
    done: set[str],
) -> str | None:
    """First stage in *stages* that has no done marker; None if all done."""
    for s in stages:
        if s not in done:
            return s
    return None


def first_cpu_stage_index(stages: tuple[str, ...]) -> int:
    """Index just before the GPU stage boundary (EXTRACTING→…→MAPPING on CPU)."""
    return stages.index("TRAINING")