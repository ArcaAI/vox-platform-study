"""Prefix-cache-friendly prompt assembly (TASK-515 Phase 4D.1).

The harness ``generate`` activity folds the RAG ``StrictCitations`` block into
the assembled user prompt. This helper makes that concatenation an explicit,
pure function so the ordering is a tested contract: the invariant blocks
(prompt template + transcript, carried in ``user_prompt``; then the RAG
StrictCitations block; then the optional TASK-519 segment StrictCitations
block) form a **stable prefix** that is byte-identical across regen iterations
given constant inputs — letting a prefix-cache engine (vLLM / llama.cpp
``cache_prompt``) reuse the KV cache of that prefix across the bounded regen
loop instead of re-prefilling it each iteration.

The output is byte-identical to the previous inline concatenation when the
optional blocks are absent, so the change is command-neutral for Temporal replay.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TYPE_CHECKING

from harness.sensors.base import dedupe

if TYPE_CHECKING:
    from harness.sensors.base import SensorResult
    from harness.temporal.models import RegenFeedback, SegmentCitationRef


# TASK-517 — the corrective-retry preamble prepended to the structured findings
# block on a regen iteration. Mirrors the intent of the seeded ``CORRECTIVE_RETRY``
# prompt template (07-prompt-template.ts) but is sensor-findings-driven: it tells
# the model the previous draft failed specific safety sensors and must be revised.
CORRECTIVE_RETRY_PREAMBLE = (
    "REVISE STRICTLY — the previous draft FAILED the following automated clinical "
    "safety checks. Fix EACH issue below without introducing new content, keep the "
    "same output format, and do not restate unaffected sections incorrectly:"
)

# Per-sensor corrective instruction. A sensor absent here falls back to a generic
# fix so a newly added sensor still yields actionable feedback.
_EXPECTED_FIX: dict[str, str] = {
    "numeric_dose": (
        "Every medication dose MUST match the transcript exactly — value, unit, "
        "route, and frequency. Correct or remove any dose not stated by the clinician."
    ),
    "entity_faithfulness": (
        "Remove any clinical entity (medication/condition/procedure) not grounded in "
        "the transcript; do not fabricate findings."
    ),
    "coverage_omission": (
        "Include the clinically salient facts from the transcript that were omitted."
    ),
    "schema_validity": (
        "Return a single valid JSON object matching the required schema exactly."
    ),
    "citation_verify": (
        "Ensure each claim is supported by its cited evidence; drop unsupported claims."
    ),
    "atomic_fact": (
        "Ensure each atomic factual statement is directly supported by the transcript."
    ),
}
_GENERIC_FIX = "Revise the flagged content so it is faithful to and grounded in the transcript."

# TASK-519 — segment StrictCitations marker (mirrors RAG ``[[kb:<id>]]``).
SEGMENT_CITATION_MARKER_RE = re.compile(r"\[\[seg:([^\]]+)\]\]")

_SEGMENT_INSTRUCTION = (
    "TRANSCRIPT SEGMENTS — diarized turns from the consultation. When a statement "
    "in the note is grounded in a turn below, you MUST cite it inline, immediately "
    "after that statement, using the exact marker [[seg:<id>]] with the segment's "
    "id (e.g. [[seg:{example}]]). Cite only segments that genuinely support the "
    "statement; never invent an id, and never cite an id that is not listed below."
)


def build_segment_citations_block(segments: Iterable[SegmentCitationRef]) -> str:
    """Render transcript-segment refs as a StrictCitations block (TASK-519).

    PHI-safe: each line carries ``id`` plus optional speaker/time/ordinal hints —
    never segment plaintext (recoverable from the parent transcript via offsets).
    Returns ``""`` when there is nothing to cite so the caller can omit the block.
    """
    items = list(segments)
    if not items:
        return ""
    example_id = items[0].id
    lines = [_SEGMENT_INSTRUCTION.format(example=example_id), ""]
    for i, seg in enumerate(items, start=1):
        parts = [f"[{i}] id={seg.id}"]
        if seg.idx is not None:
            parts.append(f"idx={seg.idx}")
        if seg.speaker:
            parts.append(f"speaker={seg.speaker}")
        if seg.t0_ms is not None or seg.t1_ms is not None:
            t0 = seg.t0_ms if seg.t0_ms is not None else "?"
            t1 = seg.t1_ms if seg.t1_ms is not None else "?"
            parts.append(f"t={t0}-{t1}ms")
        lines.append(" ".join(parts))
    return "\n".join(lines)


def extract_cited_segment_ids(text: str, allowed: set[str]) -> list[str]:
    """Parse ``[[seg:<id>]]`` markers from ``text``, keeping only ``allowed`` ids.

    Mirrors :func:`harness.guides.retrieval.prompt.extract_cited_ids` for the
    segment marker — hallucinated ids never survive.
    """
    if not text:
        return []
    found = (m.group(1).strip() for m in SEGMENT_CITATION_MARKER_RE.finditer(text))
    return dedupe(cid for cid in found if cid in allowed)


def assemble_generation_prompt(
    user_prompt: str,
    prompt_block: str | None,
    regen_feedback: RegenFeedback | None = None,
    *,
    segment_block: str | None = None,
) -> str:
    """Assemble the final generation prompt in a stable prefix ordering.

    ``user_prompt`` (prompt template + transcript, both invariant across a run's
    regen iterations) leads as the stable, cacheable prefix; the RAG
    StrictCitations ``prompt_block`` — also invariant across regens for constant
    retrieved chunks — is appended; then the optional TASK-519 segment
    StrictCitations ``segment_block`` (invariant for constant segment refs).
    Returns ``user_prompt`` unchanged when there is no RAG/segment block so the
    non-citation path is byte-identical to before.

    TASK-517 — on a regen iteration a ``regen_feedback`` critique is appended as a
    STRICTLY TRAILING corrective suffix (the stable prefix is preserved verbatim so
    the KV-cache prefix is unaffected). ``None`` (every first iteration + the
    disabled path) ⇒ byte-identical to before.
    """
    prompt = user_prompt
    if prompt_block:
        prompt = f"{prompt}\n\n{prompt_block}"
    if segment_block:
        prompt = f"{prompt}\n\n{segment_block}"
    if regen_feedback is not None:
        suffix = render_regen_feedback_block(regen_feedback)
        if suffix:
            prompt = f"{prompt}\n\n{suffix}"
    return prompt


def build_regen_feedback(
    results: list[SensorResult],
    *,
    enabled: bool,
) -> RegenFeedback | None:
    """Turn the prior iteration's sensor results into a regen critique.

    Collects ONLY the failed sensors, carrying each one's flagged claims and a
    per-sensor expected-fix instruction. Returns ``None`` when disabled (policy
    ``regenFeedbackEnabled`` off) or when nothing failed — in both cases the regen
    prompt stays byte-identical to the no-feedback path.
    """
    if not enabled:
        return None
    # Imported lazily so the pure module carries no import-time model dependency.
    from harness.temporal.models import RegenFeedback, RegenFinding

    findings = [
        RegenFinding(
            sensor=r.name,
            failing_claims=list(r.claims_flagged),
            expected_fix=_EXPECTED_FIX.get(r.name, _GENERIC_FIX),
        )
        for r in results
        if not r.passed
    ]
    if not findings:
        return None
    return RegenFeedback(findings=findings)


def render_regen_feedback_block(regen_feedback: RegenFeedback) -> str:
    """Render a :class:`RegenFeedback` into the corrective prompt suffix text.

    Empty findings ⇒ empty string (no suffix). Otherwise: the corrective preamble
    followed by one numbered finding per failed sensor (name, expected fix, and
    the specific flagged claims when present).
    """
    findings = regen_feedback.findings
    if not findings:
        return ""
    lines = [CORRECTIVE_RETRY_PREAMBLE]
    for i, finding in enumerate(findings, start=1):
        lines.append(f"{i}. [{finding.sensor}] {finding.expected_fix}")
        if finding.failing_claims:
            for claim in finding.failing_claims:
                lines.append(f"   - {claim}")
    return "\n".join(lines)
