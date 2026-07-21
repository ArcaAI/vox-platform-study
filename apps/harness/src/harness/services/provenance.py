"""Deterministic Phase-1 provenance (citationsMap) builder.

Phase-1 has no LLM claim-extractor, so the loop derives a deterministic
``citationsMap`` from the note entities: each distinct note entity becomes a
claim, attributed to the SOAP section that contains it. A note entity grounded
in the transcript (a same-text transcript NER span, or a verbatim transcript
mention) carries that transcript evidence span and is ``verified``; an
ungrounded one is ``unverified`` with no evidence — never silently asserted, so
citation-presence / entity-faithfulness can act on it (per the degradation
policy).

Shape matches the ``SummaryMeta.citationsMap`` contract:
``{"claims": [{id, text, section(S|O|A|P), confidence, status, evidence:[...],
entityRefs:[], knowledgeChunkIds:[]}]}``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from harness.guides.retrieval.prompt import extract_cited_ids
from harness.sensors.base import SUBWORD_MARKER, NEREntity, normalize_text

# SOAP property name -> single-letter section code (matches the sensors).
_SECTION_CODES = (
    ("subjective", "S"),
    ("objective", "O"),
    ("assessment", "A"),
    ("plan", "P"),
)
_DEFAULT_SECTION = "A"

# SentencePiece "▁" (U+2581) word-boundary marker. NER spans tokenized by a
# SentencePiece model can carry it (e.g. "▁October"); it must never leak into the
# human-readable citation claim text / evidence quote, nor into the keys used to
# match an entity against the (plain) SOAP section text / transcript. Single
# source: the same constant the base ``normalize_text`` strips.
_SUBWORD_MARKER = SUBWORD_MARKER

# Max character gap between one NER span's end and the next span's start for them to
# count as contiguous. Live NLP token spans touch at 0; an occasional boundary char
# (a slash/comma the tokenizer kept separate) yields 1.
_CONTIGUOUS_GAP = 1


def _clean_claim_text(text: str) -> str:
    """Strip SentencePiece ``▁`` markers and collapse to clean human-readable text.

    Replaces every ``▁`` (U+2581) with a regular space and collapses runs of
    whitespace (so ``"▁October ▁2025"`` -> ``"October 2025"``). Legitimate content
    (letters, digits, punctuation) is untouched, so ``"120/80 mmHg"`` is preserved.
    """
    if not text:
        return text
    return " ".join(text.replace(_SUBWORD_MARKER, " ").split())


def _match_norm(text: str) -> str:
    """Matching key with ``▁`` stripped, then normalized (case-fold + ws-collapse).

    The live NER returns ``▁``-bearing subword surfaces ("▁amlodipine") while the
    SOAP section text and transcript are plain. Section derivation and transcript
    grounding must compare like with like, so every match goes through this
    ▁-insensitive key — without it a marker-bearing entity never matches its
    section and silently collapses to the default ("A").
    """
    return normalize_text(_clean_claim_text(text))


def _is_inside_tag(entity_type: str) -> bool:
    """True for a BIO ``I-*`` continuation tag (the token extends the prior entity)."""
    return entity_type.upper().startswith("I-")


def _aggregate_subword_entities(entities: Sequence[NEREntity]) -> list[NEREntity]:
    """Merge BIO subword tokens into coherent phrase-entities.

    The live NER (``/classify/tokens``) emits one entity per SentencePiece token
    with BIO tags (``B-MEDICATION``, ``I-DOSAGE``, ...). A ``B-``/bare/``O`` token
    starts a new entity; each trailing ``I-*`` token that is offset-contiguous with
    the running span extends it. Tokens are detokenized by concatenating their raw
    surfaces and converting ``▁`` -> space, so ``["▁5","▁mg","▁once","▁daily"]`` ->
    ``"5 mg once daily"`` and ``["▁130","/","80","▁mmHg"]`` -> ``"130/80 mmHg"``.

    Without this, one claim per subword fragments dosages / lab values into bare
    unit tokens and floods citation-verify. Entities lacking usable offsets (the
    deterministic Phase-1 fixtures, which already supply whole-entity spans) never
    satisfy contiguity, so each stays its own claim.
    """
    groups: list[list[NEREntity]] = []
    for entity in entities:
        prev = groups[-1][-1] if groups else None
        contiguous = (
            prev is not None
            and entity.start >= 0
            and prev.end >= 0
            and 0 <= entity.start - prev.end <= _CONTIGUOUS_GAP
        )
        if prev is not None and _is_inside_tag(entity.type) and contiguous:
            groups[-1].append(entity)
        else:
            groups.append([entity])

    merged: list[NEREntity] = []
    for group in groups:
        raw = "".join(part.text for part in group)
        merged.append(
            NEREntity(
                text=_clean_claim_text(raw),
                type=group[0].type,
                start=group[0].start,
                end=group[-1].end,
            )
        )
    return merged


# Non-clinical NER noise the entity-level sensors must ignore: spoken-number
# "mic check" counting words ("one, two, three") and bare function words the
# tokenizer occasionally surfaces as standalone entities. Conservative — a span
# is dropped only when EVERY one of its tokens is noise, so a real phrase that
# merely contains such a word ("two week history", "day three of symptoms")
# survives.
_COUNTING_WORDS = frozenset(
    {
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
    }
)
_STOPWORDS = frozenset(
    {
        "the",
        "a",
        "an",
        "and",
        "or",
        "of",
        "to",
        "in",
        "on",
        "at",
        "is",
        "are",
        "was",
        "were",
        "be",
        "with",
        "for",
        "this",
        "that",
    }
)
_NOISE_TOKENS = _COUNTING_WORDS | _STOPWORDS


def _is_noise_entity(text: str) -> bool:
    """True when every token of ``text`` is non-clinical noise (or it is empty)."""
    norm = normalize_text(text)
    if not norm:
        return True
    return all(token in _NOISE_TOKENS for token in norm.split())


def clean_entities_for_sensors(entities: Sequence[NEREntity]) -> list[NEREntity]:
    """Clean NER entities for the entity-level sensors — one shared cleanup.

    Reuses the claims-path subword aggregation (``_aggregate_subword_entities``,
    which merges ``B-``/``I-`` BIO subword tokens into phrase-entities and strips
    the ``▁`` marker via ``_clean_claim_text``) so ``entity_faithfulness`` /
    ``coverage_omission`` see exactly the same merged, marker-free surfaces the
    ``citationsMap`` does — no divergent second implementation. Then drops spans
    that are pure non-clinical noise (mic-check counting words / bare stopwords /
    empty tokens) so a "one, two, three" mic check or a stray ``▁One`` fragment
    never counts as a clinical entity.
    """
    merged = _aggregate_subword_entities(entities)
    return [entity for entity in merged if not _is_noise_entity(entity.text)]


def _derive_section(entity_norm: str, soap_sections: dict[str, Any]) -> str:
    """Return the S/O/A/P code of the first section whose text contains the entity."""
    for key, code in _SECTION_CODES:
        value = soap_sections.get(key)
        if value is None:
            continue
        if entity_norm and entity_norm in normalize_text(str(value)):
            return code
    return _DEFAULT_SECTION


def _evidence_for(
    entity: NEREntity,
    *,
    transcript_by_norm: dict[str, NEREntity],
    transcript_norm: str,
    transcript_text: str,
    transcript_context_item_id: str | None,
) -> dict[str, Any] | None:
    """Build a transcript evidence span for a grounded entity, else ``None``."""
    norm = _match_norm(entity.text)
    if not norm:
        return None

    match = transcript_by_norm.get(norm)
    if match is not None:
        return {
            "transcriptContextItemId": transcript_context_item_id,
            "startOffset": match.start,
            "endOffset": match.end,
            "quote": _clean_claim_text(match.text),
        }

    if norm in transcript_norm:
        idx = transcript_text.lower().find(entity.text.lower())
        return {
            "transcriptContextItemId": transcript_context_item_id,
            "startOffset": idx,
            "endOffset": idx + len(entity.text) if idx >= 0 else -1,
            "quote": _clean_claim_text(entity.text),
        }
    return None


def _section_cited_ids(
    soap_sections: dict[str, Any], retrieved_chunk_ids: Sequence[str]
) -> dict[str, list[str]]:
    """Map each S/O/A/P code to the retrieved chunk ids the model cited in it.

    StrictCitations: the model cites supporting chunks inline with ``[[kb:<id>]]``.
    Parsing is **strict** — only ids that were actually retrieved survive — so a
    hallucinated citation never reaches ``knowledgeChunkIds``. Empty universe ->
    every section maps to ``[]`` (markers ignored).
    """
    allowed = {cid for cid in retrieved_chunk_ids if cid}
    if not allowed:
        return {}
    cited: dict[str, list[str]] = {}
    for key, code in _SECTION_CODES:
        value = soap_sections.get(key)
        if value is None:
            continue
        ids = extract_cited_ids(str(value), allowed)
        if ids:
            cited[code] = ids
    return cited


def build_citations_map(
    *,
    soap_sections: dict[str, Any],
    note_entities: Sequence[NEREntity],
    transcript_entities: Sequence[NEREntity],
    transcript_text: str = "",
    transcript_context_item_id: str | None = None,
    retrieved_chunk_ids: Sequence[str] = (),
) -> dict[str, Any]:
    """Derive a deterministic ``{"claims": [...]}`` provenance map.

    ``retrieved_chunk_ids`` (Phase 3) is the set of chunk ids the JIT retriever
    surfaced for this generation; when present, each claim's ``knowledgeChunkIds``
    is filled from the StrictCitations ``[[kb:<id>]]`` markers the model wrote in
    that claim's SOAP section (section-level attribution). Absent retrieval (the
    flag-off Phase-1/2 path) the field stays ``[]``.
    """
    section_cited = _section_cited_ids(soap_sections, retrieved_chunk_ids)

    # Collapse live BIO subword tokens into coherent phrase-entities before deriving
    # claims (no-op for the whole-entity Phase-1 fixtures).
    note_entities = _aggregate_subword_entities(note_entities)
    transcript_entities = _aggregate_subword_entities(transcript_entities)

    transcript_by_norm: dict[str, NEREntity] = {}
    for entity in transcript_entities:
        key = _match_norm(entity.text)
        if key and key not in transcript_by_norm:
            transcript_by_norm[key] = entity
    transcript_norm = _match_norm(transcript_text)

    claims: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entity in note_entities:
        norm = _match_norm(entity.text)
        if not norm or norm in seen:
            continue
        seen.add(norm)

        evidence = _evidence_for(
            entity,
            transcript_by_norm=transcript_by_norm,
            transcript_norm=transcript_norm,
            transcript_text=transcript_text,
            transcript_context_item_id=transcript_context_item_id,
        )
        section = _derive_section(norm, soap_sections)
        claims.append(
            {
                "id": f"claim-{len(claims) + 1}",
                "text": _clean_claim_text(entity.text),
                "section": section,
                "confidence": 1.0 if evidence else 0.0,
                "status": "verified" if evidence else "unverified",
                "evidence": [evidence] if evidence else [],
                "entityRefs": [],
                "knowledgeChunkIds": list(section_cited.get(section, [])),
            }
        )

    return {"claims": claims}
