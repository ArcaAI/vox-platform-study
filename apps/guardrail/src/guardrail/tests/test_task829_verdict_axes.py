"""TASK-829 C-1 — three verdict axes, two cache scopes; and C-5's structural half.

C-1 says a single verdict is unsound. The three axes differ in what they are a
property OF, and therefore in how far they may travel:

* **contentHarm** is a property of the TEXT. Task-agnostic, cacheable, fans out.
* **injectionRisk** is a property of (text x prompt assembly x downstream
  capability). Position materially changes attack success, so a verdict computed
  against one assembly does not transfer to another — it is cached under a
  STRICTLY LONGER key, and a differing scope is a cache MISS, not a hit.
* **clinical** is a signal for a human. It never gates anything, ever.

C-5's structural half lives here too: the verdict artifact is the only thing that
crosses the wire, and it carries no text and no instruction to remove text. A
guardrail that cannot express "delete this" cannot blank a transcript.
"""

from __future__ import annotations

import pytest

from guardrail.realtime.verdict import (
    RETAIN_VERBATIM,
    ClinicalSignal,
    ContentHarm,
    InjectionRisk,
    TranscriptSegmentVerdict,
    VerdictScope,
    WindowAssertion,
    content_harm_cache_key,
    injection_risk_cache_key,
)


def _scope(**over: object) -> VerdictScope:
    base = dict(
        content_hash="sha256:abc",
        policy_version=7,
        classifier_version="clf-1",
        taxonomy_version="clinical-v3",
        threshold_set="default",
        tenant_id="tenant-a",
    )
    base.update(over)
    return VerdictScope(**base)  # type: ignore[arg-type]


# --- C-1 axis 1: content harm is task-agnostic and cacheable ----------------


def test_content_harm_key_is_stable_across_assembly_and_capability() -> None:
    """Axis 1 fans out: the assembly it was computed under is not part of its key."""
    scope = _scope()
    assert content_harm_cache_key(scope) == content_harm_cache_key(scope)


def test_content_harm_key_changes_when_any_declared_component_changes() -> None:
    base = content_harm_cache_key(_scope())
    for field, value in (
        ("content_hash", "sha256:def"),
        ("policy_version", 8),
        ("classifier_version", "clf-2"),
        ("taxonomy_version", "clinical-v4"),
        ("threshold_set", "strict"),
        ("tenant_id", "tenant-b"),
    ):
        assert content_harm_cache_key(_scope(**{field: value})) != base, field


def test_cache_key_is_tenant_scoped_so_a_cross_tenant_hit_is_impossible() -> None:
    """Omit tenantId and you serve one tenant's policy verdict to another."""
    assert content_harm_cache_key(_scope(tenant_id="tenant-a")) != content_harm_cache_key(
        _scope(tenant_id="tenant-b")
    )
    assert injection_risk_cache_key(
        _scope(tenant_id="tenant-a"), assembly_template_id="s@3", capability_set_id="ro"
    ) != injection_risk_cache_key(
        _scope(tenant_id="tenant-b"), assembly_template_id="s@3", capability_set_id="ro"
    )


def test_a_verdict_scope_without_a_tenant_cannot_be_constructed() -> None:
    """A verdict that cannot be attributed must not be renderable at all."""
    with pytest.raises(ValueError, match="tenant"):
        _scope(tenant_id="  ")


# --- C-1 axis 2: injection risk is NOT task-agnostic ------------------------


def test_injection_key_is_a_strict_superset_of_the_content_harm_key() -> None:
    scope = _scope()
    assert injection_risk_cache_key(
        scope, assembly_template_id="summarize.partial@3", capability_set_id="readonly-text"
    ) != content_harm_cache_key(scope)


