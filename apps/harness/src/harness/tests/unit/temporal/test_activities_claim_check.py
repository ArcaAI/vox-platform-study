"""Activity-level claim-check tests.

Each *real* activity body runs in a Temporal ``ActivityEnvironment`` with the tool
clients + the blob store monkeypatched, so we assert the claim-check seam without
network or live MinIO:

* **Produce** — ``generate`` / ``assemble_prompt`` offload their big outputs above
  the threshold: the inline field is EMPTIED and a ref is set, so the blob content
  never enters the activity RESULT. Below the threshold / disabled ⇒ inline.
* **Consume** — ``extract_entities`` / ``persist_draft`` / ``run_inferential_sensors``
  resolve inline-or-ref at entry: driving an activity with an inline input and with a
  ref input produces IDENTICAL materialized behaviour.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import ClaimCheckConfig, Settings
from harness.sensors.base import NEREntity
from harness.services.api_client import DraftResponse
from harness.services.smr_client import SmrGenerationResult
from harness.temporal import activities
from harness.temporal.claim_check import InMemoryBlobStore, load_blob, store_blob
from harness.temporal.models import (
    ExtractEntitiesInput,
    GenerateInput,
    PersistDraftInput,
    SegmentCitationRef,
)

_BUCKET = "harness-claim-check"
# A PHI-free blob comfortably over the small test threshold (so the egress guard
# is a no-op pass-through and the ONLY behaviour under test is the claim-check).
_BIG_NOTE = '{"subjective": "' + "x" * 400 + '"}'


def _settings(*, enabled: bool = True, min_bytes: int = 16) -> Settings:
    return Settings(
        claim_check=ClaimCheckConfig(enabled=enabled, store="memory", min_bytes=min_bytes)
    )


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class _FakeSmr:
    def __init__(self, content: str) -> None:
        self.kwargs: dict[str, Any] = {}
        self._content = content

    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        self.kwargs = kwargs
        return SmrGenerationResult(content=self._content, model="m", finish_reason="stop")


class _FakeApiPersist:
    def __init__(self) -> None:
        self.content: str | None = None

    async def persist_draft(self, consultation_id: str, **kwargs: Any) -> DraftResponse:
        self.content = kwargs.get("content")
        return DraftResponse(context_item_id="ctx-1")


class _FakeNlp:
    def __init__(self) -> None:
        self.text: str | None = None

    async def classify_tokens(self, text: str, *, language: str = "en") -> list[NEREntity]:
        self.text = text
        return [NEREntity(text="hypertension", type="DISEASE", start=0, end=12)]


class TestGenerateOffloadsNote:
    @pytest.mark.asyncio
    async def test_offloads_big_note_and_keeps_content_out_of_result(self, env, monkeypatch):
        """An offloaded note ⇒ ``content`` emptied + ref; the blob is NOT in the result."""
        store = InMemoryBlobStore()
        monkeypatch.setattr(activities, "get_settings", lambda: _settings())
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_smr_client", lambda s: _FakeSmr(_BIG_NOTE))

        result = await env.run(activities.generate, GenerateInput(prompt="P"))

        assert result.content == ""  # inline emptied — note not serialized into history
        assert result.content_ref is not None
        assert _BIG_NOTE not in str(result.model_dump())  # content out of the result
        # The blob round-trips from the store byte-for-byte.
        assert await load_blob(result.content_ref, store=store) == _BIG_NOTE

    @pytest.mark.asyncio
    async def test_small_note_stays_inline(self, env, monkeypatch):
        store = InMemoryBlobStore()
        monkeypatch.setattr(activities, "get_settings", lambda: _settings(min_bytes=100_000))
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_smr_client", lambda s: _FakeSmr("small"))

        result = await env.run(activities.generate, GenerateInput(prompt="P"))

        assert result.content == "small"
        assert result.content_ref is None

    @pytest.mark.asyncio
    async def test_disabled_keeps_note_inline_even_above_threshold(self, env, monkeypatch):
        """The disabled path is byte-identical to a no-offload path (no offload, no ref)."""
        store = InMemoryBlobStore()
        monkeypatch.setattr(activities, "get_settings", lambda: _settings(enabled=False))
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_smr_client", lambda s: _FakeSmr(_BIG_NOTE))

        result = await env.run(activities.generate, GenerateInput(prompt="P"))

        assert result.content == _BIG_NOTE
        assert result.content_ref is None

    @pytest.mark.asyncio
    async def test_resolves_prompt_ref_and_folds_block_before_smr(self, env, monkeypatch):
        """Consume: the prompt is resolved inline-or-ref and the RAG block folded in."""
        store = InMemoryBlobStore()
        prompt_ref = await store_blob("BASE PROMPT", store=store, bucket=_BUCKET)
        fake = _FakeSmr("small")
        monkeypatch.setattr(activities, "get_settings", lambda: _settings(min_bytes=100_000))
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_smr_client", lambda s: fake)

        await env.run(
            activities.generate,
            GenerateInput(prompt="", prompt_ref=prompt_ref, prompt_block="[[kb:1]] chunk"),
        )
        # generate resolved the offloaded prompt AND folded in the StrictCitations block.
        assert fake.kwargs["prompt"] == "BASE PROMPT\n\n[[kb:1]] chunk"

    @pytest.mark.asyncio
    async def test_folds_segment_citations_block_when_refs_provided(self, env, monkeypatch):
        """generate folds a [[seg:<id>]] StrictCitations block when refs given."""
        seg_id = "11111111-1111-1111-1111-111111111111"
        fake = _FakeSmr("small")
        monkeypatch.setattr(activities, "get_settings", lambda: _settings(min_bytes=100_000))
        monkeypatch.setattr(activities, "_smr_client", lambda s: fake)

        await env.run(
            activities.generate,
            GenerateInput(
                prompt="BASE PROMPT",
                segment_citations=[
                    SegmentCitationRef(id=seg_id, speaker="CLINICIAN", t0_ms=0, t1_ms=500)
                ],
            ),
        )
        prompt = fake.kwargs["prompt"]
        assert prompt.startswith("BASE PROMPT")
        assert "[[seg:" in prompt
        assert seg_id in prompt
        assert "CLINICIAN" in prompt


class TestConsumersResolveInlineOrRef:
    @pytest.mark.asyncio
    async def test_persist_draft_identical_for_inline_and_ref(self, env, monkeypatch):
        """An inline content and a ref-to-the-same-content materialize identically."""
        store = InMemoryBlobStore()
        api = _FakeApiPersist()
        monkeypatch.setattr(activities, "get_settings", lambda: _settings())
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_api_client", lambda s: api)

        # (a) inline content → apps/api receives it verbatim.
        await env.run(
            activities.persist_draft,
            PersistDraftInput(consultation_id="c", tenant_id="t", content=_BIG_NOTE),
        )
        inline_seen = api.content

        # (b) ref-to-the-same-content (inline emptied) → apps/api receives the SAME note.
        ref = await store_blob(_BIG_NOTE, store=store, bucket=_BUCKET)
        await env.run(
            activities.persist_draft,
            PersistDraftInput(consultation_id="c", tenant_id="t", content="", content_ref=ref),
        )
        ref_seen = api.content

        assert inline_seen == _BIG_NOTE
        assert ref_seen == _BIG_NOTE  # identical materialized behaviour

    @pytest.mark.asyncio
    async def test_extract_entities_resolves_note_ref(self, env, monkeypatch):
        """Note-NER dereferences an offloaded note before the NLP pass."""
        store = InMemoryBlobStore()
        ref = await store_blob(_BIG_NOTE, store=store, bucket=_BUCKET)
        nlp = _FakeNlp()
        monkeypatch.setattr(activities, "get_settings", lambda: _settings())
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_nlp_client", lambda s: nlp)

        result = await env.run(
            activities.extract_entities, ExtractEntitiesInput(text="", text_ref=ref)
        )
        assert nlp.text == _BIG_NOTE  # the NLP client saw the resolved (full) note
        assert [e.text for e in result.entities] == ["hypertension"]


class TestAssembleOffloadsPrompt:
    @pytest.mark.asyncio
    async def test_offloads_big_user_prompt(self, env, monkeypatch):
        """Produce: a big assembled prompt is offloaded (inline emptied + ref)."""

        class _FakeApiAssemble:
            async def assemble(self, consultation_id: str, **kwargs: Any):
                from harness.services.api_client import AssembleResponse

                return AssembleResponse(user_prompt=_BIG_NOTE, system_prompt="short")

        store = InMemoryBlobStore()
        monkeypatch.setattr(activities, "get_settings", lambda: _settings())
        monkeypatch.setattr(activities, "build_blob_store", lambda cc: store)
        monkeypatch.setattr(activities, "_api_client", lambda s: _FakeApiAssemble())

        from harness.temporal.models import AssembleInput

        resp = await env.run(
            activities.assemble_prompt, AssembleInput(consultation_id="c", tenant_id="t")
        )
        assert resp.user_prompt == ""  # offloaded
        assert resp.user_prompt_ref is not None
        assert resp.system_prompt == "short"  # below threshold — inline
        assert resp.system_prompt_ref is None
        assert await load_blob(resp.user_prompt_ref, store=store) == _BIG_NOTE
