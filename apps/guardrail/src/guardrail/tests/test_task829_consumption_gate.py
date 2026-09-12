"""and C-3 — the gate that actually matters.

**C-2 is the do-not-ship condition.** *The validated unit at a consumption point
is the CUMULATIVE transcript, never the isolated delta.* Per-delta validation is
cheaper, it is what the streaming tier already produces, and it looks correct —
which is exactly why it is the mistake this file exists to make impossible.

The measured bypass rates against precisely this streaming-segment shape:
Prompt Guard 2 86M **100%**, Granite Guardian HAP-125M **100%**, Prompt Guard 2
22M **82-100%**, DeBERTa-v3 injection detector **92.3%**. Detector confidence
collapses 0.99 -> 0.03 as malicious density per window falls. A payload split
across four utterances passes every per-utterance check and reassembles in the
model's context.

``test_clean_segment_verdicts_never_compose_into_a_cumulative_pass`` is the
regression test for that: it hands the gate a complete set of PASS segment
verdicts covering the entire transcript, and requires the gate to refuse anyway.
**If anyone later "optimises" this into per-delta composition, that test fails.**

**C-3** is the sibling condition: a verdict is valid only for the capability set
it was computed against. Today's four consumer tasks are read-only text->text;
the moment one calls a tool, retrieves, or writes to a chart, its verdict is
recomputed, not inherited.
"""

from __future__ import annotations

import pytest

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.realtime.consumption import (
    ACTION_ALLOW,
    ACTION_BLOCK,
    ACTION_RECOMPUTE_INJECTION,
    ACTION_REVALIDATE_CUMULATIVE,
    CapabilityPolicy,
    ConsumptionGate,
    ConsumptionRequest,
)
from guardrail.realtime.verdict import (
    RETAIN_VERBATIM,
    ClinicalSignal,
    ContentHarm,
    InjectionRisk,
    TranscriptSegmentVerdict,
    VerdictScope,
    WindowAssertion,
    content_hash,
)

CUMULATIVE = "patient reports chest pain. onset two hours ago. no radiation to the arm."
DELTAS = (
    "patient reports chest pain.",
    " onset two hours ago.",
    " no radiation to the arm.",
)

CAPABILITIES = CapabilityPolicy.from_declaration(
    {
        "readonly-text": ["text.read"],
        "chart-write": ["text.read", "chart.write"],
        "retrieval": ["text.read", "retrieval.query"],
    }
)


def _gate() -> ConsumptionGate:
    return ConsumptionGate(capabilities=CAPABILITIES)


def _scope(text: str, tenant: str = "tenant-a") -> VerdictScope:
    return VerdictScope(
        content_hash=content_hash(text),
        policy_version=7,
        classifier_version="clf-1",
        taxonomy_version="clinical-v3",
        threshold_set="default",
        tenant_id=tenant,
    )


def _verdict(
    text: str,
    *,
    complete: bool,
    tenant: str = "tenant-a",
    assembly: str = "summarize.partial@3",
    capability_set: str = "readonly-text",
    harm: tuple[str, ...] = (),
    injection: str = "PASS",
    inspected: int | None = None,
    clinical: tuple[ClinicalSignal, ...] = (),
) -> TranscriptSegmentVerdict:
    return TranscriptSegmentVerdict(
        segment_id="seg",
        scope=_scope(text, tenant),
        content_harm=ContentHarm(categories=harm, confidence=0.0, classifier_version="clf-1"),
        injection_risk=InjectionRisk(
            decision=injection,
            assembly_template_id=assembly,
            capability_set_id=capability_set,
            confidence=0.0,
        ),
        clinical=clinical,
        window=WindowAssertion(
            inspected_chars=len(text) if inspected is None else inspected,
            consumer_window_chars=len(text) if complete else 0,
            complete=complete,
        ),
    )


def _request(**over: object) -> ConsumptionRequest:
    base: dict[str, object] = {
        "tenant_id": "tenant-a",
        "cumulative_content_hash": content_hash(CUMULATIVE),
        "consumer_window_chars": len(CUMULATIVE),
        "assembly_template_id": "summarize.partial@3",
        "capability_set_id": "readonly-text",
        "declared_capabilities": ("text.read",),
        "source_artifact_count": 1,
    }
    base.update(over)
    return ConsumptionRequest(**base)  # type: ignore[arg-type]


