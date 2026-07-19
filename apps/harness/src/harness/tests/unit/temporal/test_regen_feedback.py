"""TASK-517 — critique-informed regen feedback (RED-first).

The bounded regen loop currently re-runs generation with the SAME prompt after a
sensor REGEN verdict — the model gets no signal about *what* failed, so it tends
to reproduce the same error. This pins the pure helpers that turn the prior
iteration's failed-sensor results into a structured, model-readable corrective
block appended to the regen prompt:

  * ``build_regen_feedback`` — SensorResult[] → RegenFeedback (failed sensors
    only; carries names + failing claims + a per-sensor expected fix). Gated:
    returns None when disabled or when nothing failed.
  * ``render_regen_feedback_block`` — RegenFeedback → the prompt suffix text
    (seeded CORRECTIVE_RETRY preamble + a structured findings block).
  * ``assemble_generation_prompt`` stays byte-identical when no feedback.
"""

from __future__ import annotations

from harness.sensors.base import SensorResult
from harness.temporal.models import RegenFeedback
from harness.temporal.prompt_cache import (
    assemble_generation_prompt,
    build_regen_feedback,
    render_regen_feedback_block,
)


def _fail(name: str, claims: list[str]) -> SensorResult:
    return SensorResult(name=name, score=0.0, passed=False, claims_flagged=claims)


def _pass(name: str) -> SensorResult:
    return SensorResult(name=name, score=1.0, passed=True)


class TestBuildRegenFeedback:
    def test_collects_only_failed_sensors_with_claims_and_expected_fix(self):
        results = [
            _pass("schema_validity"),
            _fail("numeric_dose", ["lisinopril 100 mg"]),
        ]
        fb = build_regen_feedback(results, enabled=True)
        assert isinstance(fb, RegenFeedback)
        assert [f.sensor for f in fb.findings] == ["numeric_dose"]
        finding = fb.findings[0]
        assert finding.failing_claims == ["lisinopril 100 mg"]
        assert finding.expected_fix  # a non-empty, sensor-specific instruction

    def test_returns_none_when_disabled(self):
        results = [_fail("numeric_dose", ["x"])]
        assert build_regen_feedback(results, enabled=False) is None

    def test_returns_none_when_nothing_failed(self):
        assert build_regen_feedback([_pass("schema_validity")], enabled=True) is None


class TestRenderRegenFeedbackBlock:
    def test_block_names_the_failed_sensor_and_its_claims(self):
        fb = build_regen_feedback([_fail("numeric_dose", ["lisinopril 100 mg"])], enabled=True)
        assert fb is not None
        block = render_regen_feedback_block(fb)
        assert "numeric_dose" in block
        assert "lisinopril 100 mg" in block
        # The seeded corrective preamble is present (revise-strictly instruction).
        assert "REVISE" in block.upper()

    def test_empty_feedback_renders_empty_string(self):
        assert render_regen_feedback_block(RegenFeedback(findings=[])) == ""


class TestAssembleGenerationPromptRegen:
    def test_appends_feedback_suffix_after_the_stable_prefix(self):
        fb = build_regen_feedback([_fail("numeric_dose", ["lisinopril 100 mg"])], enabled=True)
        base = assemble_generation_prompt("USER_PROMPT", "KB_BLOCK")
        with_fb = assemble_generation_prompt("USER_PROMPT", "KB_BLOCK", regen_feedback=fb)
        # The stable prefix is preserved verbatim; feedback is strictly appended.
        assert with_fb.startswith(base)
        assert "numeric_dose" in with_fb

    def test_no_feedback_is_byte_identical_to_before(self):
        assert assemble_generation_prompt("U", "B") == assemble_generation_prompt("U", "B", regen_feedback=None)
        assert assemble_generation_prompt("U", None) == "U"
