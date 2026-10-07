"""TASK-1050 W2a3 / TASK-1049 R1 — the `SafetyAnalyzer` routing seam, beneath the screener.

The legacy `/guardrail/analyze` path and the realtime plane call the analyzer directly,
so `jailbreak_detection` must route there too. Stub clients only.
"""

from __future__ import annotations

from typing import Any

import pytest

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.external_nlp_client import ClassifiedTasks
from guardrail.services.safety_analyzer import InjectionRoute, SafetyAnalyzer, SafetyPolicy

PG2_SPEC = {"labels": ["BENIGN", "MALICIOUS"], "multi_label": False}


class _Client:
    def __init__(self, model_id: str, answer: dict[str, Any]) -> None:
        self.model_id = model_id
        self.answer = answer
        self.asked: list[dict[str, Any]] = []
        self.last_usage_detail = None

    async def classify(self, tasks: dict[str, Any], text: str) -> dict[str, Any]:
        self.asked.append(tasks)
        return {name: self.answer[name] for name in tasks}

    async def classify_scored(self, tasks: dict[str, Any], text: str) -> ClassifiedTasks:
        return ClassifiedTasks(labels=await self.classify(tasks, text), scores={})


def _analyzer(route: InjectionRoute | None) -> tuple[SafetyAnalyzer, _Client]:
    safety = _Client(
        "gliguard",
        {"jailbreak_detection": ["jailbreak"], "prompt_safety": ["safe"], "prompt_toxicity": []},
    )
    policy = SafetyPolicy(
        tasks={
            "jailbreak_detection": {"labels": ["none", "jailbreak"]},
            "prompt_safety": {"labels": ["safe", "unsafe"]},
            "prompt_toxicity": {"labels": ["none", "toxic"]},
        },
        benign_labels=frozenset({"safe", "none"}),
    )
    return SafetyAnalyzer(policy, safety_client=safety, injection=route), safety  # type: ignore[arg-type]


def _route(answer: str) -> tuple[InjectionRoute, _Client]:
    client = _Client("pg2", {"jailbreak_detection": answer})
    route = InjectionRoute(
        tasks={"jailbreak_detection": PG2_SPEC},
        benign_labels=frozenset({"benign"}),
        client=client,  # type: ignore[arg-type]
    )
    return route, client


@pytest.mark.asyncio
async def test_without_a_route_the_analyzer_is_unchanged() -> None:
    analyzer, safety = _analyzer(None)
    assert analyzer.route_groups(("jailbreak_detection", "prompt_safety")) == [
        ("jailbreak_detection", "prompt_safety")
    ]
    verdict = await analyzer.analyze_content("x", "prompt_injection")
    assert verdict["issues"] == ["jailbreak_detection:jailbreak"]
    assert safety.asked == [{"jailbreak_detection": {"labels": ["none", "jailbreak"]}}]
    assert analyzer.model_for("jailbreak_detection") == "gliguard"


@pytest.mark.asyncio
async def test_a_mixed_classify_asks_each_model_its_own_tasks() -> None:
    route, pg2 = _route("MALICIOUS")
    analyzer, safety = _analyzer(route)
    labels = await analyzer.classify_tasks(("prompt_safety", "jailbreak_detection"), "x")
    assert labels == {"prompt_safety": ["safe"], "jailbreak_detection": "MALICIOUS"}
    assert pg2.asked == [{"jailbreak_detection": PG2_SPEC}]
    assert safety.asked == [{"prompt_safety": {"labels": ["safe", "unsafe"]}}]
    assert analyzer.model_for("jailbreak_detection") == "pg2"
    assert analyzer.model_for("prompt_safety") == "gliguard"
    assert analyzer.benign_labels_for("jailbreak_detection") == frozenset({"benign"})
    assert analyzer.benign_labels_for("prompt_safety") == frozenset({"safe", "none"})


@pytest.mark.asyncio
async def test_the_legacy_analyze_path_routes_jailbreak_and_reads_its_benign_labels() -> None:
    route, pg2 = _route("BENIGN")
    analyzer, safety = _analyzer(route)
    verdict = await analyzer.analyze_content("x", "prompt_injection")
    assert verdict["safe"] is True
    assert pg2.asked and safety.asked == []


@pytest.mark.asyncio
async def test_an_unavailable_route_raises_rather_than_asking_gliguard() -> None:
    analyzer, safety = _analyzer(InjectionRoute(unavailable="vetoed"))
    with pytest.raises(GuardrailUndeterminedError):
        await analyzer.classify_tasks(("jailbreak_detection",), "x")
    with pytest.raises(GuardrailUndeterminedError):
        await analyzer.analyze_content("x", "prompt_injection")
    assert safety.asked == []
    # The GLiGuard tasks are unaffected by the injection veto.
    assert await analyzer.classify_tasks(("prompt_safety",), "x") == {"prompt_safety": ["safe"]}
