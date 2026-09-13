"""TASK-968 — the judge's reasoning posture is PLATFORM configuration.

Owner directive 2026-09-13: reasoning OFF for text generation, and configuration belongs to
the platform admin rather than to an environment variable.

Two things are pinned here:

1. ``resolve_judge_reasoning`` reads ``harness.judge.reasoningMode`` / ``.reasoningEffort``
   off the control-plane snapshot with the SAME degradation contract as
   ``resolve_sensor_thresholds`` — every rejection path keeps the base, which is reasoning
   off. An out-of-vocabulary value is REFUSED, never coerced.

2. The posture reaches ``_build_runtime_judge``, i.e. the judge that
   ``run_inferential_sensors`` builds for the groundedness and citation-verify sensors on
   every real consultation. That is the half of this that is NOT eval-only, and it is why the
   old ``HARNESS_JUDGE_EXTRA_BODY`` env var was deciding a live clinical pass's token budget.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.eval.reasoning import (
    JUDGE_REASONING_EFFORT_KEY,
    JUDGE_REASONING_FLOOR,
    JUDGE_REASONING_MODE_KEY,
    JudgeReasoning,
    resolve_judge_reasoning,
)


class _Snapshot:
    """The bits of `EffectiveConfigSnapshot` this resolver touches."""

    def __init__(self, settings: dict[str, Any], *, ok: bool = True) -> None:
        self._settings = settings
        self.ok = ok

    def setting(self, key: str) -> Any:
        return self._settings.get(key)


def test_the_floor_is_reasoning_off():
    assert JUDGE_REASONING_FLOOR == JudgeReasoning(mode="none", effort="minimal")


def test_a_platform_admin_can_raise_both_levers():
    snapshot = _Snapshot(
        {JUDGE_REASONING_MODE_KEY: "think", JUDGE_REASONING_EFFORT_KEY: "high"}
    )
    assert resolve_judge_reasoning(snapshot) == JudgeReasoning(mode="think", effort="high")


def test_the_two_levers_resolve_independently():
    snapshot = _Snapshot({JUDGE_REASONING_EFFORT_KEY: "medium"})
    assert resolve_judge_reasoning(snapshot) == JudgeReasoning(mode="none", effort="medium")


@pytest.mark.parametrize(
    "snapshot",
    [
        pytest.param(None, id="no snapshot"),
        pytest.param(
            _Snapshot({JUDGE_REASONING_MODE_KEY: "think"}, ok=False), id="failed pull"
        ),
        pytest.param(_Snapshot({}), id="key absent"),
        pytest.param(_Snapshot({JUDGE_REASONING_MODE_KEY: None}), id="null value"),
    ],
)
def test_every_degradation_path_keeps_the_floor(snapshot):
    """A degraded control plane must leave the judge where it was — off, not on."""
    assert resolve_judge_reasoning(snapshot) is JUDGE_REASONING_FLOOR


@pytest.mark.parametrize(
    "settings",
    [
        pytest.param({JUDGE_REASONING_MODE_KEY: "loud"}, id="mode not in vocabulary"),
        pytest.param({JUDGE_REASONING_EFFORT_KEY: "max"}, id="effort not in vocabulary"),
        pytest.param({JUDGE_REASONING_EFFORT_KEY: 3}, id="wrong type"),
        pytest.param({JUDGE_REASONING_MODE_KEY: True}, id="bool is not a mode"),
    ],
)
def test_an_out_of_contract_value_is_refused_not_coerced(settings):
    """Coercing would invent a posture nobody chose and hide the defect that produced it."""
    assert resolve_judge_reasoning(_Snapshot(settings)) is JUDGE_REASONING_FLOOR


def test_a_non_floor_base_is_honoured():
    """The eval endpoint passes the config's own values as the base."""
    base = JudgeReasoning(mode="auto", effort="low")
    assert resolve_judge_reasoning(_Snapshot({}), base=base) is base


# ── The live clinical path ─────────────────────────────────────────────────────


def test_the_runtime_judge_carries_the_resolved_posture(monkeypatch: pytest.MonkeyPatch):
    """`run_inferential_sensors` builds THIS judge for every consultation's assurance pass."""
    from harness.eval.judge import providers
    from harness.temporal import activities

    built: dict[str, Any] = {}
    monkeypatch.setattr(
        providers, "build_judge_client", lambda config: built.setdefault("config", config)
    )
    monkeypatch.setattr(
        activities, "build_judge_client", lambda config: built.setdefault("config", config)
    )

    activities._build_runtime_judge(
        provider="openai_compat",
        model="gemma-4-e2b-it-qat",
        reasoning=JudgeReasoning(mode="think", effort="high"),
    )

    config = built["config"]
    assert (config.reasoning_mode, config.reasoning_effort) == ("think", "high")
    assert providers._reasoning_extra_body(config) == {"reasoning_effort": "high"}


def test_the_runtime_judge_without_a_posture_stays_on_the_floor(monkeypatch: pytest.MonkeyPatch):
    """An unreachable control plane degrades to the directive, never to the engine default."""
    from harness.eval.judge import providers
    from harness.temporal import activities

    built: dict[str, Any] = {}
    monkeypatch.setattr(
        activities, "build_judge_client", lambda config: built.setdefault("config", config)
    )

    activities._build_runtime_judge(provider="openai_compat", model="gemma-4-e2b-it-qat")

    config = built["config"]
    assert (config.reasoning_mode, config.reasoning_effort) == ("none", "minimal")
    assert providers._reasoning_extra_body(config) == {"reasoning_effort": "minimal"}
