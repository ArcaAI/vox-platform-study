"""TASK-1050 follow-up G (owner, 2026-10-08) — an apps/nlp outage sheds fast.

* `classifierTimeoutSeconds` (`guardrail.safety` row, operational, [1, 60]) bounds the safety,
  injection and PII classifier clients. It only SHORTENS `nlpDeadlineSeconds`; absent ⇒ the
  clients keep `nlpDeadlineSeconds` exactly as before.
* The `nlp` circuit breaker counts a TIMEOUT as a failure, so a sustained outage opens it and
  later calls are shed without waiting.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from guardrail.core.breaker import STATE_OPEN, CircuitBreaker, FailPosture
from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.policy import OPERATIONAL_KEYS, GuardrailPolicy, policy_key_catalogue
from guardrail.services.external_nlp_client import NlpGuardClient

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"


# ── the key ─────────────────────────────────────────────────────────────────


def test_the_key_is_declared_operational_on_the_safety_row() -> None:
    entry = next(
        e for e in policy_key_catalogue()["keys"] if e["key"] == "classifierTimeoutSeconds"
    )
    assert entry == {
        "key": "classifierTimeoutSeconds",
        "kind": "operational",
        "type": "number",
        "min": 1.0,
        "max": 60.0,
        "failMode": "open-to-default",
        "taskKey": "guardrail.safety",
        "inPolicyVersion": False,
        "editable": True,
    }
    assert "classifierTimeoutSeconds" in OPERATIONAL_KEYS


@pytest.mark.parametrize("value", [None, 0.5, 61, "10", True])
def test_absent_or_out_of_range_is_no_opinion(value: Any) -> None:
    blob = {} if value is None else {"classifierTimeoutSeconds": value}
    assert GuardrailPolicy.from_blob(blob).classifier_timeout_seconds is None


def test_a_valid_value_reads() -> None:
    assert (
        GuardrailPolicy.from_blob({"classifierTimeoutSeconds": 10}).classifier_timeout_seconds
        == 10.0
    )


# ── the three classifier clients ────────────────────────────────────────────


def _app_state(safety_policy: dict[str, Any] | None) -> Any:
    def _cfg(task_key: str) -> Any:
        tasks = {"jailbreak_detection": {"labels": ["benign", "jailbreak"]}}
        if task_key == "guardrail.safety":
            tasks["response_safety"] = {"labels": ["safe", "unsafe"]}
        return SimpleNamespace(
            provider="lm-studio",
            model=f"model-{task_key}",
            timeout_s=None,
            entailment=None,
            policy=safety_policy if task_key == "guardrail.safety" else None,
            source_tenant_id=SYSTEM,
            label_taxonomy={"tasks": tasks, "labels": ["PERSON"]},
        )

    class _Resolver:
        async def resolve(self, tenant_id: str | None, task_key: str) -> Any:
            return _cfg(task_key)

    return SimpleNamespace(
        settings=Settings(),
        http_client=object(),
        tenant_config_resolver=_Resolver(),
        circuit_breakers=None,
        effective_config_client=None,
    )


def _timeouts(analyzer: Any) -> dict[str, float]:
    return {
        "safety": analyzer._safety_client._timeout_s,
        "pii": analyzer._pii_client._timeout_s,
        "injection": analyzer._injection.client._timeout_s,
    }


@pytest.mark.asyncio
async def test_the_classifier_timeout_bounds_all_three_clients() -> None:
    from guardrail.core.dependencies import build_safety_analyzer

    analyzer = await build_safety_analyzer(_app_state({"classifierTimeoutSeconds": 10}), TENANT)
    assert _timeouts(analyzer) == {"safety": 10.0, "pii": 10.0, "injection": 10.0}


@pytest.mark.asyncio
async def test_absent_keeps_the_nlp_deadline() -> None:
    from guardrail.core.dependencies import build_safety_analyzer

    analyzer = await build_safety_analyzer(_app_state(None), TENANT)
    deadline = GuardrailPolicy.from_blob({}).nlp_deadline_seconds
    assert _timeouts(analyzer) == {"safety": deadline, "pii": deadline, "injection": deadline}


@pytest.mark.asyncio
async def test_it_never_extends_the_nlp_deadline() -> None:
    from guardrail.core.dependencies import build_safety_analyzer

    analyzer = await build_safety_analyzer(
        _app_state({"classifierTimeoutSeconds": 20, "nlpDeadlineSeconds": 5}), TENANT
    )
    assert _timeouts(analyzer)["safety"] == 5.0


# ── the breaker counts timeouts ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_repeated_timeouts_open_the_breaker_and_later_calls_are_shed() -> None:
    calls = 0

    async def _hang(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    breaker = CircuitBreaker(
        name="nlp", posture=FailPosture.FAIL_CLOSED, failure_threshold=2, recovery_timeout_s=60
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(_hang)) as http:
        client = NlpGuardClient(
            base_url="http://nlp",
            service_token="t",
            http_client=http,
            tenant_id=TENANT,
            model_id="m",
            timeout_s=0.05,
            breaker=breaker,
        )
        for _ in range(2):
            with pytest.raises(GuardrailUndeterminedError):
                await client.classify({"response_safety": {}}, "x")
        assert breaker.state == STATE_OPEN

        loop = asyncio.get_running_loop()
        started = loop.time()
        with pytest.raises(GuardrailUndeterminedError):
            await client.classify({"response_safety": {}}, "x")
        assert loop.time() - started < 0.05
    assert calls == 2  # the shed call never reached the peer