def test_injection_key_differs_per_assembly_and_per_capability_set() -> None:
    """Differing assembly or capability set is a cache MISS — never a reuse."""
    scope = _scope()
    base = injection_risk_cache_key(
        scope, assembly_template_id="summarize.partial@3", capability_set_id="readonly-text"
    )
    assert (
        injection_risk_cache_key(
            scope, assembly_template_id="grammar.partial@1", capability_set_id="readonly-text"
        )
        != base
    )
    assert (
        injection_risk_cache_key(
            scope, assembly_template_id="summarize.partial@3", capability_set_id="chart-write"
        )
        != base
    )


# --- C-1 axis 3: the clinical axis NEVER gates ------------------------------


def _verdict(**over: object) -> TranscriptSegmentVerdict:
    base: dict[str, object] = dict(
        segment_id="0198-seg",
        scope=_scope(),
        content_harm=ContentHarm(categories=(), confidence=0.0, classifier_version="clf-1"),
        injection_risk=InjectionRisk(
            decision="PASS",
            assembly_template_id="summarize.partial@3",
            capability_set_id="readonly-text",
            confidence=0.0,
        ),
        clinical=(),
        window=WindowAssertion(inspected_chars=10, consumer_window_chars=0, complete=False),
    )
    base.update(over)
    return TranscriptSegmentVerdict(**base)  # type: ignore[arg-type]


def test_a_maximal_clinical_signal_never_gates_a_derivation() -> None:
    """Self-harm disclosure routes to clinical escalation, never to a block."""
    verdict = _verdict(
        clinical=(
            ClinicalSignal(category="self_harm", confidence=1.0, span=(12, 48)),
            ClinicalSignal(category="harm_to_others", confidence=1.0, span=(60, 90)),
        )
    )
    assert verdict.gates_derivations is False
    assert verdict.gating_reasons == ()


def test_content_harm_and_injection_block_do_gate() -> None:
    assert _verdict(
        content_harm=ContentHarm(
            categories=("weapons",), confidence=0.9, classifier_version="clf-1"
        )
    ).gates_derivations is True
    assert _verdict(
        injection_risk=InjectionRisk(
            decision="BLOCK",
            assembly_template_id="summarize.partial@3",
            capability_set_id="readonly-text",
            confidence=0.9,
        )
    ).gates_derivations is True


def test_clinical_signals_do_not_change_the_gate_when_added_to_a_blocking_verdict() -> None:
    """Axis 3 is inert in BOTH directions — it cannot gate and cannot un-gate."""
    harmful = _verdict(
        content_harm=ContentHarm(categories=("weapons",), confidence=0.9, classifier_version="c")
    )
    with_clinical = _verdict(
        content_harm=ContentHarm(categories=("weapons",), confidence=0.9, classifier_version="c"),
        clinical=(ClinicalSignal(category="self_harm", confidence=1.0, span=(0, 5)),),
    )
    assert harmful.gating_reasons == with_clinical.gating_reasons


# --- C-5, structural: the artifact cannot express "remove this text" --------


def test_the_verdict_carries_no_transcript_text() -> None:
    """PHI posture AND C-5: an artifact with no text cannot be used to replace one."""
    payload = _verdict(
        clinical=(ClinicalSignal(category="self_harm", confidence=0.8, span=(12, 48)),)
    ).to_dict()
    flat = repr(payload)
    assert "text" not in payload
    assert "content" not in payload
    assert "redact" not in flat and "removed" not in flat


def test_transcript_disposition_has_exactly_one_possible_value() -> None:
    """There is no second value to select. Retention is not a branch."""
    verdict = _verdict(
        content_harm=ContentHarm(categories=("weapons",), confidence=1.0, classifier_version="c")
    )
    assert verdict.transcript_disposition == RETAIN_VERBATIM
    assert verdict.to_dict()["transcriptDisposition"] == RETAIN_VERBATIM
    from guardrail.realtime import verdict as module

    assert module.TRANSCRIPT_DISPOSITIONS == (RETAIN_VERBATIM,)


def test_a_segment_verdict_is_never_a_complete_consumption_window() -> None:
    """C-2's structural floor: a segment verdict cannot authorise a consumption."""
    assert _verdict().window.complete is False
    assert _verdict().window.consumer_window_chars == 0
