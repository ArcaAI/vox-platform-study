"""Gating-consolidation + claim-level caching acceptance contract.

Covers the gating-consolidation workstreams:

* Content-addressed per-claim verdict cache + regen scoping.
* Extends the SAME verdict cache to citation_verify so a
  dually-checked CITED claim is reused across passes — **NO prompt merge** (merging the
  two premises would leak the transcript into the citation premise and loosen the
  citation verdict); the two verdicts stay SEPARABLE.
* Cross-stack cohering — governance/config only; never remove a
  fail-closed harness check.

Safety-screen scoping is a separate concern; its S1/S2/S3
tests live in ``tests/unit/sensors/test_safety_scoping.py``.

Each test imports the target API via a helper that raises an explicit ``pytest.fail``
naming the missing API if it is absent, so the module always COLLECTS cleanly even
against a partial implementation (no incidental import/collection error). T1, T7, T9
are regression/parity/invariant guards on aggregator fail-closed and safety behaviour
that the caching work must preserve byte-for-byte.

NOTE: the replay-safety anchor (T8) lives in
``tests/unit/temporal/test_gating_consolidation_replay.py`` (it needs the temporal
replay fixtures).
"""

from __future__ import annotations

import importlib
import inspect

import pytest

from harness.sensors.aggregator import GateDecision, aggregate
from harness.sensors.base import SensorContext, SensorResult
from harness.sensors.computational import (
    citation_presence,
    coverage_omission,
    entity_faithfulness,
    numeric_dose,
    schema_validity,
)
from harness.sensors.inferential.citation_verify import NAME as CITATION_VERIFY_NAME
from harness.sensors.inferential.citation_verify import CitationVerifySensor
from harness.sensors.inferential.groundedness import NAME as GROUNDEDNESS_NAME
from harness.sensors.inferential.groundedness import GroundednessSensor
from harness.sensors.inferential.safety import NAME as SAFETY_NAME
from harness.sensors.inferential.safety import SafetySensor
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES

from ._fixtures import claim, evidence

# ---------------------------------------------------------------------------
# Deterministic stub backends (mirror the existing inferential-sensor tests).
# ---------------------------------------------------------------------------


class _CountingJudge:
    """Stub :class:`JudgeClient` that COUNTS calls (no network).

    Returns ``supported`` unless the hypothesis contains an ``unsupported`` marker;
    an ``unparseable`` marker returns non-JSON so the sensor's conservative parser
    must treat it as ungrounded. ``calls`` is the call ledger used to assert that a
    cache HIT skipped the judge (WS-1) or a consolidation issued fewer calls (WS-2).
    """

    model = "stub-judge-v1"

    def __init__(
        self,
        *,
        unsupported: tuple[str, ...] = (),
        unparseable: tuple[str, ...] = (),
    ) -> None:
        self.calls: list[list[dict[str, str]]] = []
        self._unsupported = unsupported
        self._unparseable = unparseable

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        content = messages[-1]["content"].lower()
        if any(marker in content for marker in self._unparseable):
            return "I cannot answer that."  # no JSON -> conservative ungrounded
        if any(marker in content for marker in self._unsupported):
            return '{"supported": false}'
        return '{"supported": true}'


class _StubGranite:
    """Stand-in Granite client: canned per-dimension verdicts (or raises)."""

    model = "granite-stub"

    def __init__(
        self, *, dimensions: dict[str, bool] | None = None, error: Exception | None = None
    ) -> None:
        self._dimensions = dimensions or {}
        self._error = error
        self.screened: list[str] = []

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        if self._error is not None:
            raise self._error
        return dict(self._dimensions)


class _NoopJudge:
    model = "noop"

    async def complete(self, *args: object, **kwargs: object) -> str:  # pragma: no cover
        raise AssertionError("safety sensor must not call the judge")


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------


def _pass(name: str, score: float = 1.0) -> SensorResult:
    return SensorResult(name=name, score=score, passed=True)


def _all_computational_pass() -> list[SensorResult]:
    """The five computational sensors all passing (mirrors test_aggregator)."""
    return [
        _pass(entity_faithfulness.NAME),
        _pass(coverage_omission.NAME),
        _pass(schema_validity.NAME),
        _pass(citation_presence.NAME),
        _pass(numeric_dose.NAME),
    ]


