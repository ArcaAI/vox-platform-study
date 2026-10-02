"""Tests for the inferential PHI egress screen (the judge's DIRECT provider hop).

TASK-1035 retired the per-call ``ensure_egress_safe`` chokepoint: every ``apps/text``
``/generate`` call is redacted by text itself. What remains here is the screen for the hop that
does NOT go through text — the inferential judge posts to its provider directly — honouring the
run-effective policy flags (``phi_enabled`` / ``phi_fail_closed`` snapshotted at workflow start).
The local set is CODE (``LOCAL_DIRECT_TRANSPORTS``), not the retired env allowlist.

Covers :func:`ensure_inferential_egress_safe`:

* all-local / disabled → identity no-op (same objects ⇒ byte-identical replay);
* cloud → note + transcript + every claim text/evidence quote + knowledge chunk redacted, with
  ids/sections preserved;
* per-consumer routing (only the cloud consumer's payload is redacted);
* a cloud block propagates :class:`PhiEgressBlocked` (the activity degrades).

The fakes inject analyzers so nothing loads a spaCy model.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.core.llm_egress import is_local_direct_transport
from harness.guards.phi import PhiEgressBlocked, PhiRedactor
from harness.guards.phi.egress import ensure_inferential_egress_safe

_PHI_TEXT = "Patient John Smith (MRN: 884512) called about chest pain."


class _RaisingAnalyzer:
    def analyze(self, *, text: str, language: str) -> list[object]:
        raise RuntimeError("presidio analyzer unavailable")


class _ForbiddenAnalyzer:
    def analyze(self, *, text: str, language: str) -> list[object]:
        raise AssertionError("redaction must not run on the bypass/local path")


class _ContractRedactor:
    """Mirrors ``PhiRedactor.ensure_safe_for_cloud`` (local pass-through; cloud
    transform/block) without loading a model — records every call."""

    def __init__(self, *, transform: Any = None, block: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self._transform = transform
        self._block = block

    def ensure_safe_for_cloud(self, text: str, *, provider: str, fail_closed: bool) -> str:
        self.calls.append((text, provider))
        if is_local_direct_transport(provider):
            return text
        if self._block:
            raise PhiEgressBlocked(provider=provider, reason="contract block")
        return self._transform(text) if self._transform is not None else text


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
                phi_enabled=True,
                phi_fail_closed=True,
                redactor=PhiRedactor(analyzer=_RaisingAnalyzer()),
            )
