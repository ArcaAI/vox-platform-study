"""Guardrail's AD-1 per-call stats mirror.

Survivor of `test_openai_compat_stats.py`, which went with the engine adapters in
TASK-735 Phase 2b. The stats SHAPE outlives them: `apps/text` returns its own
`GenerationStats` on a judgement and guardrail maps it onto this mirror so its
token spend still rides back to the billing plane.
"""

from __future__ import annotations

from guardrail.providers.stats import GuardrailCallStats, normalize_stop_reason


def test_normalize_stop_reason_openai_wire() -> None:
    assert normalize_stop_reason("stop") == "stop"
    assert normalize_stop_reason("length") == "length"
    assert normalize_stop_reason("content_filter") == "content_filter"
    assert normalize_stop_reason("tool_calls") == "tool_call"


def test_unknown_or_absent_stop_reason_never_raises() -> None:
    """Null-safety is the contract: telemetry may degrade, a verdict may not."""
    assert normalize_stop_reason(None) == "other"
    assert normalize_stop_reason("something-novel") == "other"


def test_stats_default_to_zeros_rather_than_None() -> None:
    stats = GuardrailCallStats()
    assert stats.to_dict()["prompt_tokens"] == 0
    assert stats.to_dict()["stop_reason"] == "other"