def _ctx(
    claims: list[dict],
    *,
    transcript: str = "Patient has hypertension; BP 150/95.",
    chunks: dict[str, str] | None = None,
) -> SensorContext:
    return SensorContext(
        note_text="generated note",
        transcript_text=transcript,
        citations_map={"claims": claims},
        knowledge_chunks=chunks or {},
    )


def _require(modpath: str, attr: str | None = None, *, ws: str):
    """Import (or ``pytest.fail`` with a clear RED reason) a not-yet-built API.

    Keeps RED tests a deliberate ``Failed`` (not an import/collection ``Error``).
    """
    try:
        module = importlib.import_module(modpath)
    except ModuleNotFoundError as exc:
        pytest.fail(f"{ws}: `{modpath}` not implemented yet (TDD RED): {exc}")
    if attr is not None and not hasattr(module, attr):
        pytest.fail(f"{ws}: `{modpath}.{attr}` not implemented yet (TDD RED)")
    return getattr(module, attr) if attr is not None else module


def _has_kwarg(func, name: str) -> bool:
    return name in inspect.signature(func).parameters


# ===========================================================================
# T1 — verdict-parity ANCHOR.
# ===========================================================================


class TestT1VerdictParityAnchor:
    """Pin the CURRENT inferential verdicts on a fixture note.

    This is the parity contract the caching/consolidation/scoping work must reproduce
    byte-for-byte: a cached/consolidated/scoped path that shifts ANY value below is
    rejected (an efficiency change that moves a verdict is a clinical-safety
    regression). The cached-path == current-path equality is additionally enforced
    by T2 (pass-2 verdicts) and T5 (consolidated verdicts).
    """

    @pytest.mark.asyncio
    async def test_current_inferential_aggregate_is_pinned(self):
        claims = [
            claim(
                "claim-1",
                text="hypertension",
                section="A",
                evidence=[evidence(quote="hypertension")],
            ),
            claim(
                "claim-2",
                text="BP 150/95",
                section="O",
                evidence=[evidence(quote="BP 150/95")],
            ),
            claim("claim-3", text="penicillin allergy", section="P"),  # ungrounded
        ]
        ctx = _ctx(claims)
        judge = _CountingJudge(unsupported=("penicillin",))

        grounded = await GroundednessSensor(threshold=0.8).arun(ctx, judge=judge)
        cited = await CitationVerifySensor(threshold=0.8).arun(ctx, judge=judge)
        safety = await SafetySensor(
            _StubGranite(dimensions={"harm": False, "violence": False})
        ).arun(ctx, judge=_NoopJudge())

        # Pinned per-sensor verdicts (the parity contract).
        assert (grounded.passed, round(grounded.score, 6)) == (False, round(2 / 3, 6))
        assert grounded.claims_flagged == ["claim-3"]
        assert grounded.details["sections"] == ["P"]
        assert (cited.passed, cited.score) == (True, 1.0)  # vacuous: no cited claims
        assert (safety.passed, safety.score) == (True, 1.0)

        verdict = aggregate(
            [*_all_computational_pass(), grounded, cited, safety],
            regens_remaining=2,
            expected=[
                *COMPUTATIONAL_SENSOR_NAMES,
                GROUNDEDNESS_NAME,
                CITATION_VERIFY_NAME,
                SAFETY_NAME,
            ],
        )
        # groundedness 0.667 < 0.8 -> regen-fixable; budget remains -> REGEN section P.
        assert verdict.decision is GateDecision.REGEN
        assert verdict.sections_to_regen == ["P"]
        assert verdict.claims_flagged == ["claim-3"]
        # Call-count baseline: 3 groundedness calls (one per claim), 0 citation-verify.
        assert len(judge.calls) == 3


# ===========================================================================
# T2 — regen scoping: unchanged claims reuse the cache.
# ===========================================================================


