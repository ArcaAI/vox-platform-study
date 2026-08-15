"""Tests for the PHI egress chokepoint.

The chokepoint
wraps the existing fail-closed :class:`PhiRedactor` with the run-effective policy
flags (``phi_enabled`` / ``phi_fail_closed`` snapshotted at workflow start) and a
fan-out helper that redacts every cloud-bound field of the inferential pass once.

Covers:

* :func:`ensure_egress_safe` — the per-string gate:
  - ``phi_enabled=False`` → pure bypass (never even builds the redactor);
  - ``provider is None`` → bypass (no egress target);
  - local provider → pass-through (delegates; the redactor no-ops);
  - cloud + clean → cleaned text returned;
  - cloud + fail-closed + unconfirmed/raised redaction → :class:`PhiEgressBlocked`;
  - the **policy** ``phi_fail_closed`` governs over ``settings.phi.fail_closed``.
* :func:`ensure_inferential_egress_safe` — the inferential fan-out:
  - all-local / disabled → identity no-op (same objects ⇒ byte-identical replay);
  - cloud → note + transcript + every claim text/evidence quote + knowledge chunk
    redacted, with ids/sections preserved;
  - per-consumer routing (only the cloud consumer's payload is redacted);
  - a cloud block propagates :class:`PhiEgressBlocked` (the activity degrades).

The fakes inject analyzers/anonymizers so nothing loads a spaCy model.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from harness.core.config import PhiConfig, Settings
from harness.guards.phi import PhiEgressBlocked, PhiRedactor
from harness.guards.phi.egress import ensure_egress_safe, ensure_inferential_egress_safe

_PHI_TEXT = "Patient John Smith (MRN: 884512) called about chest pain."


def _settings(
    *,
    enabled: bool = True,
    fail_closed: bool = True,
    local: tuple[str, ...] = ("lm-studio", "openai_compat", "ollama", "vllm", "llama-cpp"),
) -> Settings:
    """A real ``Settings`` carrying an explicit :class:`PhiConfig`.

    Real (not a SimpleNamespace) so the ``model_copy`` policy-override path in the
    chokepoint is exercised; phi values are explicit so the test is deterministic
    regardless of any ``HARNESS_PHI_*`` in the environment.
    """
    return Settings(
        phi=PhiConfig(enabled=enabled, fail_closed=fail_closed, local_providers=list(local))
    )


class _RaisingAnalyzer:
    def analyze(self, *, text: str, language: str) -> list[object]:
        raise RuntimeError("presidio analyzer unavailable")


class _ForbiddenAnalyzer:
    def analyze(self, *, text: str, language: str) -> list[object]:
        raise AssertionError("redaction must not run on the bypass/local path")


class _Match:
    def __init__(self, entity_type: str, start: int, end: int, score: float) -> None:
        self.entity_type = entity_type
        self.start = start
        self.end = end
        self.score = score


class _DetectingAnalyzer:
    def __init__(self, matches: list[_Match]) -> None:
        self._matches = matches

    def analyze(self, *, text: str, language: str) -> list[_Match]:
        return self._matches


class _NoOpAnonymizer:
    """Simulates a silent anonymizer failure: returns the text unchanged."""

    def anonymize(self, *, text: str, analyzer_results: list[_Match]) -> SimpleNamespace:
        return SimpleNamespace(text=text)


def _detected_person_redactor() -> PhiRedactor:
    start = _PHI_TEXT.index("John Smith")
    match = _Match("PERSON", start, start + len("John Smith"), 0.99)
    return PhiRedactor(analyzer=_DetectingAnalyzer([match]), anonymizer=_NoOpAnonymizer())


class _ContractRedactor:
    """Mirrors ``PhiRedactor.ensure_safe_for_cloud`` (local pass-through; cloud
    transform/block) without loading a model — records every call."""

    def __init__(self, *, transform: Any = None, block: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self._transform = transform
        self._block = block

    def ensure_safe_for_cloud(self, text: str, *, provider: str, settings: Settings) -> str:
        self.calls.append((text, provider))
        if provider in settings.phi.local_providers:
            return text
        if self._block:
            raise PhiEgressBlocked(provider=provider, reason="contract block")
        return self._transform(text) if self._transform is not None else text


class TestEnsureEgressSafe:
    def test_disabled_bypasses_guard_even_for_cloud(self) -> None:
        # phi_enabled=False ⇒ egress allowed unredacted; redactor never built/called.
        guard = PhiRedactor(analyzer=_ForbiddenAnalyzer())
        out = ensure_egress_safe(
            _PHI_TEXT,
            provider="azure",
            settings=_settings(),
            phi_enabled=False,
            phi_fail_closed=True,
            redactor=guard,
        )
        assert out == _PHI_TEXT

    def test_none_provider_is_passthrough(self) -> None:
        guard = PhiRedactor(analyzer=_ForbiddenAnalyzer())
        out = ensure_egress_safe(
            _PHI_TEXT,
            provider=None,
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=guard,
        )
        assert out == _PHI_TEXT

    def test_local_provider_passthrough_without_redacting(self) -> None:
        # A non-cloud provider returns text untouched (no redaction).
        guard = PhiRedactor(analyzer=_ForbiddenAnalyzer())
        out = ensure_egress_safe(
            _PHI_TEXT,
            provider="lm-studio",
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=guard,
        )
        assert out == _PHI_TEXT

    def test_cloud_returns_cleaned_text(self) -> None:
        # Cloud egress receives the cleaned text.
        redactor = _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>"))
        out = ensure_egress_safe(
            _PHI_TEXT,
            provider="azure",
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=redactor,
        )
        assert "John Smith" not in out
        assert out == _PHI_TEXT.replace("John Smith", "<PERSON>")

    def test_cloud_fail_closed_blocks_when_analyzer_raises(self) -> None:
        # Fail-closed + redaction failure ⇒ block (degrade-closed).
        guard = PhiRedactor(analyzer=_RaisingAnalyzer())
        with pytest.raises(PhiEgressBlocked):
            ensure_egress_safe(
                _PHI_TEXT,
                provider="azure",
                settings=_settings(fail_closed=True),
                phi_enabled=True,
                phi_fail_closed=True,
                redactor=guard,
            )

    def test_cloud_fail_closed_blocks_when_removal_unconfirmed(self) -> None:
        # Detection succeeded but PHI survived ⇒ block.
        with pytest.raises(PhiEgressBlocked):
            ensure_egress_safe(
                _PHI_TEXT,
                provider="azure",
                settings=_settings(fail_closed=True),
                phi_enabled=True,
                phi_fail_closed=True,
                redactor=_detected_person_redactor(),
            )

    def test_policy_fail_closed_false_overrides_settings_true(self) -> None:
        # The run-effective policy flag governs — phi_fail_closed=False degrades
        # OPEN even though settings.phi.fail_closed is True.
        out = ensure_egress_safe(
            _PHI_TEXT,
            provider="azure",
            settings=_settings(fail_closed=True),
            phi_enabled=True,
            phi_fail_closed=False,
            redactor=_detected_person_redactor(),
        )
        assert out == _PHI_TEXT  # best-effort (no-op anonymizer) returned, not raised

    def test_policy_fail_closed_true_overrides_settings_false(self) -> None:
        # Inverse: policy phi_fail_closed=True blocks even when settings says fail-open.
        with pytest.raises(PhiEgressBlocked):
            ensure_egress_safe(
                _PHI_TEXT,
                provider="azure",
                settings=_settings(fail_closed=False),
                phi_enabled=True,
                phi_fail_closed=True,
                redactor=_detected_person_redactor(),
            )

    def test_unknown_provider_is_redacted_not_passed_through(self) -> None:
        # TASK-706: an unlisted provider string must default to redact-and-confirm
        # (the chokepoint's own delegation to PhiRedactor.ensure_safe_for_cloud),
        # never to the local pass-through branch.
        redactor = _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>"))
        out = ensure_egress_safe(
            _PHI_TEXT,
            provider="some-new-cloud-provider",
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=redactor,
        )
        assert "John Smith" not in out
        assert redactor.calls == [(_PHI_TEXT, "some-new-cloud-provider")]


def _citations() -> dict[str, Any]:
    return {
        "claims": [
            {
                "id": "c1",
                "section": "A",
                "text": "John Smith has HTN",
                "evidence": [{"quote": "John Smith reported HTN"}],
            }
        ],
        "other": "keep-me",
    }


class TestEnsureInferentialEgressSafe:
    def test_all_local_is_identity_noop(self) -> None:
        # Both consumers local ⇒ inputs returned unchanged (same objects),
        # the redactor is never touched ⇒ byte-identical / no added latency.
        guard = PhiRedactor(analyzer=_ForbiddenAnalyzer())
        note, transcript, citations, chunks = (
            "John Smith stable",
            "John Smith has HTN",
            _citations(),
            {"kc1": "John Smith chunk"},
        )
        out = ensure_inferential_egress_safe(
            note_text=note,
            transcript_text=transcript,
            citations_map=citations,
            knowledge_chunks=chunks,
            judge_provider="openai_compat",
            safety_provider="lm-studio",
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=guard,
        )
        assert out[0] is note
        assert out[1] is transcript
        assert out[2] is citations
        assert out[3] is chunks

    def test_disabled_is_identity_noop(self) -> None:
        guard = PhiRedactor(analyzer=_ForbiddenAnalyzer())
        citations = _citations()
        out = ensure_inferential_egress_safe(
            note_text="John Smith",
            transcript_text="John Smith",
            citations_map=citations,
            knowledge_chunks={"kc1": "John Smith"},
            judge_provider="azure",
            safety_provider="azure",
            settings=_settings(),
            phi_enabled=False,
            phi_fail_closed=True,
            redactor=guard,
        )
        assert out[2] is citations  # untouched

    def test_cloud_redacts_every_field(self) -> None:
        # Note + transcript + claim text + evidence quote + chunk all redacted;
        # ids/sections + sibling keys preserved.
        redactor = _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>"))
        note, transcript, citations, chunks = (
            "Note John Smith stable",
            "John Smith has HTN",
            _citations(),
            {"kc1": "John Smith chunk"},
        )
        safe_note, safe_tx, safe_cit, safe_chunks = ensure_inferential_egress_safe(
            note_text=note,
            transcript_text=transcript,
            citations_map=citations,
            knowledge_chunks=chunks,
            judge_provider="azure",
            safety_provider="azure",
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=redactor,
        )
        assert safe_note == "Note <PERSON> stable"
        assert safe_tx == "<PERSON> has HTN"
        claim = safe_cit["claims"][0]
        assert claim["text"] == "<PERSON> has HTN"
        assert claim["evidence"][0]["quote"] == "<PERSON> reported HTN"
        assert claim["id"] == "c1" and claim["section"] == "A"
        assert safe_cit["other"] == "keep-me"
        assert safe_chunks["kc1"] == "<PERSON> chunk"
        # The original inputs are not mutated in place.
        assert citations["claims"][0]["text"] == "John Smith has HTN"

    def test_redacts_only_the_cloud_consumer_payload(self) -> None:
        # Routing: judge local + safety cloud ⇒ only the Granite note is redacted;
        # the judge-bound transcript/claims/chunks pass through untouched.
        redactor = _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>"))
        safe_note, safe_tx, safe_cit, safe_chunks = ensure_inferential_egress_safe(
            note_text="John Smith stable",
            transcript_text="John Smith has HTN",
            citations_map=_citations(),
            knowledge_chunks={"kc1": "John Smith chunk"},
            judge_provider="openai_compat",
            safety_provider="azure",
            settings=_settings(),
            phi_enabled=True,
            phi_fail_closed=True,
            redactor=redactor,
        )
        assert safe_note == "<PERSON> stable"
        assert safe_tx == "John Smith has HTN"
        assert safe_cit["claims"][0]["text"] == "John Smith has HTN"
        assert safe_chunks["kc1"] == "John Smith chunk"

    def test_cloud_block_propagates(self) -> None:
        # A fail-closed block raises so the activity can degrade the whole pass.
        with pytest.raises(PhiEgressBlocked):
            ensure_inferential_egress_safe(
                note_text=_PHI_TEXT,
                transcript_text="",
                citations_map={"claims": []},
                knowledge_chunks={},
                judge_provider="openai_compat",
                safety_provider="azure",
                settings=_settings(fail_closed=True),
                phi_enabled=True,
                phi_fail_closed=True,
                redactor=PhiRedactor(analyzer=_RaisingAnalyzer()),
            )
