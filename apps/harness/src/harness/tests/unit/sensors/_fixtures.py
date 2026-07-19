"""Deterministic, hand-built fixtures for the sensor unit tests.

No network/NLP/LLM — every transcript/note/entity/claim is crafted inline so the
sensor heuristics are exercised reproducibly. Not collected by pytest (does not
match ``test_*``).
"""

from __future__ import annotations

from typing import Any

from harness.sensors.base import NEREntity


def soap_schema() -> dict[str, Any]:
    """Mirror of the seeded SOAP ``json_schema`` (07-prompt-template.ts)."""
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "subjective": {"type": "string"},
            "objective": {"type": "string"},
            "assessment": {"type": "string"},
            "plan": {"type": "string"},
        },
        "required": ["subjective", "objective", "assessment", "plan"],
    }


def response_format() -> dict[str, Any]:
    """The ``responseFormat`` wrapper PromptAssemblyService emits around the schema."""
    return {"type": "json_schema", "json_schema": soap_schema(), "strict": True}


def valid_soap() -> dict[str, str]:
    """A well-formed SOAP note object (all four sections, all strings)."""
    return {
        "subjective": "Patient reports worsening hypertension over two weeks.",
        "objective": "BP 150/95. Heart rate 78 bpm.",
        "assessment": "Essential hypertension, poorly controlled.",
        "plan": "Continue lisinopril 10 mg daily. Follow up in 4 weeks.",
    }


def ner(
    text: str,
    type_: str = "",
    start: int = 0,
    end: int = 0,
    assertion: str | None = None,
) -> NEREntity:
    return NEREntity(text=text, type=type_, start=start, end=end, assertion=assertion)


def claim(
    claim_id: str,
    *,
    text: str = "",
    section: str = "A",
    status: str = "unverified",
    evidence: list[dict[str, Any]] | None = None,
    knowledge_chunk_ids: list[str] | None = None,
) -> dict[str, Any]:
    """A ``citationsMap.claims[]`` entry."""
    return {
        "id": claim_id,
        "text": text or claim_id,
        "section": section,
        "status": status,
        "evidence": [] if evidence is None else evidence,
        "entityRefs": [],
        "knowledgeChunkIds": list(knowledge_chunk_ids or []),
    }


def evidence(
    *, quote: str, start: int = 0, end: int = 0, transcript_context_item_id: str = "t-1"
) -> dict[str, Any]:
    return {
        "transcriptContextItemId": transcript_context_item_id,
        "startOffset": start,
        "endOffset": end,
        "quote": quote,
    }