class TestT2RegenScopingReusesCache:
    """A regen re-judges ONLY changed claims; unchanged claims reuse the cached
    verdict. Requires WS-1's content-addressed cache threaded into
    ``GroundednessSensor.arun(..., verdict_cache=...)`` (a ``dict[str, bool]``
    mutated in place so the workflow can thread it across passes)."""

    @pytest.mark.asyncio
    async def test_unchanged_claims_reuse_cache_changed_claim_rejudged(self):
        if not _has_kwarg(GroundednessSensor.arun, "verdict_cache"):
            pytest.fail(
                "WS-1: GroundednessSensor.arun(..., verdict_cache=dict) not implemented "
                "yet (TDD RED) — no per-claim verdict cache to scope a regen"
            )

        claims = [
            claim(
                "claim-1",
                text="hypertension",
                section="A",
                evidence=[evidence(quote="hypertension")],
            ),
            claim(
                "claim-2",
                text="BP 150/95",
                section="O",
                evidence=[evidence(quote="BP 150/95")],
            ),
        ]
        cache: dict[str, bool] = {}

        # Pass 1: empty cache -> one judge call per claim, cache populated.
        j1 = _CountingJudge()
        r1 = await GroundednessSensor(threshold=0.8).arun(
            _ctx(claims), judge=j1, verdict_cache=cache
        )
        assert len(j1.calls) == 2
        assert cache, "the cache must be populated after the first pass"

        # Pass 2: identical claims -> ALL cache hits -> ZERO new judge calls, identical verdict.
        j2 = _CountingJudge()
        r2 = await GroundednessSensor(threshold=0.8).arun(
            _ctx(claims), judge=j2, verdict_cache=cache
        )
        assert len(j2.calls) == 0, "unchanged claims must reuse cached verdicts (AC-1)"
        assert (r2.passed, r2.score, r2.claims_flagged) == (r1.passed, r1.score, r1.claims_flagged)

        # Pass 3: ONE claim's text changed -> exactly ONE re-judge (only the changed claim).
        changed = [
            claims[0],
            claim(
                "claim-2",
                text="BP 120/80 now normal",
                section="O",
                evidence=[evidence(quote="BP 120/80")],
            ),
        ]
        j3 = _CountingJudge()
        await GroundednessSensor(threshold=0.8).arun(_ctx(changed), judge=j3, verdict_cache=cache)
        assert len(j3.calls) == 1, "only the content-changed claim is re-judged (AC-3)"


# ===========================================================================
# T3 — the cache key is content-addressed, never the claim id.
# ===========================================================================


class TestT3CacheKeyContentAddressedAndModelInvalidated:
    """The cache key = hash(post-clean claim text + premise inputs + judge/model
    identity), NEVER the positional claim id (``provenance.py`` ``claim-{n}`` is unstable
    across a regen, so an id-keyed cache could reuse a stale verdict for a changed claim).

    Because it is a pure content hash it is also (decision #5, broader cache):
      * **portable/persistent** — a stable hex digest, so the SAME content rebuilt in
        another run/process hits the same entry (cross-run reuse), and
      * **self-invalidating** — a judge/model (or prompt) identity change yields a
        DIFFERENT key, so a model swap can never serve a stale verdict (parity-across-runs).
    """

    def test_key_is_content_addressed_id_independent_and_model_invalidated(self):
        claim_verdict_key = _require(
            "harness.sensors.inferential.verdict_cache", "claim_verdict_key", ws="WS-1"
        )
        base = {
            "claim_text": "hypertension",
            "premise": "Patient has hypertension; BP elevated.",
            "judge_identity": "lm-studio/judge-v1",
        }
        key = claim_verdict_key(**base)
        assert isinstance(key, str) and key, "key must be a non-empty string"
        # A portable, persistent hex digest (a content hash, never the positional id).
        assert all(ch in "0123456789abcdef" for ch in key), "key must be a hex digest"
        # Deterministic -> the SAME content rebuilt in another run hits the same entry.
        assert claim_verdict_key(**base) == key, "key must be deterministic (cross-run reuse)"
        # Any input component change MUST miss (content-addressed + model invalidation).
        assert claim_verdict_key(**{**base, "claim_text": "diabetes"}) != key
        assert claim_verdict_key(**{**base, "premise": "a different premise"}) != key
        assert claim_verdict_key(**{**base, "judge_identity": "lm-studio/judge-v2"}) != key


