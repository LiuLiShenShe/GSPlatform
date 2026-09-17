"""Progress aggregation for the reconstruction pipeline (Phase 07).

Each profile declares per-stage *weights* (sum ≈ 100) and rules for whether a
stage yields precise or indeterminate progress. The orchestrator calls
``StageProgress.advance(stage, detail)`` where detail∈[0,1] is the *within-stage*
fraction reported by a real tool event (ffmpeg time/frames, COLMAP images,
gsplat iteration). Stages without a trustworthy denominator report
indeterminate progress: the UI shows stage-type + elapsed time instead of a
faked percentage.
"""

from __future__ import annotations

from dataclasses import dataclass

INDETERMINATE = -1.0  # sentinel: stage running, no trusted denominator


@dataclass(frozen=True)
class StageSpec:
    name: str
    weight: float  # contribution to overall 0-100
    precise: bool  # True → tool reports trustworthy bounded progress; False → indeterminate


class StageProgress:
    """Aggregate per-stage progress into a single 0-100 number."""

    def __init__(self, stages: list[StageSpec]) -> None:
        total = sum(s.weight for s in stages)
        if total <= 0:
            raise ValueError("stage weights 总和必须 > 0")
        # Normalize weights to 100.
        self._stages = stages
        self._weight = [s.weight / total * 100.0 for s in stages]
        self._base = [0.0]
        for w in self._weight[:-1]:
            self._base.append(self._base[-1] + w)

    def advance(self, stage: str, detail: float) -> int:
        """Return overall percent (0..100) for the given stage at *detail*.

        ``detail`` is 0..1.  Precise stages report ``base + weight*detail``
        from real tool events.  Indeterminate stages report their start
        offset while running; at ``detail >= 1.0`` (stage finished) they jump
        to the end offset so completion always advances past the stage.
        """
        for i, spec in enumerate(self._stages):
            if spec.name == stage:
                frac = max(0.0, min(1.0, float(detail)))
                return int(self._base[i] + self._weight[i] * frac)
        raise KeyError(f"未知 stage: {stage}")

    def at_start(self, stage: str) -> int:
        """Percent when the stage begins (0..100)."""
        for i, spec in enumerate(self._stages):
            if spec.name == stage:
                return int(self._base[i])
        raise KeyError(f"未知 stage: {stage}")

    def total_stages(self) -> int:
        return len(self._stages)