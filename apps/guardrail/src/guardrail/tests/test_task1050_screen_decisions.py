"""TASK-1050 W2a2 — screening decisions per check and per request (README §9.2, §9.8.1).

Every branch with fakes only: a scored fake classifier and a fake judge runner that
honours the `services/judge_runner.py` interface. No model, no peer, no Redis.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.availability import GuardrailAvailability
from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.services.external_nlp_client import ClassifiedTasks
from guardrail.services.screening import (
    REASON_CLASSIFIER_FALLBACK,
    REASON_JUDGE_PRIMARY,
    REASON_NO_DATA_REGIONS,
    REASON_NOT_IN_BAND,
    Screener,
    compose_decision,
)

TENANT = "tenant-a"


class _Analyzer:
    """Flags a task when its trigger word is in the window; scores on request."""

    def __init__(
        self,
        *,
        triggers: dict[str, str] | None = None,
        scores: dict[str, float] | None = None,
        fail: bool = False,
    ) -> None:
        self.triggers = triggers or {}
        self.scores = scores or {}
        self.fail = fail
        self.calls: list[tuple[tuple[str, ...], str]] = []

    async def classify_tasks_scored(self, task_names: Any, text: str) -> ClassifiedTasks:
        self.calls.append((tuple(task_names), text))
        if self.fail:
            raise GuardrailUndeterminedError(REASON_ENGINE_ERROR, "nlp down")
        labels: dict[str, Any] = {}
        scores: dict[str, dict[str, float]] = {}
        for task in task_names:
            trigger = self.triggers.get(task)
            label = "unsafe" if trigger and trigger in text else "benign"
            labels[task] = [label]
            if task in self.scores:
                value = self.scores[task]
                scores[task] = {label: value if label == "unsafe" else 1.0 - value}
        return ClassifiedTasks(labels=labels, scores=scores)

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        return (await self.classify_tasks_scored(task_names, text)).labels

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "classifier-model"


class _Runner:
    """The JudgeRunner seam: flags a lane when its trigger word is in the window."""

    def __init__(
        self,
        triggers: dict[str, str] | None = None,
        *,
        fail: bool = False,
        missing: bool = False,
        tiers: dict[str, str] | None = None,
        undetermined: dict[str, str] | None = None,
    ) -> None:
        self.triggers = triggers or {}
        self.tiers = tiers or {}
        self.undetermined = undetermined or {}
        self.fail = fail
        self.missing = missing
        self.calls: list[dict[str, Any]] = []

    async def judge(
        self,
        *,
        tenant_id: str,
        direction: str,
        lanes: Any,
        windows: Any,
        mode: str = "prompt",
        prompt_context: Any = None,
    ) -> dict[tuple[str, str], Any]:
        self.calls.append(
            {
                "tenant_id": tenant_id,
                "direction": direction,
                "lanes": tuple(lanes),
                "keys": [w.region_key for w in windows],
                "texts": [w.text for w in windows],
                "prompt_context": prompt_context,
                "items": [tuple(w.items) for w in windows],
                "mode": mode,
            }
        )
        if self.fail:
            raise RuntimeError("judge down")
        if self.missing:
            return {}
        out: dict[tuple[str, str], Any] = {}
        for window in windows:
            for lane in lanes:
                if lane in self.undetermined:
                    out[(lane, window.region_key)] = SimpleNamespace(
                        lane=lane,
                        verdict="undetermined",
                        category=self.undetermined[lane],
                        confidence=None,
                        model="judge-model",
                        latency_ms=0,
                        tier=None,
                    )
                    continue
                trigger = self.triggers.get(lane)
                flagged = bool(trigger and trigger in window.text)
                out[(lane, window.region_key)] = SimpleNamespace(
                    lane=lane,
                    verdict="flag" if flagged else "pass",
                    category=f"{lane}-cat" if flagged else None,
                    confidence=0.9,
                    model="judge-model",
                    latency_ms=12,
                    tier=self.tiers.get(lane) if flagged else None,
                )
        return out


def _availability(
    checks: dict[str, Any] | None = None, directions: dict[str, Any] | None = None
) -> GuardrailAvailability:
    blob: dict[str, Any] = {"checks": checks or {}}
    if directions:
        blob["directions"] = directions
    return GuardrailAvailability.from_tiers(
        system_blob=blob, tenant_blob=None, source_tenant_id=TENANT
    )


def _screener(
    analyzer: Any, availability: GuardrailAvailability | None = None, **kw: Any
) -> Screener:
    return Screener(
        analyzer=analyzer, tenant_id=TENANT, availability=availability, policy_version="pv-1", **kw
    )


def _by_name(decision: Any) -> dict[str, Any]:
    return {check.name: check for check in decision.checks}


# ── the composition rule ──────────────────────────────────────────────────────


def test_precedence_is_block_then_warn_then_unverified_then_allow() -> None:
    assert compose_decision(["warn", "block", "unverified"]) == "block"
    assert compose_decision(["unverified", "warn", "ignore"]) == "warn"
    assert compose_decision(["unverified", "ignore", "none"]) == "unverified"
    assert compose_decision(["ignore", "none"]) == "allow"
    assert compose_decision([]) == "allow"


# ── per-check actions ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_block_action_blocks_and_the_legacy_decision_says_block() -> None:
    decision = await _screener(_Analyzer(triggers={"prompt_safety": "BAD"})).screen_inbound(
        "a BAD prompt"
    )
    check = _by_name(decision)["prompt_safety"]
    assert (check.verdict, check.action, check.action_taken) == ("flag", "block", "block")
    assert decision.guardrail_decision == "block"
    assert decision.decision == "block"
    assert decision.reasons == ["prompt_safety"]
    assert decision.to_dict()["guardrailDecision"] == "block"


@pytest.mark.asyncio
async def test_warn_action_allows_with_a_warning_and_reads_allow_to_old_callers() -> None:
    availability = _availability({"prompt_safety": {"enabled": True, "action": "warn"}})
    decision = await _screener(
        _Analyzer(triggers={"prompt_safety": "BAD"}), availability
    ).screen_inbound("BAD")
    assert _by_name(decision)["prompt_safety"].action_taken == "warn"
    assert decision.guardrail_decision == "warn"
    assert decision.decision == "allow"
    assert decision.reasons == []


@pytest.mark.asyncio
async def test_ignore_action_records_only() -> None:
    availability = _availability({"prompt_safety": {"enabled": True, "action": "ignore"}})
    decision = await _screener(
        _Analyzer(triggers={"prompt_safety": "BAD"}), availability
    ).screen_inbound("BAD")
    check = _by_name(decision)["prompt_safety"]
    assert (check.verdict, check.action_taken) == ("flag", "ignore")
    assert decision.guardrail_decision == "allow"


@pytest.mark.asyncio
async def test_undetermined_degrades_to_unverified_never_a_block() -> None:
    decision = await _screener(_Analyzer(fail=True)).screen_inbound("anything")
    for name in ("jailbreak_detection", "prompt_safety", "prompt_toxicity"):
        assert _by_name(decision)[name].outcome == "undetermined"
        assert _by_name(decision)[name].action_taken == "unverified"
    assert decision.guardrail_decision == "unverified"
    assert decision.decision == "allow"


@pytest.mark.asyncio
async def test_undetermined_under_ignore_is_only_recorded() -> None:
    availability = _availability(
        {
            name: {"enabled": True, "action": "ignore"}
            for name in ("jailbreak_detection", "prompt_safety", "prompt_toxicity")
        }
    )
    decision = await _screener(_Analyzer(fail=True), availability).screen_inbound("anything")
    assert {c.action_taken for c in decision.checks} == {"ignore"}
    assert decision.guardrail_decision == "allow"


@pytest.mark.asyncio
async def test_direction_off_is_monitor_only() -> None:
    availability = _availability(directions={"inbound": {"enabled": False}})
    decision = await _screener(
        _Analyzer(triggers={"prompt_safety": "BAD"}), availability
    ).screen_inbound("BAD")
    check = _by_name(decision)["prompt_safety"]
    assert (check.verdict, check.action_taken) == ("flag", "ignore")
    assert decision.guardrail_decision == "allow"


# ── data vs instruction regions ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_data_flag_takes_the_data_region_action_default_ignore() -> None:
    decision = await _screener(_Analyzer(triggers={"prompt_safety": "BAD"})).screen_inbound_regions(
        [("system", "clean rules", "instruction"), ("transcript", "BAD words", "data")],
        items={"transcript": [("item-1", 3)]},
    )
    check = _by_name(decision)["prompt_safety"]
    assert check.outcome == "pass"  # the legacy deciding outcome
    assert (check.verdict, check.action_taken) == ("flag", "ignore")
    assert decision.guardrail_decision == "allow"
    assert [f.to_dict() for f in decision.data_findings or []] == [
        {"region": "transcript", "reasons": ["prompt_safety"]}
    ]
    assert check.items == (("item-1", 3),)


@pytest.mark.asyncio
async def test_a_platform_admin_may_raise_the_data_region_action() -> None:
    availability = _availability(
        {"prompt_safety": {"enabled": True, "action": "block", "dataRegionAction": "warn"}}
    )
    decision = await _screener(
        _Analyzer(triggers={"prompt_safety": "BAD"}), availability
    ).screen_inbound_regions(
        [("transcript", "BAD words", "data")], items={"transcript": [("item-1", 3)]}
    )
    check = _by_name(decision)["prompt_safety"]
    assert check.action_taken == "warn"
    assert check.flagged_items == (("item-1", 3),)
    assert decision.guardrail_decision == "warn"


@pytest.mark.asyncio
async def test_an_instruction_flag_beats_a_data_ignore() -> None:
    decision = await _screener(_Analyzer(triggers={"prompt_safety": "BAD"})).screen_inbound_regions(
        [("system", "BAD rules", "instruction"), ("transcript", "BAD words", "data")]
    )
    check = _by_name(decision)["prompt_safety"]
    assert check.action_taken == "block"
    assert check.flagged_regions == ("system",)


# ── inbound judges (OD-42, A3, F6) ────────────────────────────────────────────


_JUDGES_ON = {"injection_judge": {"enabled": True}, "unsafe_content_judge": {"enabled": True}}


@pytest.mark.asyncio
async def test_inbound_judges_screen_data_regions_only_with_the_medical_lane_set() -> None:
    runner = _Runner({"unsafe_content_judge": "VIOLENT"})
    decision = await _screener(
        _Analyzer(), _availability(_JUDGES_ON), judge_runner=runner
    ).screen_inbound_regions(
        [
            ("system", "VIOLENT instruction", "instruction"),
            ("transcript", "a VIOLENT threat", "data"),
        ],
        items={"transcript": [("item-9", 2)]},
    )
    # The medical route's plan: medical alone on the instruction region, medical + the
    # safety lanes on the data region — every group runs.
    calls = {c["lanes"]: c for c in runner.calls}
    assert set(calls) == {
        ("medical_validation",),
        ("medical_validation", "injection_judge", "unsafe_content_judge"),
    }
    data_call = calls[("medical_validation", "injection_judge", "unsafe_content_judge")]
    assert data_call["keys"] == ["transcript@0"]  # the safety lanes never see instruction text
    assert data_call["items"] == [(("item-9", 2),)]
    assert data_call["direction"] == "inbound"
    assert calls[("medical_validation",)]["keys"] == ["system@0"]
    unsafe = _by_name(decision)["unsafe_content_judge"]
    assert (unsafe.verdict, unsafe.action, unsafe.action_taken) == ("flag", "warn", "warn")
    assert unsafe.category == "unsafe_content_judge-cat"
    assert unsafe.model == "judge-model"
    assert unsafe.flagged_items == (("item-9", 2),)
    assert _by_name(decision)["injection_judge"].action_taken == "none"
    assert decision.guardrail_decision == "warn"
    medical = _by_name(decision)["medical_validation"]
    assert (medical.verdict, medical.action, medical.action_taken) == ("pass", "block", "none")
    assert medical.region_keys == ("system@0", "transcript@0")


@pytest.mark.asyncio
async def test_with_a_judge_the_classifier_is_off_the_critical_path_for_data_windows() -> None:
    analyzer = _Analyzer(triggers={"prompt_safety": "BAD"})
    decision = await _screener(
        analyzer, _availability(_JUDGES_ON), judge_runner=_Runner()
    ).screen_inbound_regions(
        [("system", "rules", "instruction"), ("transcript", "BAD transcript", "data")]
    )
    # Only the instruction text reached the classifier.
    assert [text for _tasks, text in analyzer.calls] == ["rules"]
    assert _by_name(decision)["prompt_safety"].region_keys == ("system",)


@pytest.mark.asyncio
async def test_a_data_only_governed_call_skips_the_classifier_entirely() -> None:
    analyzer = _Analyzer()
    decision = await _screener(
        analyzer, _availability(_JUDGES_ON), judge_runner=_Runner()
    ).screen_inbound_regions([("transcript", "words", "data")])
    assert analyzer.calls == []
    assert _by_name(decision)["prompt_safety"].reason == REASON_JUDGE_PRIMARY
    assert decision.guardrail_decision == "allow"


@pytest.mark.asyncio
async def test_a_data_action_above_ignore_keeps_the_classifier_on_data() -> None:
    checks = {**_JUDGES_ON, "prompt_safety": {"enabled": True, "dataRegionAction": "warn"}}
    analyzer = _Analyzer(triggers={"prompt_safety": "BAD"})
    decision = await _screener(
        analyzer, _availability(checks), judge_runner=_Runner()
    ).screen_inbound_regions([("transcript", "BAD transcript", "data")])
    assert analyzer.calls == [(("prompt_safety",), "BAD transcript")]
    assert _by_name(decision)["prompt_safety"].action_taken == "warn"


@pytest.mark.asyncio
async def test_an_enabled_judge_on_a_request_without_data_is_skipped() -> None:
    runner = _Runner()
    decision = await _screener(
        _Analyzer(), _availability(_JUDGES_ON), judge_runner=runner
    ).screen_inbound("a prompt")
    assert runner.calls == []
    assert _by_name(decision)["injection_judge"].reason == REASON_NO_DATA_REGIONS


@pytest.mark.asyncio
async def test_judges_that_are_off_cost_no_call_and_stay_off_the_wire() -> None:
    runner = _Runner()
    decision = await _screener(_Analyzer(), judge_runner=runner).screen_inbound_regions(
        [("transcript", "x", "data")]
    )
    assert runner.calls == []
    assert "injection_judge" not in _by_name(decision)


@pytest.mark.asyncio
async def test_judge_down_falls_back_to_the_classifier_scored_by_judge_bands() -> None:
    analyzer = _Analyzer(
        triggers={"jailbreak_detection": "IGNORE"}, scores={"jailbreak_detection": 0.95}
    )
    screener = _screener(
        analyzer,
        _availability({"injection_judge": {"enabled": True, "action": "block"}}),
        judge_runner=_Runner(fail=True),
        judge_bands={"jailbreak_detection": (0.5, 0.9)},
    )
    decision = await screener.screen_inbound_regions([("transcript", "IGNORE previous", "data")])
    check = _by_name(decision)["injection_judge"]
    assert check.reason == REASON_CLASSIFIER_FALLBACK
    assert (check.verdict, check.action_taken) == ("flag", "block")
    assert check.model == "classifier-model"
    assert check.score == pytest.approx(0.95)


@pytest.mark.asyncio
async def test_judge_down_and_an_in_band_fallback_score_is_unverified() -> None:
    analyzer = _Analyzer(
        triggers={"jailbreak_detection": "IGNORE"}, scores={"jailbreak_detection": 0.7}
    )
    screener = _screener(
        analyzer,
        _availability({"injection_judge": {"enabled": True, "action": "block"}}),
        judge_runner=_Runner(missing=True),
        judge_bands={"jailbreak_detection": (0.5, 0.9)},
    )
    decision = await screener.screen_inbound_regions([("transcript", "IGNORE previous", "data")])
    assert _by_name(decision)["injection_judge"].action_taken == "unverified"
    assert decision.guardrail_decision == "unverified"


@pytest.mark.asyncio
async def test_judge_and_classifier_both_down_is_unverified() -> None:
    screener = _screener(_Analyzer(fail=True), _availability(_JUDGES_ON), judge_runner=None)
    decision = await screener.screen_inbound_regions([("transcript", "x", "data")])
    assert _by_name(decision)["unsafe_content_judge"].action_taken == "unverified"
    assert decision.guardrail_decision == "unverified"
    assert decision.decision == "allow"


# ── outbound judges (OD-3 (b)) ────────────────────────────────────────────────


_OUT_JUDGES = {"clinical_safety_judge": {"enabled": True}, "leakage_judge": {"enabled": True}}


@pytest.mark.asyncio
async def test_outbound_judges_run_when_response_safety_is_in_band() -> None:
    runner = _Runner({"leakage_judge": "sk-"})
    screener = _screener(
        _Analyzer(scores={"response_safety": 0.6}),
        _availability(_OUT_JUDGES),
        judge_runner=runner,
        judge_bands={"response_safety": (0.4, 0.8)},
    )
    decision = await screener.screen_outbound(
        "note with sk-abc",
        source_context="note",
        nonce="n0",
        response_items=[("item-out", 1)],
        prompt_context="the user prompt",
    )
    (call,) = runner.calls
    assert call["lanes"] == ("clinical_safety_judge", "leakage_judge")
    assert call["keys"] == ["response@0"]
    assert call["mode"] == "response"
    assert call["prompt_context"] == "the user prompt"
    leak = _by_name(decision)["leakage_judge"]
    assert (leak.verdict, leak.action_taken) == ("flag", "block")
    assert leak.flagged_items == (("item-out", 1),)
    # A benign label at 0.4 confidence reads as unsafe score 0.6 — inside the band.
    assert _by_name(decision)["response_safety"].score == pytest.approx(0.6)
    assert decision.guardrail_decision == "block"
    assert decision.decision == "block"


@pytest.mark.asyncio
async def test_outbound_judges_do_not_run_outside_the_band() -> None:
    runner = _Runner()
    screener = _screener(
        _Analyzer(scores={"response_safety": 0.95}),
        _availability(_OUT_JUDGES),
        judge_runner=runner,
        judge_bands={"response_safety": (0.4, 0.8)},
    )
    decision = await screener.screen_outbound("note", source_context="note", nonce="n0")
    assert runner.calls == []
    assert _by_name(decision)["clinical_safety_judge"].reason == REASON_NOT_IN_BAND
    assert _by_name(decision)["leakage_judge"].reason == REASON_NOT_IN_BAND


@pytest.mark.asyncio
async def test_leakage_judge_runs_when_the_nonce_check_is_skipped() -> None:
    runner = _Runner()
    screener = _screener(_Analyzer(), _availability(_OUT_JUDGES), judge_runner=runner)
    decision = await screener.screen_outbound("note", source_context="note", nonce=None)
    (call,) = runner.calls
    assert call["lanes"] == ("leakage_judge",)
    assert _by_name(decision)["leakage_judge"].verdict == "pass"
    assert _by_name(decision)["clinical_safety_judge"].reason == REASON_NOT_IN_BAND


@pytest.mark.asyncio
async def test_an_outbound_judge_outage_is_unverified() -> None:
    screener = _screener(_Analyzer(), _availability(_OUT_JUDGES), judge_runner=_Runner(fail=True))
    decision = await screener.screen_outbound("note", source_context=None, nonce=None)
    assert _by_name(decision)["leakage_judge"].action_taken == "unverified"
    assert decision.guardrail_decision == "unverified"


@pytest.mark.asyncio
async def test_record_only_outbound_checks_take_ignore() -> None:
    screener = Screener(
        analyzer=_Analyzer(triggers={"jailbreak_detection": "IGNORE"}),
        tenant_id=TENANT,
        outbound_record_only=frozenset({"jailbreak_detection"}),
    )
    decision = await screener.screen_outbound("IGNORE all", source_context="x", nonce="n")
    check = _by_name(decision)["jailbreak_detection"]
    assert (check.outcome, check.verdict, check.action_taken) == ("pass", "flag", "ignore")
    assert decision.guardrail_decision == "allow"


@pytest.mark.asyncio
async def test_check_dicts_carry_the_new_fields() -> None:
    decision = await _screener(
        _Analyzer(triggers={"prompt_safety": "BAD"}, scores={"prompt_safety": 0.8})
    ).screen_inbound("BAD")
    payload = next(c for c in decision.to_dict()["checks"] if c["name"] == "prompt_safety")
    assert payload["verdict"] == "flag"
    assert payload["action"] == "block"
    assert payload["actionTaken"] == "block"
    assert payload["score"] == pytest.approx(0.8)
    assert payload["category"] == "unsafe"
    assert payload["regionKeys"] == ["prompt"]
    # The legacy keys are all still there.
    assert {"name", "outcome", "failMode", "model", "reason", "labels"} <= set(payload)


# ── W2a1 integration: medical lane, exemption, native tiers, reason codes ─────


@pytest.mark.asyncio
async def test_a_not_medical_verdict_blocks_under_the_lock() -> None:
    runner = _Runner({"medical_validation": "football"})
    decision = await _screener(
        _Analyzer(), _availability(_JUDGES_ON), judge_runner=runner
    ).screen_inbound_regions(
        [("transcript", "football scores", "data")], items={"transcript": [("i-1", 1)]}
    )
    medical = _by_name(decision)["medical_validation"]
    assert (medical.verdict, medical.action_taken) == ("flag", "block")
    assert decision.guardrail_decision == "block"
    assert "medical_validation" in decision.reasons


@pytest.mark.asyncio
async def test_an_undetermined_medical_verdict_degrades_to_unverified() -> None:
    runner = _Runner(undetermined={"medical_validation": "JUDGE_ENGINE_ERROR"})
    decision = await _screener(
        _Analyzer(), _availability(_JUDGES_ON), judge_runner=runner
    ).screen_inbound_regions([("transcript", "a note", "data")])
    medical = _by_name(decision)["medical_validation"]
    assert (medical.outcome, medical.action_taken, medical.reason) == (
        "undetermined",
        "unverified",
        "JUDGE_ENGINE_ERROR",
    )
    assert medical.category is None  # a reason code is never reported as a category
    assert decision.guardrail_decision == "unverified"


@pytest.mark.asyncio
async def test_a_medical_exempt_request_skips_the_medical_lane() -> None:
    runner = _Runner()
    decision = await _screener(
        _Analyzer(), _availability(_JUDGES_ON), judge_runner=runner
    ).screen_inbound_regions(
        [("system", "rules", "instruction"), ("transcript", "a note", "data")],
        include_medical=False,
    )
    assert [c["lanes"] for c in runner.calls] == [("injection_judge", "unsafe_content_judge")]
    assert "medical_validation" not in _by_name(decision)


@pytest.mark.asyncio
async def test_configuration_regions_skip_the_medical_lane() -> None:
    runner = _Runner()
    await _screener(
        _Analyzer(),
        _availability(_JUDGES_ON),
        judge_runner=runner,
        medical_skip=frozenset({"style_reference"}),
    ).screen_inbound_regions(
        [("style_reference", "DNA style", "instruction"), ("transcript", "a note", "data")]
    )
    assert [c["lanes"] for c in runner.calls] == [
        ("medical_validation", "injection_judge", "unsafe_content_judge")
    ]


@pytest.mark.asyncio
async def test_a_native_tier_warn_or_block_is_a_fixed_outcome() -> None:
    checks = {"unsafe_content_judge": {"enabled": True, "action": "ignore"}}
    fixed = _Runner({"unsafe_content_judge": "VIOLENT"}, tiers={"unsafe_content_judge": "block"})
    decision = await _screener(
        _Analyzer(), _availability(checks), judge_runner=fixed
    ).screen_inbound_regions([("transcript", "VIOLENT", "data")])
    assert _by_name(decision)["unsafe_content_judge"].action_taken == "block"

    configured = _Runner(
        {"unsafe_content_judge": "VIOLENT"}, tiers={"unsafe_content_judge": "flag"}
    )
    decision = await _screener(
        _Analyzer(), _availability(checks), judge_runner=configured
    ).screen_inbound_regions([("transcript", "VIOLENT", "data")])
    assert _by_name(decision)["unsafe_content_judge"].action_taken == "ignore"


@pytest.mark.asyncio
async def test_bands_come_from_the_policy_rows_judge_bands() -> None:
    from guardrail.core.policy import GuardrailPolicy

    policy = GuardrailPolicy.from_blob(
        {"judgeBands": {"response_safety": {"low": 0.4, "high": 0.8}}}
    )
    runner = _Runner()
    screener = _screener(
        _Analyzer(scores={"response_safety": 0.6}),
        _availability(_OUT_JUDGES),
        judge_runner=runner,
        screen_policy=policy,
    )
    await screener.screen_outbound("note", source_context="note", nonce="n0")
    assert [c["lanes"] for c in runner.calls] == [("clinical_safety_judge", "leakage_judge")]
    # No band declared for a check ⇒ nothing is routed on a guessed one.
    assert screener._band("jailbreak_detection") is None
