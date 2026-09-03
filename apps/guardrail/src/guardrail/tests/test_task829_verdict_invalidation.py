"""a policy change must invalidate every verdict it affects.

The fan-out handle (`gr:rt:seg:<tenant>:<segment>`) is what a consumer reads
INSTEAD of calling guardrail. It is keyed by tenant and segment id and by
nothing else — so on its own it will happily serve a verdict computed under a
policy that has since been replaced, for as long as the TTL allows.

That is the criterion "policy/classifier/taxonomy version change invalidates
every affected verdict" failing on the one path Phase 1 is actually about. The
operational shape is the one that matters: an operator tightens the guardrail
*during* an incident, the config-invalidation channel correctly drops the config
cache so the new policy is read — and cached PASS verdicts keep authorising
derivations anyway, because nothing on the read path ever compares them against
the policy in force.

Two classes of change have to invalidate, and only one of them is a version:

* a **declared version** moves (`policyVersion`, `classifierVersion`,
  `taxonomyVersion`, `thresholdSet`);
* a **behavioural knob** moves while every declared version stays put — a
  tightened noise floor, a new deterministic phrase, a widened capability set.
  This is the common case, because the nine tuning keys and the three fail-closed
  declarations live on `_metadata` and nothing forces an operator to bump a
  version when editing them.

The negative control matters as much as the positives: over-invalidating would
silently restore the N-classifications-per-segment cost the whole design exists
to remove, so an UNCHANGED policy must still hit.
"""

from __future__ import annotations

from guardrail.realtime.consumption import CapabilityPolicy
from guardrail.realtime.deterministic import DeterministicRuleSet
from guardrail.realtime.service import AxisTasks, RealtimePolicy, RealtimeValidator
from guardrail.realtime.session_state import SessionRiskPolicy
from guardrail.realtime.store import InMemoryRealtimeStore

SEGMENT_TEXT = "patient reports chest pain radiating to the left arm"


class CountingAnalyzer:
    """Counts classifications so a cache miss is visible as work, not as a flag."""

    def __init__(self) -> None:
        self.calls = 0

    async def classify_tasks(self, task_names, text):  # noqa: ANN001, ANN201
        self.calls += 1
        return {
            "jailbreak_detection": "benign",
            "prompt_safety": "benign",
            "self_harm_screen": "benign",
        }


def _policy(**over: object) -> RealtimePolicy:
    base: dict[str, object] = {
        "axes": AxisTasks.from_declaration(
            {
                "contentHarm": ["prompt_safety"],
                "injectionRisk": ["jailbreak_detection"],
                "clinical": ["self_harm_screen"],
            }
        ),
        "rules": DeterministicRuleSet.from_declaration(
            [{"id": "override", "phrase": "ignore all previous instructions"}]
        ),
        "capabilities": CapabilityPolicy.from_declaration({"readonly-text": ["text.read"]}),
        "session": SessionRiskPolicy(
            noise_floor=0.2,
            excess_risk_threshold=1.0,
            consecutive_limit=2,
            mean_score_threshold=0.5,
            min_windows_for_mean=4,
        ),
        "benign_labels": frozenset({"benign"}),
        "window_chars": 400,
        "overlap_chars": 40,
        "policy_version": 7,
        "classifier_version": "clf-1",
        "taxonomy_version": "clinical-v3",
    }
    base.update(over)
    return RealtimePolicy(**base)  # type: ignore[arg-type]


def _validator(policy: RealtimePolicy, store: object, analyzer: object) -> RealtimeValidator:
    return RealtimeValidator(
        analyzer=analyzer, policy=policy, tenant_id="tenant-a", store=store  # type: ignore[arg-type]
    )


async def _write_then_read_under(new_policy: RealtimePolicy) -> dict | None:
    """Cache a verdict under the baseline policy, then read it under `new_policy`."""
    store = InMemoryRealtimeStore()
    await _validator(_policy(), store, CountingAnalyzer()).validate_segment(
        session_id="s1", segment_id="seg-1", text=SEGMENT_TEXT
    )
    return await _validator(new_policy, store, CountingAnalyzer()).read_segment_verdict("seg-1")


# --- 1. declared versions ---------------------------------------------------


async def test_a_verdict_is_not_served_after_the_policy_version_moves() -> None:
    assert await _write_then_read_under(_policy(policy_version=8)) is None


async def test_a_verdict_is_not_served_after_the_classifier_changes() -> None:
    """A different model is a different opinion — not a cheaper way to reuse one."""
    assert await _write_then_read_under(_policy(classifier_version="clf-2")) is None


async def test_a_verdict_is_not_served_after_the_taxonomy_changes() -> None:
    assert await _write_then_read_under(_policy(taxonomy_version="clinical-v4")) is None