# ===========================================================================
# C-2 — the cumulative unit. THIS IS THE DO-NOT-SHIP CONDITION.
# ===========================================================================


def test_clean_segment_verdicts_never_compose_into_a_cumulative_pass() -> None:
    """THE per-delta regression test.

    Every delta is validated. Every delta is clean. Together they are exactly the
    cumulative text, with nothing missing. The gate must STILL refuse, because
    "each part is clean" is not evidence about the whole — it is the Prompt
    Overflow vulnerability restated as an optimisation.
    """
    segment_verdicts = [_verdict(d, complete=False) for d in DELTAS]
    assert "".join(DELTAS) == CUMULATIVE, "the deltas really do cover the whole window"
    assert all(not v.gates_derivations for v in segment_verdicts), "every delta is clean"

    decision = _gate().evaluate(_request(), held_verdict=None, segment_verdicts=segment_verdicts)

    assert decision.allowed is False
    assert decision.action == ACTION_REVALIDATE_CUMULATIVE
    assert "no_cumulative_verdict" in decision.reasons


def test_the_gate_exposes_no_way_to_combine_deltas_into_a_verdict() -> None:
    """Structural: the shortcut must not exist to be reached for."""
    import guardrail.realtime.consumption as module

    banned = [
        name
        for name in dir(module)
        if any(word in name.lower() for word in ("compose", "merge", "combine", "fold"))
    ]
    assert banned == []


def test_a_verdict_computed_over_the_last_delta_does_not_authorise_the_cumulative() -> None:
    """The subtler shape: a real cumulative-looking verdict, over the wrong text."""
    decision = _gate().evaluate(
        _request(), held_verdict=_verdict(DELTAS[-1], complete=True), segment_verdicts=[]
    )
    assert decision.allowed is False
    assert decision.action == ACTION_REVALIDATE_CUMULATIVE
    assert "content_hash_mismatch" in decision.reasons


def test_an_incomplete_window_forces_a_cumulative_recheck() -> None:
    decision = _gate().evaluate(
        _request(), held_verdict=_verdict(CUMULATIVE, complete=False), segment_verdicts=[]
    )
    assert decision.action == ACTION_REVALIDATE_CUMULATIVE
    assert "window_incomplete" in decision.reasons


