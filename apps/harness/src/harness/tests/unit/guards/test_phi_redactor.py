"""Tests for the fail-closed PHI redaction guard.

Covers:

* :meth:`PhiRedactor.redact` over a crafted clinical line carrying four PHI
  types (name / phone / MRN / DOB) — every raw value must be removed;
* :meth:`PhiRedactor.ensure_safe_for_cloud` **fail-closed** behaviour for a
  *cloud* egress provider — it must REFUSE (raise, return no text) when the
  analyzer raises **or** when removal cannot be confirmed (a silent anonymizer
  failure that leaves PHI in place); and
* the **local-provider pass-through**: a non-cloud provider returns the text
  untouched and never even invokes redaction.

The crafted-PHI test uses a real Presidio analyzer (loads the spaCy model once
per module). The fail-closed / pass-through tests inject fakes so they stay fast
and hermetic — they never load a model.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest

from harness.core.config import PhiConfig, Settings
from harness.guards.phi import PhiEgressBlocked, PhiRedactor, RedactionResult

# A crafted clinical line carrying four distinct PHI types.
_PHI_TEXT = (
    "Patient John Smith (MRN: 884512), DOB 03/14/1972, "
    "called from 415-555-0132 about chest pain."
)
_RAW_PHI_VALUES = ("John Smith", "884512", "03/14/1972", "415-555-0132")


def _settings(
    *,
    fail_closed: bool = True,
    providers: tuple[str, ...] = ("azure", "bedrock"),
    enabled: bool = True,
) -> Settings:
    """A ``settings``-shaped stand-in exposing the real :class:`PhiConfig`.

    Values are passed explicitly so the test is deterministic regardless of any
    ``HARNESS_PHI_*`` in the environment.
    """
    return cast(
        Settings,
        SimpleNamespace(
            phi=PhiConfig(
                enabled=enabled,
                fail_closed=fail_closed,
                cloud_egress_providers=list(providers),
            )
        ),
    )


class _RaisingAnalyzer:
    """An analyzer stand-in whose ``analyze`` always raises (backend failure)."""

    def analyze(self, *, text: str, language: str) -> list[object]:
        raise RuntimeError("presidio analyzer unavailable")


class _ForbiddenAnalyzer:
    """An analyzer that must never be called (proves the pass-through path)."""

    def analyze(self, *, text: str, language: str) -> list[object]:
        raise AssertionError("redaction must not run for a local (non-egress) provider")


class _Match:
    """A minimal Presidio ``RecognizerResult`` stand-in (offsets into the text)."""

    def __init__(self, entity_type: str, start: int, end: int, score: float) -> None:
        self.entity_type = entity_type
        self.start = start
        self.end = end
        self.score = score


class _DetectingAnalyzer:
    """Returns canned detections without loading a model."""

    def __init__(self, matches: list[_Match]) -> None:
        self._matches = matches

    def analyze(self, *, text: str, language: str) -> list[_Match]:
        return self._matches


class _NoOpAnonymizer:
    """Simulates a *silent anonymizer failure*: returns the text unchanged."""

    def anonymize(self, *, text: str, analyzer_results: list[_Match]) -> SimpleNamespace:
        return SimpleNamespace(text=text)


def _detected_person_redactor() -> PhiRedactor:
    """A redactor whose analyzer flags a PERSON span but whose anonymizer no-ops.

    The detected value therefore survives in the output, so removal cannot be
    confirmed — exercising the second fail-closed trigger.
    """
    start = _PHI_TEXT.index("John Smith")
    match = _Match("PERSON", start, start + len("John Smith"), 0.99)
    return PhiRedactor(analyzer=_DetectingAnalyzer([match]), anonymizer=_NoOpAnonymizer())


@pytest.fixture(scope="module")
def redactor() -> PhiRedactor:
    """A real Presidio-backed redactor — loads ``en_core_web_lg`` once per module."""
    return PhiRedactor()


class TestRedact:
    def test_redacts_name_phone_mrn_dob(self, redactor: PhiRedactor) -> None:
        result = redactor.redact(_PHI_TEXT)

        assert isinstance(result, RedactionResult)
        # No raw PHI value survives in the redacted text.
        for raw in _RAW_PHI_VALUES:
            assert raw not in result.text, f"PHI value {raw!r} leaked into redacted text"
        # All four expected entity kinds were detected (MRN is the custom recognizer).
        found = {e.entity_type for e in result.entities}
        assert {"PERSON", "MRN", "DATE_TIME", "PHONE_NUMBER"} <= found

    def test_clean_text_passes_through_unchanged(self, redactor: PhiRedactor) -> None:
        clean = "The patient reported improvement after rest and hydration."
        result = redactor.redact(clean)
        assert result.text == clean
        assert result.entities == []


class TestEnsureSafeForCloud:
    def test_cloud_provider_refuses_when_analyzer_raises(self) -> None:
        # Fail-closed: a cloud egress + analyzer failure must REFUSE (no text out).
        guard = PhiRedactor(analyzer=_RaisingAnalyzer())
        with pytest.raises(PhiEgressBlocked):
            guard.ensure_safe_for_cloud(
                _PHI_TEXT, provider="azure", settings=_settings(fail_closed=True)
            )

    def test_local_provider_is_passthrough_without_redacting(self) -> None:
        # A non-cloud provider returns the text untouched and never redacts.
        guard = PhiRedactor(analyzer=_ForbiddenAnalyzer())
        out = guard.ensure_safe_for_cloud(_PHI_TEXT, provider="lmstudio", settings=_settings())
        assert out == _PHI_TEXT

    def test_cloud_provider_refuses_when_removal_unconfirmed(self) -> None:
        # Fail-closed: detection succeeded but the anonymizer silently left PHI in,
        # so removal cannot be confirmed -> REFUSE.
        guard = _detected_person_redactor()
        with pytest.raises(PhiEgressBlocked):
            guard.ensure_safe_for_cloud(
                _PHI_TEXT, provider="azure", settings=_settings(fail_closed=True)
            )

    def test_cloud_provider_returns_redacted_text_on_success(self, redactor: PhiRedactor) -> None:
        out = redactor.ensure_safe_for_cloud(_PHI_TEXT, provider="bedrock", settings=_settings())
        assert out != _PHI_TEXT
        for raw in _RAW_PHI_VALUES:
            assert raw not in out

    def test_clean_text_egresses_to_cloud_unchanged(self, redactor: PhiRedactor) -> None:
        # No PHI detected -> nothing to remove -> confirmed clean -> egress allowed.
        clean = "The patient reported improvement after rest and hydration."
        out = redactor.ensure_safe_for_cloud(clean, provider="azure", settings=_settings())
        assert out == clean

    def test_fail_open_returns_original_when_analyzer_raises(self) -> None:
        # With fail_closed=False the guard degrades open: returns the input text.
        guard = PhiRedactor(analyzer=_RaisingAnalyzer())
        out = guard.ensure_safe_for_cloud(
            _PHI_TEXT, provider="azure", settings=_settings(fail_closed=False)
        )
        assert out == _PHI_TEXT

    def test_fail_open_returns_best_effort_when_removal_unconfirmed(self) -> None:
        # With fail_closed=False an unconfirmed removal degrades open to best effort.
        guard = _detected_person_redactor()
        out = guard.ensure_safe_for_cloud(
            _PHI_TEXT, provider="azure", settings=_settings(fail_closed=False)
        )
        assert out == _PHI_TEXT
