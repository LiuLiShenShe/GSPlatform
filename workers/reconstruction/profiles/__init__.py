"""Profile loading and validation (Phase 07).

Profiles are versioned YAML files under ``workers/reconstruction/profiles/``.
The loader validates structure, normalizes stage weights, and exposes the
precise-stage set as :class:`StageSpec` objects for :class:`StageProgress`.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

from workers.reconstruction.progress import StageSpec
from workers.reconstruction.state_machine import RECONSTRUCTION_STAGES

PROFILES_DIR = Path(__file__).resolve().parent
AVAILABLE_PROFILES = ("draft", "standard", "high")


class ProfileError(ValueError):
    """Invalid or unknown quality profile."""


class Profile:
    """Typed wrapper over a loaded profile dict."""

    def __init__(self, raw: dict[str, Any], source: str) -> None:
        self.name = str(raw["name"])
        self.version = int(raw.get("version", 1))
        self.raw = raw
        self.source = source
        self._stage_specs = self._build_stage_specs(raw)

    # ---- stage specs -------------------------------------------------- #
    def _build_stage_specs(self, raw: dict[str, Any]) -> list[StageSpec]:
        weights = raw.get("stage_weights") or {}
        precise = set(raw.get("precise_stages") or [])
        specs: list[StageSpec] = []
        for stage in RECONSTRUCTION_STAGES:
            if stage == "SUCCEEDED":
                continue
            w = weights.get(stage)
            if w is None:
                raise ProfileError(f"profile {self.name} 缺少 stage 权重: {stage}")
            specs.append(
                StageSpec(name=stage, weight=float(w), precise=stage in precise)
            )
        total = sum(s.weight for s in specs)
        if total <= 0:
            raise ProfileError(f"profile {self.name} stage 权重总和无效: {total}")
        return specs

    @property
    def stage_specs(self) -> list[StageSpec]:
        return self._stage_specs

    # ---- typed accessors ---------------------------------------------- #
    def section(self, name: str) -> dict[str, Any]:
        value = self.raw.get(name)
        if not isinstance(value, dict):
            raise ProfileError(f"profile {self.name} 缺少 section: {name}")
        return copy.deepcopy(value)

    def input_limits(self) -> dict[str, Any]:
        return self.section("input")

    def extract(self) -> dict[str, Any]:
        return self.section("extract")

    def colmap(self) -> dict[str, Any]:
        return self.section("colmap")

    def gsplat(self) -> dict[str, Any]:
        return self.section("gsplat")

    def convert(self) -> dict[str, Any]:
        return self.section("convert")

    def resource(self) -> dict[str, Any]:
        return self.section("resource")


def load_profile(name: str) -> Profile:
    """Load and validate a profile by name (draft | standard | high)."""
    if name not in AVAILABLE_PROFILES:
        raise ProfileError(
            f"未知 profile: {name!r}（可用: {', '.join(AVAILABLE_PROFILES)}）"
        )
    path = PROFILES_DIR / f"{name}.yaml"
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ProfileError(f"无法读取 profile {name}: {exc}") from exc
    if not isinstance(raw, dict) or "name" not in raw:
        raise ProfileError(f"profile {name} 结构无效")
    return Profile(raw, str(path))


def public_profile_summary(name: str) -> dict[str, Any]:
    """Safe, UI-facing summary — never exposes absolute paths or internals."""
    profile = load_profile(name)
    return {
        "name": profile.name,
        "version": profile.version,
        "maxInputBytes": int(profile.input_limits()["max_bytes"]),
        "maxImages": int(profile.input_limits()["max_images"]),
        "maxVideoSeconds": int(profile.input_limits()["max_video_seconds"]),
        "iterations": int(profile.gsplat()["iterations"]),
        "stages": [s.name for s in profile.stage_specs],
    }


def list_public_profiles() -> list[dict[str, Any]]:
    return [public_profile_summary(n) for n in AVAILABLE_PROFILES]