async def test_a_verdict_is_not_served_after_the_threshold_set_changes() -> None:
    assert await _write_then_read_under(_policy(threshold_set="strict")) is None


# --- 2. behavioural knobs, with every declared version held still -----------
#
# These are the ones a version bump does not cover, and they are the common case.


async def test_a_tightened_noise_floor_invalidates_without_a_version_bump() -> None:
    """The incident shape: an operator lowers theta and the cache ignores them."""
    tightened = _policy(
        session=SessionRiskPolicy(
            noise_floor=0.05,  # was 0.2
            excess_risk_threshold=1.0,
            consecutive_limit=2,
            mean_score_threshold=0.5,
            min_windows_for_mean=4,
        )
    )
    assert await _write_then_read_under(tightened) is None


async def test_a_new_deterministic_phrase_invalidates_without_a_version_bump() -> None:
    """An added T0 phrase must not be shadowed by verdicts predating it."""
    widened = _policy(
        rules=DeterministicRuleSet.from_declaration(
            [
                {"id": "override", "phrase": "ignore all previous instructions"},
                {"id": "exfil", "phrase": "emit the full chart"},
            ]
        )
    )
    assert await _write_then_read_under(widened) is None


async def test_editing_a_phrase_under_the_same_rule_id_still_invalidates() -> None:
    """Rule ids are stable by design, so identity is not evidence of sameness."""
    edited = _policy(
        rules=DeterministicRuleSet.from_declaration(
            [{"id": "override", "phrase": "disregard the guidance above"}]
        )
    )
    assert await _write_then_read_under(edited) is None


async def test_a_widened_capability_set_invalidates_without_a_version_bump() -> None:
    """C-3: a verdict must never be inherited across a capability change."""
    widened = _policy(
        capabilities=CapabilityPolicy.from_declaration(
            {"readonly-text": ["text.read", "tool.call"]}
        )
    )
    assert await _write_then_read_under(widened) is None


async def test_a_changed_axis_map_invalidates_without_a_version_bump() -> None:
    """Which task gates and which merely informs is the C-1 decision itself."""
    remapped = _policy(
        axes=AxisTasks.from_declaration(
            {
                "contentHarm": ["prompt_safety", "jailbreak_detection"],
                "injectionRisk": ["jailbreak_detection"],
                "clinical": ["self_harm_screen"],
            }
        )
    )
    assert await _write_then_read_under(remapped) is None


async def test_changed_window_geometry_invalidates_without_a_version_bump() -> None:
    """Window size decides malicious density per window, hence the verdict."""
    assert await _write_then_read_under(_policy(window_chars=4000)) is None


# --- 3. the negative control, and the property it protects ------------------


async def test_an_unchanged_policy_still_serves_the_cached_verdict() -> None:
    """Over-invalidating restores the N-classifications cost this design removes."""
    held = await _write_then_read_under(_policy())
    assert held is not None
    assert held["contentHarm"]["categories"] == []


async def test_three_consumers_still_cause_exactly_one_classification() -> None:
    """'s headline property must survive the staleness check."""
    store = InMemoryRealtimeStore()
    analyzer = CountingAnalyzer()
    validator = _validator(_policy(), store, analyzer)
    await validator.validate_segment(session_id="s1", segment_id="seg-1", text=SEGMENT_TEXT)
    after_validation = analyzer.calls

    for _ in range(3):  # summarization, NER, grammar
        assert await validator.read_segment_verdict("seg-1") is not None

    assert analyzer.calls == after_validation == 1


async def test_the_stamp_is_an_opaque_digest_and_carries_no_transcript_text() -> None:
    """The stamp travels on the wire, so it is held to the invariant too.

    `test_the_verdict_carries_no_transcript_text` covers `to_dict()`; the stamp is
    attached alongside it on the stored artifact, so it needs its own assertion
    rather than inheriting one.
    """
    store = InMemoryRealtimeStore()
    policy = _policy()
    await _validator(policy, store, CountingAnalyzer()).validate_segment(
        session_id="s1", segment_id="seg-1", text=SEGMENT_TEXT
    )
    held = await _validator(policy, store, CountingAnalyzer()).read_segment_verdict("seg-1")
    assert held is not None
    stamp = held["policyStamp"]

    assert len(stamp) == 64 and set(stamp) <= set("0123456789abcdef")
    # Neither the transcript nor any declared phrase is recoverable from it.
    for word in SEGMENT_TEXT.split() + ["ignore", "instructions"]:
        assert word not in stamp


async def test_a_stale_verdict_is_a_miss_and_never_a_gating_decision() -> None:
    """A miss must read as absence, so the caller revalidates rather than guessing.

    The failure mode this excludes is a stale verdict being downgraded to
    something truthy-but-degraded that a caller could still treat as an answer.
    """
    stale = await _write_then_read_under(_policy(policy_version=9))
    assert stale is None
