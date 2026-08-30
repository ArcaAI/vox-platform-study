"""TASK-830 — the peer client reads the new `scores` field, additively.

`classify()` keeps its exact signature and return shape: `safety_analyzer`'s
`analyze_content` and `services/screening.py` both parse it as
`str | list[str]`, and neither needs a number. `classify_scored()` is the new
seam, and it is ONE call — the confidences ride along with the labels rather
than costing a second inference pass.
"""

from __future__ import annotations

import httpx
import pytest

from guardrail.services.external_nlp_client import ClassifiedTasks, NlpGuardClient

TENANT = "11111111-1111-1111-1111-111111111111"
TASKS = {"prompt_safety": {"labels": ["safe", "unsafe"]}}


def _client(payload: dict) -> NlpGuardClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return NlpGuardClient(
        base_url="http://nlp.invalid",
        service_token="t",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        tenant_id=TENANT,
        model_id="a-guard-model",
    )


async def test_classify_scored_returns_labels_and_confidences() -> None:
    client = _client(
        {
            "results": {"prompt_safety": "unsafe"},
            "scores": {"prompt_safety": {"unsafe": 0.93}},
            "model_version": "a-guard-model",
        }
    )
    answer = await client.classify_scored(TASKS, "text")
    assert answer == ClassifiedTasks(
        labels={"prompt_safety": "unsafe"}, scores={"prompt_safety": {"unsafe": 0.93}}
    )


async def test_classify_still_returns_labels_alone() -> None:
    """The three existing call sites are untouched by the contract change."""
    client = _client(
        {
            "results": {"prompt_safety": "unsafe"},
            "scores": {"prompt_safety": {"unsafe": 0.93}},
            "model_version": "a-guard-model",
        }
    )
    assert await client.classify(TASKS, "text") == {"prompt_safety": "unsafe"}


async def test_a_peer_that_sends_no_scores_yields_empty_scores_never_zeros() -> None:
    """An unscored peer must not be papered over with fabricated 0.0s."""
    client = _client({"results": {"prompt_safety": "safe"}, "model_version": "m"})
    answer = await client.classify_scored(TASKS, "text")
    assert answer.labels == {"prompt_safety": "safe"}
    assert answer.scores == {}


async def test_a_malformed_scores_blob_is_dropped_rather_than_coerced() -> None:
    """A score that is not a number must never become one a caller thresholds on."""
    client = _client(
        {
            "results": {"prompt_safety": "safe"},
            "scores": {"prompt_safety": {"safe": "very sure"}},
            "model_version": "m",
        }
    )
    answer = await client.classify_scored(TASKS, "text")
    assert answer.labels == {"prompt_safety": "safe"}
    assert answer.scores == {}


async def test_the_analyzer_exposes_the_scored_seam() -> None:
    from guardrail.services.safety_analyzer import SafetyAnalyzer, SafetyPolicy

    class Stub:
        model_id = "m"

        async def classify_scored(self, tasks, text):  # noqa: ANN001, ANN201
            return ClassifiedTasks(
                labels={"prompt_safety": "safe"}, scores={"prompt_safety": {"safe": 0.8}}
            )

    policy = SafetyPolicy(
        tasks={"prompt_safety": {"labels": ["safe", "unsafe"]}},
        benign_labels=frozenset({"safe"}),
    )
    analyzer = SafetyAnalyzer(policy, safety_client=Stub())  # type: ignore[arg-type]
    answer = await analyzer.classify_tasks_scored(("prompt_safety",), "text")
    assert answer.scores == {"prompt_safety": {"safe": 0.8}}


async def test_the_scored_seam_fails_closed_with_no_model() -> None:
    from guardrail.core.errors import GuardrailUndeterminedError
    from guardrail.services.safety_analyzer import SafetyAnalyzer, SafetyPolicy

    analyzer = SafetyAnalyzer(
        SafetyPolicy(
            tasks={"prompt_safety": {"labels": ["safe"]}}, benign_labels=frozenset({"safe"})
        ),
        safety_client=None,
    )
    with pytest.raises(GuardrailUndeterminedError):
        await analyzer.classify_tasks_scored(("prompt_safety",), "text")