# ===========================================================================
# T4 — cache miss is conservative (re-judge, never assume grounded).
# ===========================================================================


class TestT4CacheMissIsConservative:
    """A cache MISS re-judges (it never assumes grounded); an unparseable verdict
    stays conservative-ungrounded. Together these keep the conservative-failure
    direction when caching is added."""

    @pytest.mark.asyncio
    async def test_miss_rejudges_and_unparseable_is_ungrounded(self):
        if not _has_kwarg(GroundednessSensor.arun, "verdict_cache"):
            pytest.fail(
                "WS-1: GroundednessSensor.arun(..., verdict_cache=dict) not implemented "
                "yet (TDD RED) — cannot prove cache-miss is conservative"
            )

        claims = [claim("claim-1", text="penicillin allergy", section="P")]
        cache: dict[str, bool] = {}  # empty -> guaranteed miss
        judge = _CountingJudge(unparseable=("penicillin",))

        result = await GroundednessSensor(threshold=0.8).arun(
            _ctx(claims), judge=judge, verdict_cache=cache
        )
        # Miss -> the judge WAS called (never silently assumed grounded).
        assert len(judge.calls) == 1
        # Unparseable judge verdict -> conservative ungrounded -> flagged + fails.
        assert result.claims_flagged == ["claim-1"]
        assert result.passed is False


# ===========================================================================
# T5 — WS-2 LOCKED: the verdict cache covers citation_verify too,
# reusing a dually-checked cited claim ACROSS passes, with NO prompt merge.
# ===========================================================================


class TestT5CitationVerifyCacheSeparableNoMerge:
    """WS-2 (locked design): the content-addressed cache covers citation_verify TOO, so
    a dually-checked cited claim is judged once PER PREMISE and reused across passes —
    WITHOUT merging the two premises into one prompt.

    A merge is REJECTED (red-team): groundedness entails vs the transcript(+evidence),
    citation_verify entails vs the cited chunk ONLY; one merged prompt would let the
    transcript leak into the citation premise and could loosen a borderline citation
    verdict — a violation of the separability invariant. So the two verdicts
    stay SEPARABLE and byte-identical to the unconsolidated baseline; the ONLY saving is
    cross-pass cache reuse (a cited claim is still TWO different questions in one pass).
    """

    @pytest.mark.asyncio
    async def test_shared_cache_reuses_across_passes_keeps_verdicts_separable(self):
        if not _has_kwarg(CitationVerifySensor.arun, "verdict_cache"):
            pytest.fail(
                "WS-2: CitationVerifySensor.arun(..., verdict_cache=dict) not implemented "
                "yet (TDD RED) — the verdict cache must cover citation_verify (no prompt merge)"
            )

        claims = [
            claim(
                "claim-1",
                text="thiazide is first-line",
                section="P",
                evidence=[evidence(quote="thiazide is first-line")],
                knowledge_chunk_ids=["kc-1"],
            )
        ]
        # The cited chunk CONTRADICTS the claim while the transcript SUPPORTS it, so the
        # two premises MUST yield different verdicts (separability proves no merge/leak).
        chunks = {"kc-1": "This statement is contradicted by the institutional guideline."}
        ctx = _ctx(
            claims, transcript="Plan: thiazide is first-line for this patient.", chunks=chunks
        )

        # Baseline (no cache): grounded PASS (transcript), citation FAIL (cited chunk).
        jb = _CountingJudge(unsupported=("contradicted",))
        g0 = await GroundednessSensor(threshold=0.8).arun(ctx, judge=jb)
        c0 = await CitationVerifySensor(threshold=0.8).arun(ctx, judge=jb)
        assert (g0.passed, c0.passed) == (True, False), "premises must stay separable"
        assert c0.claims_flagged == ["claim-1"]

        # Shared cache, pass 1: two DIFFERENT questions -> two judge calls (not a merge).
        cache: dict[str, bool] = {}
        j1 = _CountingJudge(unsupported=("contradicted",))
        await GroundednessSensor(threshold=0.8).arun(ctx, judge=j1, verdict_cache=cache)
        await CitationVerifySensor(threshold=0.8).arun(ctx, judge=j1, verdict_cache=cache)
        assert len(j1.calls) == 2, "a cited claim is two distinct premises -> two calls, no merge"

        # Shared cache, pass 2: identical content -> ZERO new calls, identical verdicts.
        j2 = _CountingJudge(unsupported=("contradicted",))
        g2 = await GroundednessSensor(threshold=0.8).arun(ctx, judge=j2, verdict_cache=cache)
        c2 = await CitationVerifySensor(threshold=0.8).arun(ctx, judge=j2, verdict_cache=cache)
        assert (
            len(j2.calls) == 0
        ), "unchanged dually-checked claim reuses cache for BOTH sensors (AC-1)"
        assert (g2.passed, g2.score, g2.claims_flagged) == (g0.passed, g0.score, g0.claims_flagged)
        assert (c2.passed, c2.score, c2.claims_flagged) == (c0.passed, c0.score, c0.claims_flagged)


