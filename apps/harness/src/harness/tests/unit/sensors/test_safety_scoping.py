"""TASK-363 — safety-screening scoping acceptance contract (split from TASK-359 WS-3).

WS-3 was carved out of TASK-359 into its own ticket so a parallel agent can own it.
This file holds the safety-screen contract:

* **S1 / S2 (GREEN)** regression guards moved from TASK-359's
  ``test_gating_consolidation.py`` — the per-criterion result dict shape/order and
  the fail-closed degrade that any scoping change MUST preserve byte-for-byte.
* **S3 (RED)** the not-yet-built scoping behaviour: a content-addressed
  per-(criterion, screened-text) cache threaded into
  ``SafetySensor.arun(..., screen_cache=...)`` so unchanged note content is not
  re-screened every regen pass (mirrors TASK-359 WS-1's ``verdict_cache``).

RED tests fail with an explicit ``pytest.fail`` naming the missing API, so the module
always COLLECTS cleanly. Stubs are self-contained (no import from TASK-359's test file)
so the two tickets' test files can be edited by parallel agents without collision.
"""

from __future__ import annotations

import inspect

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.inferential.granite_client import GraniteServiceError
from harness.sensors.inferential.safety import SafetySensor


class _StubGranite:
    """Stand-in Granite client: canned per-dimension verdicts (or raises), and a
    ``screened`` ledger so a test can assert a cache HIT skipped the screen."""

    model = "granite-stub"

    def __init__(
        self, *, dimensions: dict[str, bool] | None = None, error: Exception | None = None
    ) -> None:
        self._dimensions = dimensions or {}
        self._error = error
        self.screened: list[str] = []

    @property
    def criteria(self) -> list[str]:
        """The configured harm dimensions, in screen order — mirrors the real
        ``GraniteGuardianClient.criteria`` so the sensor can decide a full cache HIT
        without first issuing the screen (the keys are exactly ``screen()``'s keys)."""
        return list(self._dimensions)

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        if self._error is not None:
            raise self._error
        return dict(self._dimensions)


class _NoopJudge:
    model = "noop"

    async def complete(self, *args: object, **kwargs: object) -> str:  # pragma: no cover
        raise AssertionError("safety sensor must not call the judge")


def _ctx(note_text: str = "generated note") -> SensorContext:
    return SensorContext(note_text=note_text, transcript_text="t")


def _has_kwarg(func, name: str) -> bool:
    return name in inspect.signature(func).parameters


# ===========================================================================
# S1 / S2 (GREEN, AC-2/AC-3/AC-4) — the safety contract WS-3 must preserve.
# ===========================================================================


class TestSafetyContractPreserved:
    """The safety screen returns a per-criterion ``{dimension: is_unsafe}`` dict (keys
    in criteria order) and degrades FAIL-CLOSED on a backend error. WS-3's scoping must
    keep BOTH — scoping changes how often a criterion is screened, never the result
    shape or the degrade direction."""

    @pytest.mark.asyncio
    async def test_per_criterion_dict_shape_and_order_preserved(self):
        dims = {"harm": False, "social_bias": False, "violence": True}
        result = await SafetySensor(_StubGranite(dimensions=dims)).arun(_ctx(), judge=_NoopJudge())
        assert result.details["dimensions"] == dims
        assert list(result.details["dimensions"].keys()) == list(dims.keys())
        assert result.details["flagged_dimensions"] == ["violence"]
        assert result.passed is False
        assert result.score == pytest.approx(2 / 3)

    @pytest.mark.asyncio
    async def test_backend_error_degrades_fail_closed(self):
        result = await SafetySensor(_StubGranite(error=GraniteServiceError("offline"))).arun(
            _ctx(), judge=_NoopJudge()
        )
        assert result.degraded is True
        assert result.passed is False
        assert result.score == 0.0


# ===========================================================================
# S3 (RED, AC-1/AC-2/AC-5) — unchanged note content is not re-screened per pass.
# ===========================================================================


class TestSafetyScreenScopingReusesCache:
    """A regen does not re-screen note content already screened in a prior pass for a
    given criterion. Requires WS-3's content-addressed cache threaded into
    ``SafetySensor.arun(..., screen_cache=...)`` (a dict mutated in place so the
    activity/workflow can thread it across passes). A cache miss / changed content
    re-screens (conservative — never assumes safe)."""

    @pytest.mark.asyncio
    async def test_unchanged_note_content_not_rescreened(self):
        if not _has_kwarg(SafetySensor.arun, "screen_cache"):
            pytest.fail(
                "WS-3 (TASK-363): SafetySensor.arun(..., screen_cache=dict) not implemented "
                "yet (TDD RED) — no content-addressed safety-screen cache to scope a regen"
            )

        dims = {"harm": False, "violence": False}
        cache: dict[str, bool] = {}

        # Pass 1: empty cache -> the note IS screened, cache populated.
        g1 = _StubGranite(dimensions=dims)
        r1 = await SafetySensor(g1).arun(_ctx("note v1"), judge=_NoopJudge(), screen_cache=cache)
        assert len(g1.screened) == 1
        assert cache, "the screen cache must be populated after the first pass"

        # Pass 2: identical note content -> cache HIT -> the backend is NOT called again.
        g2 = _StubGranite(dimensions=dims)
        r2 = await SafetySensor(g2).arun(_ctx("note v1"), judge=_NoopJudge(), screen_cache=cache)
        assert len(g2.screened) == 0, "unchanged note content must not be re-screened (AC-1)"
        assert (r2.passed, r2.score, r2.details["dimensions"]) == (
            r1.passed,
            r1.score,
            r1.details["dimensions"],
        )

        # Pass 3: changed note content -> cache MISS -> re-screened (conservative).
        g3 = _StubGranite(dimensions=dims)
        await SafetySensor(g3).arun(_ctx("note v2 changed"), judge=_NoopJudge(), screen_cache=cache)
        assert len(g3.screened) == 1, "changed content must be re-screened (AC-5)"

    @pytest.mark.asyncio
    async def test_degraded_screen_is_never_cached_as_safe(self):
        """A backend error degrades FAIL-CLOSED even with a cache, and writes NOTHING to
        it — so a later pass over the SAME content re-screens (never served a cached
        'safe' verdict). The conservative invariant TASK-355 §7 / AC-4 require."""
        cache: dict[str, bool] = {}

        # A degraded screen must not populate the cache.
        g_err = _StubGranite(error=GraniteServiceError("offline"))
        r_err = await SafetySensor(g_err).arun(
            _ctx("note v1"), judge=_NoopJudge(), screen_cache=cache
        )
        assert (r_err.degraded, r_err.passed) == (True, False)
        assert cache == {}, "a degraded screen must never be cached (never recorded as safe)"

        # The same content is re-screened next pass — the degrade was not cached as a pass.
        g_ok = _StubGranite(dimensions={"harm": False, "violence": False})
        await SafetySensor(g_ok).arun(_ctx("note v1"), judge=_NoopJudge(), screen_cache=cache)
        assert len(g_ok.screened) == 1, "a prior degrade must not serve a cached 'safe' verdict"
