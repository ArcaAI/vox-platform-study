"""TASK-1050 follow-up I (owner, 2026-10-08) — never cache an incomplete classify answer.

In the local e2e a stale `{}` answer (apps/nlp omitted the requested tasks) was cached, and
every later screen of that window read `not_in_taxonomy` until the TTL. A classify answer that
omits a task the request ASKED the model for is now never stored, and such an entry already in
the cache (written before this fix) is read as a miss.

"Asked" = the tasks the analyzer actually sends (`SafetyAnalyzer.declared_tasks`): a task the
model's taxonomy does not declare is never sent, so its absence is not an omission.
"""

from __future__ import annotations

from typing import Any

import fakeredis.aioredis
import pytest

from guardrail.services.safety_analyzer import InjectionRoute, SafetyAnalyzer, SafetyPolicy
from guardrail.services.screening import Screener
from guardrail.services.window_cache import WindowVerdictCache, answers_every_task
from guardrail.services.windowing import WindowRunner

TENANT = "11111111-1111-1111-1111-111111111111"
SECRET = "window-cache-test-secret"


class _Analyzer:
    """Answers every requested task, except the ones in ``omit`` while ``omit`` is set."""

    def __init__(self, declared: tuple[str, ...] | None = None) -> None:
        self.omit: set[str] = set()
        self.calls = 0
        self.declared = declared

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        self.calls += 1
        return dict.fromkeys((n for n in task_names if n not in self.omit), "benign")

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "gliguard"

    def declared_tasks(self, task_names: Any) -> tuple[str, ...]:
        if self.declared is None:
            return tuple(task_names)
        return tuple(name for name in task_names if name in self.declared)


def _screener(analyzer: _Analyzer, redis: Any) -> Screener:
    cache = WindowVerdictCache.build(redis, SECRET, ttl_s=3_600)
    return Screener(
        analyzer=analyzer,
        tenant_id=TENANT,
        window_runner=WindowRunner(
            tenant_id=TENANT, policy_version="pv-1", cache=cache, concurrency=4
        ),
    )


def _skips(decision: Any) -> dict[str, str]:
    return {c.name: c.reason for c in decision.checks if c.outcome == "skipped"}


@pytest.fixture
def redis() -> Any:
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


def test_the_predicate() -> None:
    complete = answers_every_task(("a", "b"))
    assert complete({"labels": {"a": ["x"], "b": []}})
    assert not complete({"labels": {"a": ["x"]}})
    assert not complete({"labels": {}})
    assert not complete({})


@pytest.mark.asyncio
async def test_an_answer_missing_a_requested_task_is_not_cached(redis: Any) -> None:
    analyzer = _Analyzer()
    analyzer.omit = {"response_safety", "response_toxicity"}
    first = await _screener(analyzer, redis).screen_outbound("the note", source_context="x")
    assert _skips(first)["response_safety"] == "not_in_taxonomy"

    analyzer.omit = set()
    second = await _screener(analyzer, redis).screen_outbound("the note", source_context="x")
    # Recomputed — the incomplete answer was never stored.
    assert "response_safety" not in _skips(second)
    assert analyzer.calls == 2


@pytest.mark.asyncio
async def test_a_complete_answer_is_still_cached(redis: Any) -> None:
    analyzer = _Analyzer()
    await _screener(analyzer, redis).screen_outbound("the note", source_context="x")
    await _screener(analyzer, redis).screen_outbound("the note", source_context="x")
    assert analyzer.calls == 1


@pytest.mark.asyncio
async def test_a_task_the_model_does_not_declare_is_not_an_omission(redis: Any) -> None:
    # `response_toxicity` is not in this model's taxonomy, so it is never sent and its absence
    # does not stop the answer being cached.
    analyzer = _Analyzer(declared=("response_safety", "jailbreak_detection"))
    analyzer.omit = {"response_toxicity"}
    for _ in range(2):
        await _screener(analyzer, redis).screen_outbound("the note", source_context="x")
    assert analyzer.calls == 1


@pytest.mark.asyncio
async def test_a_stale_incomplete_entry_is_read_as_a_miss(redis: Any) -> None:
    analyzer = _Analyzer()
    screener = _screener(analyzer, redis)
    cache = screener.window_runner.cache
    assert cache is not None
    # An entry written by a build without this fix: the answer omitted every task.
    tasks = "response_safety,response_toxicity,jailbreak_detection"
    key = cache.key(TENANT, "pv-1", "gliguard", f"classify:{tasks}", "the note")
    await cache.set(key, {"labels": {}, "scores": {}})

    decision = await screener.screen_outbound("the note", source_context="x")
    assert "response_safety" not in _skips(decision)
    assert analyzer.calls == 1


def test_the_analyzer_declares_what_it_sends() -> None:
    analyzer = SafetyAnalyzer(
        SafetyPolicy(tasks={"response_safety": {"labels": ["safe", "unsafe"]}}),
        injection=InjectionRoute(tasks={"jailbreak_detection": {"labels": ["benign", "jb"]}}),
    )
    assert analyzer.declared_tasks(
        ("response_safety", "response_refusal", "jailbreak_detection")
    ) == ("response_safety", "jailbreak_detection")
