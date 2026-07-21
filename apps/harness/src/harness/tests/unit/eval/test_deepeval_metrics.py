"""DeepEval metric-wrapper tests.

The wrappers must:

* expose the four DeepEval metrics the harness needs (Faithfulness,
  Hallucination, Summarization, GEval), each pre-wired to our **model-agnostic**
  JudgeClient (so DeepEval scores against LM Studio / Azure / Bedrock exactly
  like the PDSQI-9 judge — no second model configuration), and
* convert a :class:`GoldenCase` into a DeepEval ``LLMTestCase``.

These tests stay offline: they only assert *construction/wiring* and exercise
the model adapter against a stub. Live ``.measure()`` scoring needs a real
endpoint and is a CI/integration concern, not a unit test.

``deepeval`` is an optional ``[eval]`` extra; skip cleanly when it's absent.
"""

from __future__ import annotations

import pytest

pytest.importorskip("deepeval")

from harness.eval.metrics.deepeval_metrics import (  # noqa: E402
    build_deepeval_model,
    build_faithfulness_metric,
    build_geval_metric,
    build_hallucination_metric,
    build_summarization_metric,
    to_llm_test_case,
)
from harness.eval.models import GoldenCase  # noqa: E402

from ._stubs import StubJudgeClient, pdsqi_score_json  # noqa: E402


def _case() -> GoldenCase:
    return GoldenCase(
        case_id="d-1",
        source_documents=["BP 120/80.", "Started lisinopril 10 mg daily for hypertension."],
        generated_note="Patient has hypertension; started lisinopril 10 mg daily.",
        contexts=["transcript turn 1", "transcript turn 2"],
    )


class TestModelAdapter:
    @pytest.mark.asyncio
    async def test_a_generate_delegates_to_judge_client(self):
        client = StubJudgeClient("hello-from-judge", model="local-14b")
        model = build_deepeval_model(client)

        assert model.load_model() is client
        assert "local-14b" in model.get_model_name()
        assert await model.a_generate("ping") == "hello-from-judge"
        assert client.calls, "judge client should have been invoked"

    def test_sync_generate_delegates_to_judge_client(self):
        client = StubJudgeClient("sync-out", model="m")
        model = build_deepeval_model(client)
        assert model.generate("ping") == "sync-out"


class TestMetricBuilders:
    def test_faithfulness_metric_wired_to_judge(self):
        client = StubJudgeClient(pdsqi_score_json(), model="local-14b")
        metric = build_faithfulness_metric(threshold=0.9, model=client)
        assert type(metric).__name__ == "FaithfulnessMetric"
        assert metric.threshold == 0.9
        assert "local-14b" in metric.evaluation_model

    def test_hallucination_metric_wired_to_judge(self):
        client = StubJudgeClient(pdsqi_score_json(), model="local-14b")
        metric = build_hallucination_metric(threshold=0.3, model=client)
        assert type(metric).__name__ == "HallucinationMetric"
        assert metric.threshold == 0.3
        assert "local-14b" in metric.evaluation_model

    def test_summarization_metric_wired_to_judge(self):
        client = StubJudgeClient(pdsqi_score_json(), model="local-14b")
        metric = build_summarization_metric(threshold=0.6, n=3, model=client)
        assert type(metric).__name__ == "SummarizationMetric"
        assert metric.threshold == 0.6
        assert metric.n == 3
        assert "local-14b" in metric.evaluation_model

    def test_geval_metric_wired_to_judge(self):
        client = StubJudgeClient(pdsqi_score_json(), model="local-14b")
        metric = build_geval_metric(threshold=0.7, model=client)
        assert type(metric).__name__ == "GEval"
        assert metric.threshold == 0.7
        assert metric.name  # default clinical-faithfulness name
        assert metric.evaluation_params  # non-empty
        assert "local-14b" in metric.evaluation_model

    def test_geval_accepts_custom_name_and_criteria(self):
        client = StubJudgeClient(pdsqi_score_json(), model="m")
        metric = build_geval_metric(
            name="Clinical Safety", criteria="No fabricated medications.", model=client
        )
        assert metric.name == "Clinical Safety"


class TestTestCaseMapping:
    def test_to_llm_test_case_maps_fields(self):
        case = _case()
        tc = to_llm_test_case(case)
        assert case.generated_note == tc.actual_output
        # faithfulness uses retrieval_context; hallucination uses context.
        assert tc.retrieval_context == case.faithfulness_contexts()
        assert tc.context == case.faithfulness_contexts()
        # input carries the grounding source text.
        assert "lisinopril" in tc.input

    def test_to_llm_test_case_actual_output_override(self):
        tc = to_llm_test_case(_case(), actual_output="OVERRIDDEN")
        assert tc.actual_output == "OVERRIDDEN"