# T6 (safety-screen scoping contract) lives separately —
# see ``tests/unit/sensors/test_safety_scoping.py``.


# ===========================================================================
# T7 — safety FLAG is never auto-regenerated; degraded -> FLAG.
# ===========================================================================


class TestT7SafetyFlagInvariants:
    """Unsafe safety -> FLAG and is NEVER auto-regenerated (``sections_to_regen``
    stays empty even when a co-failing regen-fixable sensor named sections); a degraded
    inferential sensor -> FLAG (never an auto-PASS). WS-1..WS-4 must keep these."""

    def test_unsafe_safety_flags_and_never_regenerates(self):
        safety = SensorResult(
            name=SAFETY_NAME,
            score=0.0,
            passed=False,
            claims_flagged=["violence"],
            details={"unsafe": True, "flagged_dimensions": ["violence"]},
        )
        grounded_regen = SensorResult(
            name=GROUNDEDNESS_NAME,
            score=0.5,
            passed=False,
            claims_flagged=["c-x"],
            details={"sections": ["P"]},
        )
        verdict = aggregate(
            [*_all_computational_pass(), grounded_regen, safety], regens_remaining=2
        )
        assert verdict.decision is GateDecision.FLAG
        assert verdict.sections_to_regen == []  # unsafe content is never auto-regenerated

    def test_degraded_inferential_never_auto_passes(self):
        degraded_safety = SensorResult(
            name=SAFETY_NAME,
            score=0.0,
            passed=False,
            details={"degraded": True, "reason": "granite offline"},
        )
        verdict = aggregate(
            [*_all_computational_pass(), degraded_safety],
            regens_remaining=2,
            expected=[*COMPUTATIONAL_SENSOR_NAMES, SAFETY_NAME],
        )
        assert verdict.decision is GateDecision.FLAG


# ===========================================================================
# T9 — the harness gate fails CLOSED and cannot be replaced by a
# fail-open SMR/guardrail layer.
# ===========================================================================


class TestT9HarnessGateFailsClosed:
    """The harness gate verdict is computed PURELY from the harness sensor results and
    fails CLOSED (degraded / missing-expected -> FLAG). It has NO input by which a
    fail-OPEN SMR pre-gen gate or guardrail-service verdict (which return safe-on-error)
    could substitute for a fail-closed harness check. WS-4 is governance/config only and
    must never remove this."""

    def test_aggregate_has_no_external_fail_open_input(self):
        params = set(inspect.signature(aggregate).parameters)
        assert params == {"results", "regens_remaining", "degraded", "expected"}

    def test_degraded_and_missing_inputs_fail_closed_to_flag(self):
        # A degraded run -> FLAG (never auto-PASS).
        assert aggregate(_all_computational_pass(), degraded=True).decision is GateDecision.FLAG
        # A missing expected sensor (NLP/SMR down) -> FLAG.
        partial = _all_computational_pass()[:-1]  # drop numeric_dose
        assert aggregate(partial, expected=COMPUTATIONAL_SENSOR_NAMES).decision is GateDecision.FLAG
