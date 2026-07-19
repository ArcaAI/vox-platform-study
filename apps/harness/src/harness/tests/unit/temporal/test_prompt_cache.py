"""TASK-515 Phase 4D.1 — harness generation-prompt prefix stability.

TASK-519 — segment StrictCitations (``[[seg:<id>]]``) on the finalize path.
"""

from __future__ import annotations

from harness.temporal.models import SegmentCitationRef
from harness.temporal.prompt_cache import (
    assemble_generation_prompt,
    build_segment_citations_block,
    extract_cited_segment_ids,
)

_SEG_A = "11111111-1111-1111-1111-111111111111"
_SEG_B = "22222222-2222-2222-2222-222222222222"


def _segment_refs() -> list[SegmentCitationRef]:
    return [
        SegmentCitationRef(id=_SEG_A, speaker="CLINICIAN", t0_ms=0, t1_ms=1200, idx=0),
        SegmentCitationRef(id=_SEG_B, speaker="PATIENT", t0_ms=1200, t1_ms=3400, idx=1),
    ]


def test_prefix_is_byte_stable_across_regens_given_constant_inputs() -> None:
    """Two consecutive regen iterations with the same inputs assemble the
    identical prompt (a byte-stable prefix the engine can cache-reuse)."""
    user_prompt = "TEMPLATE\n\nTranscript:\npatient reports cough"
    prompt_block = "KNOWLEDGE CONTEXT\n[1] id=abc: guideline text"

    first = assemble_generation_prompt(user_prompt, prompt_block)
    second = assemble_generation_prompt(user_prompt, prompt_block)

    assert first == second
    # The invariant template+transcript leads as the stable prefix.
    assert first.startswith(user_prompt)
    # RAG StrictCitations block is appended after the stable prefix.
    assert prompt_block in first
    assert first.index(prompt_block) > first.index("Transcript:")


def test_no_rag_block_is_byte_identical_to_bare_user_prompt() -> None:
    """The non-RAG path leaves the user prompt untouched (replay byte-parity)."""
    user_prompt = "TEMPLATE\n\nTranscript:\npatient reports cough"
    assert assemble_generation_prompt(user_prompt, None) == user_prompt
    assert assemble_generation_prompt(user_prompt, "") == user_prompt


class TestSegmentCitationsBlock:
    def test_empty_refs_render_no_block(self) -> None:
        assert build_segment_citations_block([]) == ""

    def test_block_instructs_seg_marker_and_lists_allowed_ids(self) -> None:
        block = build_segment_citations_block(_segment_refs())
        assert "[[seg:" in block
        assert f"[[seg:{_SEG_A}]]" in block or _SEG_A in block
        assert _SEG_B in block
        # PHI posture: structural hints only — no segment plaintext body.
        assert "cough" not in block.lower()
        assert "reports" not in block.lower()

    def test_block_carries_speaker_time_hints(self) -> None:
        block = build_segment_citations_block(_segment_refs())
        assert "CLINICIAN" in block
        assert "PATIENT" in block
        assert "0" in block and "1200" in block


class TestExtractCitedSegmentIds:
    def test_parses_markers_filtered_to_allowed_ids(self) -> None:
        text = (
            f"BP elevated [[seg:{_SEG_A}]] and cough [[seg:{_SEG_B}]] "
            "and hallucinated [[seg:99999999-9999-9999-9999-999999999999]]."
        )
        assert extract_cited_segment_ids(text, {_SEG_A, _SEG_B}) == [_SEG_A, _SEG_B]

    def test_dedupes_preserving_order(self) -> None:
        text = f"[[seg:{_SEG_B}]] then [[seg:{_SEG_A}]] then [[seg:{_SEG_B}]]"
        assert extract_cited_segment_ids(text, {_SEG_A, _SEG_B}) == [_SEG_B, _SEG_A]

    def test_no_markers_returns_empty(self) -> None:
        assert extract_cited_segment_ids("plain note", {_SEG_A}) == []


class TestAssembleWithSegmentBlock:
    def test_segment_ids_fold_instruction_and_allowed_list_into_prompt(self) -> None:
        user_prompt = "TEMPLATE\n\nTranscript:\npatient reports cough"
        segment_block = build_segment_citations_block(_segment_refs())
        assembled = assemble_generation_prompt(user_prompt, None, segment_block=segment_block)
        assert assembled.startswith(user_prompt)
        assert "[[seg:" in assembled
        assert _SEG_A in assembled and _SEG_B in assembled

    def test_segment_block_appends_after_rag_before_regen_suffix(self) -> None:
        from harness.sensors.base import SensorResult
        from harness.temporal.prompt_cache import build_regen_feedback

        seg = build_segment_citations_block(_segment_refs())
        fb = build_regen_feedback(
            [SensorResult(name="numeric_dose", score=0.0, passed=False, claims_flagged=["x"])],
            enabled=True,
        )
        assembled = assemble_generation_prompt("USER", "KB_BLOCK", regen_feedback=fb, segment_block=seg)
        assert assembled.index("KB_BLOCK") < assembled.index("[[seg:")
        assert assembled.index(_SEG_A) < assembled.index("numeric_dose")

    def test_absent_segments_byte_identical_to_before(self) -> None:
        base = assemble_generation_prompt("USER", "KB")
        assert assemble_generation_prompt("USER", "KB", segment_block=None) == base
        assert assemble_generation_prompt("USER", "KB", segment_block="") == base
