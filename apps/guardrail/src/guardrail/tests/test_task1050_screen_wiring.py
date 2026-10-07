"""TASK-1050 W2a2 — `build_screener` wires the judge runner, the bands and the policy
version; the lifespan helper starts the drainer and the invalidation subscriber."""

from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import pytest

from guardrail.core.availability import GuardrailAvailability

TENANT = "tenant-a"


def _app_state(*, availability: GuardrailAvailability, policy: dict[str, Any] | None = None) -> Any:
    from guardrail.core.config import Settings

    taxonomy = {"tasks": {"prompt_safety": {"labels": ["benign", "unsafe"]}}, "labels": ["PERSON"]}
    cfg = SimpleNamespace(
        provider="nlp",
        model="m",
        timeout_s=None,
        entailment=None,
        policy=policy,
        source_tenant_id=TENANT,
        label_taxonomy=taxonomy,
        library_name="gliner2",
    )

    class _Resolver:
        async def resolve(self, tenant_id: str | None, task_key: str = "") -> Any:
            return cfg

        async def resolve_availability(self, tenant_id: str) -> GuardrailAvailability:
            return availability

    return SimpleNamespace(
        settings=Settings(),
        http_client=object(),
        tenant_config_resolver=_Resolver(),
        circuit_breakers=None,
        effective_config_client=None,
    )


def _install_runner_module(monkeypatch: Any, factory: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    module = types.ModuleType("guardrail.services.judge_runner")

    async def build_judge_runner_for_app(app_state: Any, tenant_id: str, **kw: Any) -> Any:
        calls.append({"tenant_id": tenant_id, "app_state": app_state, **kw})
        return factory()

    module.build_judge_runner_for_app = build_judge_runner_for_app  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "guardrail.services.judge_runner", module)
    return calls


async def _fixed_version(app_state: Any, tenant_id: str) -> str:
    return "pv-fixed"


@pytest.mark.asyncio
async def test_build_screener_wires_runner_bands_and_policy_version(monkeypatch: Any) -> None:
    import guardrail.core.policy_version as pv
    from guardrail.core.dependencies import build_screener

    monkeypatch.setattr(pv, "resolve_policy_version", _fixed_version)
    runner = object()
    calls = _install_runner_module(monkeypatch, lambda: runner)
    availability = GuardrailAvailability.from_tiers(
        system_blob={"checks": {"unsafe_content_judge": {"enabled": True}}}, tenant_blob=None
    )
    policy = {
        "judgeBands": {
            "response_safety": {"low": 0.3, "high": 0.7},
            "bogus": {"low": 0.9, "high": 0.1},
        }
    }
    screener = await build_screener(_app_state(availability=availability, policy=policy), TENANT)
    assert screener.judge_runner is runner
    assert calls[0]["tenant_id"] == TENANT
    assert screener._band("response_safety") == (0.3, 0.7)  # noqa: SLF001
    assert screener._band("bogus") is None  # an inverted band is no band  # noqa: SLF001
    assert screener.policy_version == "pv-fixed"
    assert screener.judge_geometry.size > 0


@pytest.mark.asyncio
async def test_no_judge_enabled_builds_no_runner(monkeypatch: Any) -> None:
    import guardrail.core.policy_version as pv
    from guardrail.core.dependencies import build_screener

    monkeypatch.setattr(pv, "resolve_policy_version", _fixed_version)
    calls = _install_runner_module(monkeypatch, object)
    screener = await build_screener(
        _app_state(
            availability=GuardrailAvailability.from_tiers(system_blob=None, tenant_blob=None)
        ),
        TENANT,
    )
    assert calls == []
    assert screener.judge_runner is None


@pytest.mark.asyncio
async def test_a_runner_that_cannot_be_built_degrades_to_none(monkeypatch: Any) -> None:
    import guardrail.core.policy_version as pv
    from guardrail.core.dependencies import build_screener

    async def _broken_version(app_state: Any, tenant_id: str) -> str:
        raise pv.PolicyVersionUnavailableError("db down")

    monkeypatch.setattr(pv, "resolve_policy_version", _broken_version)

    def _boom() -> Any:
        raise RuntimeError("no judge selection")

    _install_runner_module(monkeypatch, _boom)
    availability = GuardrailAvailability.from_tiers(
        system_blob={"checks": {"leakage_judge": {"enabled": True}}}, tenant_blob=None
    )
    screener = await build_screener(_app_state(availability=availability), TENANT)
    assert screener.judge_runner is None  # the lane then degrades to `unverified`
    assert screener.policy_version == "unavailable"


@pytest.mark.asyncio
async def test_lifespan_capture_starts_the_drainer_and_the_subscriber() -> None:
    from guardrail.core.config import Settings
    from guardrail.services.evaluation_outbox import (
        EvaluationOutbox,
        start_evaluation_capture,
        stop_evaluation_capture,
    )

    state = SimpleNamespace(tenant_config_resolver=SimpleNamespace(invalidate=lambda **_: 0))
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    start_evaluation_capture(state, Settings(), redis, http_client=object())
    try:
        assert isinstance(state.evaluation_outbox, EvaluationOutbox)
        assert not state.evaluation_drainer_task.done()
        assert not state.guardrail_config_invalidation_task.done()
    finally:
        await stop_evaluation_capture(state)
    assert state.evaluation_drainer_task.done()
    assert state.guardrail_config_invalidation_task.done()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_the_nlp_clients_carry_the_rows_library_name(monkeypatch: Any) -> None:
    import inspect

    import guardrail.core.policy_version as pv
    from guardrail.core.dependencies import build_screener
    from guardrail.services.external_nlp_client import NlpGuardClient

    if "library_name" not in inspect.signature(NlpGuardClient.__init__).parameters:
        pytest.skip("NlpGuardClient(library_name=) arrives with lane W2a1's merge")
    monkeypatch.setattr(pv, "resolve_policy_version", _fixed_version)
    screener = await build_screener(
        _app_state(
            availability=GuardrailAvailability.from_tiers(system_blob=None, tenant_blob=None)
        ),
        TENANT,
    )
    assert screener._analyzer._safety_client.library_name == "gliner2"  # noqa: SLF001
    assert screener._analyzer._pii_client.library_name == "gliner2"  # noqa: SLF001


@pytest.mark.asyncio
async def test_the_read_failure_fallback_keeps_the_judges_off() -> None:
    from guardrail.core.dependencies import _resolve_availability

    class _Broken:
        async def resolve_availability(self, tenant_id: str) -> Any:
            raise RuntimeError("db down")

    for state in (SimpleNamespace(tenant_config_resolver=_Broken()), SimpleNamespace()):
        resolved = await _resolve_availability(state, TENANT)
        for lane in (
            "injection_judge",
            "unsafe_content_judge",
            "clinical_safety_judge",
            "leakage_judge",
        ):
            assert resolved.is_enabled(lane) is False
        assert resolved.is_enabled("medical_validation") is True
        assert resolved.is_enabled("prompt_safety") is True
