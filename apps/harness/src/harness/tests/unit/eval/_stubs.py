"""Deterministic, offline stub judge clients for the eval unit tests.

These satisfy the :class:`harness.eval.judge.base.JudgeClient` protocol without
any network/LLM calls, so every eval unit test is reproducible and hermetic.
Not collected by pytest (does not match ``test_*``).
"""

from __future__ import annotations

import json
from collections.abc import Callable

Messages = list[dict[str, str]]


class StubJudgeClient:
    """Returns a fixed string, or a callable's result, for every completion."""

    def __init__(
        self, response: str | Callable[[Messages], str], model: str = "stub-judge"
    ) -> None:
        self._response = response
        self.model = model
        self.calls: list[Messages] = []
        self.temperatures: list[float | None] = []
        self.seeds: list[int | None] = []

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        self.temperatures.append(temperature)
        self.seeds.append(seed)
        if callable(self._response):
            return self._response(messages)
        return self._response


class ScriptedJudgeClient:
    """Returns a queue of responses in order (for multi-call flows)."""

    def __init__(self, responses: list[str], model: str = "stub-judge") -> None:
        self._responses = list(responses)
        self.model = model
        self.calls: list[Messages] = []
        self.temperatures: list[float | None] = []
        self.seeds: list[int | None] = []

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        self.temperatures.append(temperature)
        self.seeds.append(seed)
        if not self._responses:
            raise AssertionError("ScriptedJudgeClient ran out of responses")
        return self._responses.pop(0)


class MappingJudgeClient:
    """Returns a per-case response chosen by matching a key substring.

    Lets the *real* runner + judge.parse path be exercised while still being
    fully deterministic: the response for a case is selected by finding a unique
    snippet of that case's summary in the prompt.
    """

    def __init__(self, mapping: dict[str, str], default: str, model: str = "stub-judge") -> None:
        self._mapping = mapping
        self._default = default
        self.model = model
        self.calls: list[Messages] = []

    async def complete(
        self,
        messages: Messages,
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.calls.append(messages)
        blob = " ".join(m["content"] for m in messages)
        for key, response in self._mapping.items():
            if key in blob:
                return response
        return self._default


class StubClaimExtractor:
    """Returns a fixed list of claims regardless of input."""

    def __init__(self, claims: list[str]) -> None:
        self._claims = claims

    async def extract(self, answer: str, context: str) -> list[str]:
        return list(self._claims)


class StubClaimVerifier:
    """Supports exactly the claims in ``supported`` (everything else unsupported)."""

    def __init__(self, supported: set[str]) -> None:
        self._supported = supported

    async def verify(self, claim: str, context: str) -> bool:
        return claim in self._supported


def pdsqi_score_json(**overrides: object) -> str:
    """A well-formed PDSQI-9 *score-only* JSON response."""
    base = {
        "citation": 4,
        "accurate": 5,
        "thorough": 4,
        "useful": 5,
        "organized": 4,
        "comprehensible": 5,
        "succinct": 4,
        "abstraction": 1,
        "synthesized": 4,
        "voice_summ": 0,
        "voice_note": 0,
    }
    base.update(overrides)
    return json.dumps(base)


def pdsqi_detail_json(**score_overrides: int) -> str:
    """A well-formed PDSQI-9 *with-explanation* JSON response."""
    scores = {
        "citation": 4,
        "accurate": 5,
        "thorough": 4,
        "useful": 5,
        "organized": 4,
        "comprehensible": 5,
        "succinct": 4,
        "abstraction": 1,
        "synthesized": 4,
        "voice_summ": 0,
        "voice_note": 0,
    }
    scores.update(score_overrides)
    return json.dumps(
        {k: {"explanation": f"because {k} looked fine", "score": v} for k, v in scores.items()}
    )