def test_inspecting_less_than_the_model_will_read_is_refused() -> None:
    """Prompt Overflow in one line: the guard scored less than the model infers."""
    decision = _gate().evaluate(
        _request(),
        held_verdict=_verdict(CUMULATIVE, complete=True, inspected=len(CUMULATIVE) - 1),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert "inspection_narrower_than_model_window" in decision.reasons


def test_concatenating_two_validated_artifacts_creates_an_unvalidated_composite() -> None:
    """A validated transcript plus a validated document is a THIRD, unvalidated thing."""
    decision = _gate().evaluate(
        _request(source_artifact_count=2),
        held_verdict=_verdict(CUMULATIVE, complete=True),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert decision.action == ACTION_REVALIDATE_CUMULATIVE
    assert "unvalidated_composite" in decision.reasons


def test_a_matching_cumulative_verdict_allows_the_read() -> None:
    """The gate is not merely a wall — the correct shape must pass."""
    decision = _gate().evaluate(
        _request(), held_verdict=_verdict(CUMULATIVE, complete=True), segment_verdicts=[]
    )
    assert decision.allowed is True
    assert decision.action == ACTION_ALLOW
    assert decision.reasons == ()


# ===========================================================================
# C-3 — no consumer holds a capability the policy did not model
# ===========================================================================


def test_a_verdict_is_not_inherited_across_a_capability_set_change() -> None:
    """Read-only today, chart-writing tomorrow: recompute, never inherit."""
    decision = _gate().evaluate(
        _request(
            capability_set_id="chart-write", declared_capabilities=("text.read", "chart.write")
        ),
        held_verdict=_verdict(CUMULATIVE, complete=True, capability_set="readonly-text"),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert decision.action == ACTION_RECOMPUTE_INJECTION
    assert "capability_set_changed" in decision.reasons


def test_a_verdict_is_not_inherited_across_an_assembly_change() -> None:
    """Position materially changes attack success; a new assembly is a new question."""
    decision = _gate().evaluate(
        _request(assembly_template_id="grammar.partial@1"),
        held_verdict=_verdict(CUMULATIVE, complete=True, assembly="summarize.partial@3"),
        segment_verdicts=[],
    )
    assert decision.action == ACTION_RECOMPUTE_INJECTION
    assert "assembly_changed" in decision.reasons


def test_a_capability_the_policy_never_modelled_is_refused() -> None:
    """Silent privilege escalation: the consumer can do more than was validated."""
    decision = _gate().evaluate(
        _request(declared_capabilities=("text.read", "tool.invoke")),
        held_verdict=_verdict(CUMULATIVE, complete=True),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert decision.action == ACTION_RECOMPUTE_INJECTION
    assert "unmodelled_capability:tool.invoke" in decision.reasons


def test_an_undeclared_capability_set_is_refused_rather_than_assumed_readonly() -> None:
    decision = _gate().evaluate(
        _request(capability_set_id="not-in-policy"),
        held_verdict=_verdict(CUMULATIVE, complete=True, capability_set="not-in-policy"),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert "undeclared_capability_set" in decision.reasons


def test_an_empty_capability_declaration_cannot_be_built() -> None:
    with pytest.raises(GuardrailUndeterminedError, match="capability"):
        CapabilityPolicy.from_declaration({})


# ===========================================================================
# Tenancy, gating and C-5
# ===========================================================================


def test_another_tenants_verdict_can_never_authorise_this_tenants_read() -> None:
    decision = _gate().evaluate(
        _request(tenant_id="tenant-a"),
        held_verdict=_verdict(CUMULATIVE, complete=True, tenant="tenant-b"),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert "tenant_mismatch" in decision.reasons


def test_a_gating_verdict_blocks_the_derivation() -> None:
    decision = _gate().evaluate(
        _request(),
        held_verdict=_verdict(CUMULATIVE, complete=True, harm=("weapons",)),
        segment_verdicts=[],
    )
    assert decision.allowed is False
    assert decision.action == ACTION_BLOCK


def test_a_clinical_signal_never_gates_any_task_under_any_configuration() -> None:
    """C-1 axis 3, asserted where it would actually do damage: at the gate."""
    signals = (ClinicalSignal(category="self_harm", confidence=1.0, span=(0, 12)),)
    for capability_set in ("readonly-text", "chart-write", "retrieval"):
        decision = _gate().evaluate(
            _request(
                capability_set_id=capability_set,
                declared_capabilities=tuple(CAPABILITIES.for_set(capability_set)),
            ),
            held_verdict=_verdict(
                CUMULATIVE, complete=True, capability_set=capability_set, clinical=signals
            ),
            segment_verdicts=[],
        )
        assert decision.allowed is True, capability_set
        assert decision.clinical_signal_count == 1


def test_every_decision_retains_the_transcript_whatever_it_decides() -> None:
    """C-5. There is no branch in which a guardrail asks for text to be removed."""
    cases = [
        _gate().evaluate(_request(), held_verdict=None, segment_verdicts=[]),
        _gate().evaluate(
            _request(), held_verdict=_verdict(CUMULATIVE, complete=True), segment_verdicts=[]
        ),
        _gate().evaluate(
            _request(),
            held_verdict=_verdict(CUMULATIVE, complete=True, harm=("weapons",), injection="BLOCK"),
            segment_verdicts=[],
        ),
        ConsumptionGate.unavailable("engine_error"),
    ]
    for decision in cases:
        assert decision.transcript_disposition == RETAIN_VERBATIM
        payload = decision.to_dict()
        assert payload["transcriptDisposition"] == RETAIN_VERBATIM
        assert "text" not in repr(payload).lower().replace("contexttext", "")


def test_guardrail_unavailability_pauses_derivations_and_nothing_else() -> None:
    """Fail-closed applies to downstream USE, never to capture or display (C-5)."""
    decision = ConsumptionGate.unavailable("timeout")
    assert decision.allowed is False
    assert decision.action == ACTION_BLOCK
    assert decision.transcript_disposition == RETAIN_VERBATIM
    assert decision.notice == "ai_derivations_paused"


def test_notice_codes_carry_no_moderation_vocabulary() -> None:
    """Alert copy is the console's; the codes it keys off must not prejudge it."""
    from guardrail.realtime import consumption as module

    forbidden = ("attack", "malicious", "abuse", "threat", "violation")
    for code in module.NOTICE_CODES:
        assert not any(word in code.lower() for word in forbidden), code
