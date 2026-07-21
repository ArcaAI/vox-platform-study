"""Calibration-lever tests.

Two levers raise the eval gate honestly:

* **Lever 1 (golden-set lanes):** a ``role`` field splits cases into a
  ``quality`` lane (good reference notes -> PDSQI quality + faithfulness gate)
  and a ``calibration`` lane (range-spanning/adversarial notes -> judge<->label
  ICC ONLY). The quality aggregates must EXCLUDE calibration cases, and
  faithfulness must not be wasted on the calibration lane.
* **Lever 2 (judge calibration):** an opt-in anchored rubric prompt, deterministic
  decoding (seed) and multi-sample self-consistency (median aggregation) reduce
  judge variance and raise agreement.

All deterministic and offline (stub judge clients) — no live LLM.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.eval.config import JudgeConfig
from harness.eval.golden import GoldenSetRunner
from harness.eval.judge import OutputMode, PDSQI9Judge, resolve_prompt
from harness.eval.judge.base import JudgeConnectionError, JudgeParseError
from harness.eval.judge.pdsqi import aggregate_scores
from harness.eval.metrics.faithfulness import FaithfulnessEvaluator
from harness.eval.models import GoldenCase, GoldenSet, PDSQIScore

from ._stubs import (
    ScriptedJudgeClient,
    StubClaimExtractor,
    StubClaimVerifier,
    StubJudgeClient,
    pdsqi_score_json,
)


def _score(**over: int) -> PDSQIScore:
    base: dict[str, Any] = {
        "citation": 4, "accurate": 5, "thorough": 4, "useful": 5, "organized": 4,
        "comprehensible": 5, "succinct": 4, "synthesized": 4,
        "abstraction": 1, "voice_summ": 0, "voice_note": 0,
    }
    base.update(over)
    return PDSQIScore(**base)


def _mixed_lane_set() -> GoldenSet:
    return GoldenSet(
        version="lanes-v1",
        cases=[
            GoldenCase(
                case_id="good",
                role="quality",
                source_documents=["cough, afebrile, viral URI, supportive care"],
                generated_note="Viral URI, supportive care. <Note ID:1>",
            ),
            GoldenCase(
                case_id="bad",
                role="calibration",
                source_documents=["normal ECG, troponin pending"],
                generated_note="Acute MI confirmed. <Note ID:1>",
            ),
        ],
    )


class TestGoldenCaseRole:
    def test_role_defaults_to_quality(self):
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n")
        assert case.role == "quality"

    def test_role_rejects_unknown_value(self):
        with pytest.raises(ValueError):
            GoldenCase(
                case_id="c", source_documents=["s"], generated_note="n", role="bogus"
            )


class TestRoleAwareAggregation:
    @pytest.mark.asyncio
    async def test_quality_aggregates_exclude_calibration_lane(self):
        # calibration case scores low; it must not drag the quality mean down.
        def respond(messages):  # noqa: ANN001
            blob = " ".join(m["content"] for m in messages)
            return pdsqi_score_json(accurate=1, thorough=1) if "Acute MI" in blob else pdsqi_score_json()

        judge = PDSQI9Judge(StubJudgeClient(respond), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge)
        result = await runner.run(_mixed_lane_set())

        # both cases scored (calibration still needs a judge score for ICC)...
        assert len(result.case_results) == 2
        assert all(cr.pdsqi is not None for cr in result.case_results)
        # ...but the quality aggregate reflects ONLY the quality lane.
        assert result.aggregates["pdsqi_accurate"] == pytest.approx(5.0)
        assert result.aggregates["pdsqi_thorough"] == pytest.approx(4.0)

    @pytest.mark.asyncio
    async def test_runner_tolerates_unparseable_case_and_drops_it(self):
        # a flaky judge emits garbage (no JSON) for the calibration case; the run
        # must still complete with the good case scored and the bad case dropped.
        def respond(messages):  # noqa: ANN001
            blob = " ".join(m["content"] for m in messages)
            return "the model rambled with no json" if "Acute MI" in blob else pdsqi_score_json()

        judge = PDSQI9Judge(StubJudgeClient(respond), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge)  # tolerate_judge_errors defaults True
        result = await runner.run(_mixed_lane_set())

        by_id = {cr.case_id: cr for cr in result.case_results}
        assert by_id["good"].pdsqi is not None
        assert by_id["bad"].pdsqi is None  # unparseable -> dropped, not a crash
        assert result.aggregates["pdsqi_accurate"] == pytest.approx(5.0)

    @pytest.mark.asyncio
    async def test_runner_can_be_strict_about_judge_errors(self):
        def respond(messages):  # noqa: ANN001
            return "no json at all"

        judge = PDSQI9Judge(StubJudgeClient(respond), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge, tolerate_judge_errors=False)
        with pytest.raises(JudgeParseError):
            await runner.run(_mixed_lane_set())

    @pytest.mark.asyncio
    async def test_runner_does_not_tolerate_backend_connection_errors(self):
        # An infra failure (model unreachable / failed to load) must abort the run
        # even with tolerance on — a broken backend must never yield a green gate
        # built from zero scored cases.
        class _DownClient:
            model = "down"

            async def complete(self, messages, *, json_mode=False, temperature=None, seed=None):  # noqa: ANN001
                raise JudgeConnectionError("openai_compat judge call failed: 400 model load")

        judge = PDSQI9Judge(_DownClient(), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge)  # tolerate_judge_errors defaults True
        with pytest.raises(JudgeConnectionError):
            await runner.run(_mixed_lane_set())

    @pytest.mark.asyncio
    async def test_faithfulness_runs_quality_lane_only(self):
        judge = PDSQI9Judge(StubJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE)
        faithfulness = FaithfulnessEvaluator(
            StubClaimExtractor(["c1", "c2"]), StubClaimVerifier({"c1"})
        )
        runner = GoldenSetRunner(judge=judge, faithfulness=faithfulness)
        result = await runner.run(_mixed_lane_set())

        by_id = {cr.case_id: cr for cr in result.case_results}
        assert by_id["good"].faithfulness is not None
        assert by_id["bad"].faithfulness is None  # calibration lane skipped
        # aggregate is the quality-lane faithfulness only (1 supported / 2 claims).
        assert result.aggregates["faithfulness"] == pytest.approx(0.5)


class TestAnchoredPrompt:
    def test_anchored_adds_calibration_guidance(self):
        notes = ["cough x3d, afebrile"]
        plain = resolve_prompt(notes, "summary", "Family Medicine", OutputMode.SCORE)
        anchored = resolve_prompt(
            notes, "summary", "Family Medicine", OutputMode.SCORE, anchored=True
        )
        plain_user = plain[1]["content"]
        anchored_user = anchored[1]["content"]
        assert anchored_user != plain_user
        assert "CALIBRATION" in anchored_user.upper()
        # the verbatim Epic rubric is still present (instrument preserved).
        assert "RUBRIC_SET" in anchored_user

    def test_default_prompt_is_not_anchored(self):
        notes = ["cough x3d"]
        user = resolve_prompt(notes, "s", "Family Medicine", OutputMode.SCORE)[1]["content"]
        assert "CALIBRATION EXAMPLES" not in user.upper()


class TestReasoningMode:
    """``reasoning_mode`` lever (default "auto"): "auto" is a neutral base that
    neither forces nor forbids reasoning (safe for non-reasoning families like
    Gemma 3 / MedGemma); "think" elicits an explicit <think> pass for Qwen-style
    models; "none" (== ``suppress_reasoning=True``) forbids it (JSON-only)."""

    def _system(self, **kwargs) -> str:  # noqa: ANN003
        return resolve_prompt(
            ["cough x3d, afebrile"], "summary", "Family Medicine", OutputMode.SCORE, **kwargs
        )[0]["content"]

    def test_auto_is_neutral_and_does_not_inject_think(self):
        # DEFAULT: must NOT tell the model to emit a <think> block (would break
        # non-reasoning Gemma 3 / MedGemma) and must NOT forbid reasoning either.
        system = self._system()
        assert "<think>" not in system
        assert "/no_think" not in system

    def test_think_mode_elicits_think_block(self):
        system = self._system(reasoning_mode="think")
        assert "<think>" in system
        assert "/no_think" not in system

    def test_none_mode_forbids_reasoning(self):
        system = self._system(reasoning_mode="none")
        assert "/no_think" in system
        assert "<think>" in system  # explicitly names the block it forbids
        assert "analysis channel" in system.lower()  # also forbids the harmony channel

    def test_suppress_reasoning_is_equivalent_to_none(self):
        assert self._system(suppress_reasoning=True) == self._system(reasoning_mode="none")

    def test_reasoning_mode_only_affects_system_message(self):
        notes = ["cough x3d, afebrile"]
        plain = resolve_prompt(notes, "summary", "Family Medicine", OutputMode.SCORE)
        for mode in ("think", "none"):
            variant = resolve_prompt(
                notes, "summary", "Family Medicine", OutputMode.SCORE, reasoning_mode=mode
            )
            # the system message changes, the user message (rubric + case) does not.
            assert variant[0]["content"] != plain[0]["content"]
            assert variant[1]["content"] == plain[1]["content"]

    @pytest.mark.asyncio
    async def test_judge_passes_suppress_reasoning_into_prompt(self):
        client = StubJudgeClient(pdsqi_score_json())
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE, suppress_reasoning=True)
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n <Note ID:1>")
        await judge.score(case)
        assert "/no_think" in client.calls[0][0]["content"]  # system message of the one call

    @pytest.mark.asyncio
    async def test_judge_passes_reasoning_mode_into_prompt(self):
        client = StubJudgeClient(pdsqi_score_json())
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE, reasoning_mode="think")
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n <Note ID:1>")
        await judge.score(case)
        assert "<think>" in client.calls[0][0]["content"]  # think directive reached the prompt


class TestSelfConsistencyAggregation:
    def test_aggregate_scores_takes_per_dimension_median(self):
        scores = [
            _score(thorough=2, accurate=5, organized=3),
            _score(thorough=4, accurate=5, organized=5),
            _score(thorough=4, accurate=4, organized=5),
        ]
        agg = aggregate_scores(scores)
        assert agg.thorough == 4   # median(2,4,4)
        assert agg.accurate == 5   # median(5,5,4)
        assert agg.organized == 5  # median(3,5,5)

    def test_aggregate_single_score_is_identity(self):
        s = _score()
        assert aggregate_scores([s]) is s

    def test_aggregate_handles_synthesized_na_majority(self):
        scores = [_score(synthesized=None), _score(synthesized=None), _score(synthesized=4)]
        agg = aggregate_scores(scores)
        assert agg.synthesized is None  # NA is the majority

    @pytest.mark.asyncio
    async def test_judge_self_consistency_samples_k_times_and_aggregates(self):
        client = ScriptedJudgeClient(
            [
                pdsqi_score_json(thorough=2),
                pdsqi_score_json(thorough=4),
                pdsqi_score_json(thorough=4),
            ]
        )
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE, self_consistency=3)
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n <Note ID:1>")
        result = await judge.score(case)
        assert len(client.calls) == 3
        assert result.score.thorough == 4  # median of the three samples


class TestSelfConsistencySeed:
    """A fixed seed must NOT be reused across the K samples (that would make them
    identical and defeat self-consistency). Each sample gets ``seed + i``."""

    @pytest.mark.asyncio
    async def test_seed_varies_per_sample(self):
        client = ScriptedJudgeClient([pdsqi_score_json() for _ in range(3)])
        judge = PDSQI9Judge(
            client, output_mode=OutputMode.SCORE, self_consistency=3, seed=7
        )
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n <Note ID:1>")
        await judge.score(case)
        assert client.seeds == [7, 8, 9]
        # all diversity samples use the self-consistency temperature.
        assert all(t == pytest.approx(judge._sc_temperature) for t in client.temperatures)

    @pytest.mark.asyncio
    async def test_seed_none_stays_none_for_random_sampling(self):
        client = ScriptedJudgeClient([pdsqi_score_json() for _ in range(3)])
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE, self_consistency=3)
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n <Note ID:1>")
        await judge.score(case)
        assert client.seeds == [None, None, None]

    @pytest.mark.asyncio
    async def test_single_pass_uses_base_seed_deterministically(self):
        client = ScriptedJudgeClient([pdsqi_score_json()])
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE, seed=7)
        case = GoldenCase(case_id="c", source_documents=["s"], generated_note="n <Note ID:1>")
        await judge.score(case)
        assert client.seeds == [7]
        assert client.temperatures == [None]  # K=1 keeps the configured temperature


class TestJudgeConfigKnobs:
    def test_calibration_knob_defaults(self):
        cfg = JudgeConfig()
        assert cfg.anchored is False
        assert cfg.self_consistency == 1
        assert cfg.seed is None
        assert cfg.output_mode == "with_explanation"
        assert cfg.suppress_reasoning is False

    def test_output_mode_maps_to_enum(self):
        # the ci wiring converts the config string into the judge's OutputMode enum.
        assert OutputMode("with_explanation") is OutputMode.WITH_EXPLANATION
        assert OutputMode("score") is OutputMode.SCORE
