"""TASK-1047 L5 — `GET /api/v1/guardrail/policy-version` (FC-3).

The gateway registry (L3) stamps every governed-prompt verdict with guardrail's
policy version, and the window-verdict cache keys on it (FC-7). It is a STABLE hash
of everything that can change a screening verdict for the caller's tenant — the
screen task taxonomy, the model ids, the thresholds, the window geometry and the
judge criterion — resolved tenant → SYSTEM like every other selection. Purely
operational knobs (deadlines, cache TTL, concurrency) are NOT part of it: changing
one must not cold the cache or force a registry re-screen.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from guardrail.api.endpoints.policy_version import get_policy_version
from guardrail.core.config import Settings
from guardrail.core.tenant_config import (
    TASK_KEY_GUARDRAIL_PII,
    TASK_KEY_GUARDRAIL_PII_SPANS,
    TASK_KEY_GUARDRAIL_SAFETY,
    TASK_KEY_GUARDRAIL_VALIDATE,
    GuardrailTenantConfig,
    TenantConfigUnavailableError,
)

TENANT = "11111111-1111-1111-1111-111111111111"

BASE: dict[str, dict[str, Any]] = {
    TASK_KEY_GUARDRAIL_SAFETY: {
        "model": "gliguard-300m",
        "label_taxonomy": {
            "tasks": {"prompt_safety": {"labels": ["safe", "unsafe"]}},
            "threshold": 0.4,
        },
        "policy": {"piiLeakMinScore": 0.5},
    },
    TASK_KEY_GUARDRAIL_PII: {"model": "gliner2-pii", "label_taxonomy": {"labels": ["person"]}},
    TASK_KEY_GUARDRAIL_PII_SPANS: {"model": "gliner2-pf", "label_taxonomy": {"labels": ["person"]}},
    TASK_KEY_GUARDRAIL_VALIDATE: {
        "provider": "lm-studio",
        "model": "granite-guardian",
        "policy": {"medicalWindowScopeCriteria": "on scope unless directing non-medical work"},
    },
}


class _Resolver:
    def __init__(self, rows: dict[str, dict[str, Any]]) -> None:
        self.rows = rows
        self.raise_for: str | None = None

    async def resolve(self, tenant_id, task_key="guardrail.validate"):
        if task_key == self.raise_for:
            raise TenantConfigUnavailableError(tenant_id=tenant_id, task_key=task_key, cause="db")
        row = self.rows.get(task_key)
        if row is None:
            return GuardrailTenantConfig(source_tenant_id=tenant_id)
        return GuardrailTenantConfig(source_tenant_id=tenant_id, **row)


def _request(rows: dict[str, dict[str, Any]], tenant: str | None = TENANT) -> Any:
    state = SimpleNamespace(tenant_config_resolver=_Resolver(rows), settings=Settings())
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return SimpleNamespace(app=SimpleNamespace(state=state), headers=headers)


async def _version(rows: dict[str, dict[str, Any]]) -> str:
    return (await get_policy_version(_request(rows)))["policyVersion"]


async def test_the_route_answers_a_stable_hex_hash() -> None:
    first = await _version(BASE)
    again = await _version(copy.deepcopy(BASE))
    assert first == again
    assert len(first) == 64 and int(first, 16) >= 0


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r[TASK_KEY_GUARDRAIL_SAFETY].update(model="gliguard-v2"),
        lambda r: r[TASK_KEY_GUARDRAIL_SAFETY]["label_taxonomy"].update(threshold=0.5),
        lambda r: r[TASK_KEY_GUARDRAIL_SAFETY]["label_taxonomy"]["tasks"].update(
            jailbreak_detection={"labels": ["benign", "jailbreak"]}
        ),
        lambda r: r[TASK_KEY_GUARDRAIL_SAFETY]["policy"].update(piiLeakMinScore=0.7),
        lambda r: r[TASK_KEY_GUARDRAIL_SAFETY]["policy"].update(screenWindowChars=2_000),
        lambda r: r[TASK_KEY_GUARDRAIL_PII].update(model="gliner2-pii-v2"),
        lambda r: r[TASK_KEY_GUARDRAIL_PII_SPANS]["label_taxonomy"].update(labels=["email"]),
        lambda r: r[TASK_KEY_GUARDRAIL_VALIDATE]["policy"].update(
            medicalWindowScopeCriteria="a different criterion"
        ),
        lambda r: r[TASK_KEY_GUARDRAIL_VALIDATE].update(model="another-judge"),
    ],
)
async def test_every_verdict_affecting_input_moves_the_version(mutate) -> None:
    rows = copy.deepcopy(BASE)
    mutate(rows)
    assert await _version(rows) != await _version(BASE)


@pytest.mark.parametrize(
    "key,value",
    [
        ("nlpDeadlineSeconds", 10),
        ("windowCacheTtlSeconds", 3_600),
        ("screenWindowConcurrency", 2),
    ],
)
async def test_operational_knobs_do_not_move_the_version(key, value) -> None:
    rows = copy.deepcopy(BASE)
    rows[TASK_KEY_GUARDRAIL_SAFETY]["policy"][key] = value
    assert await _version(rows) == await _version(BASE)


async def test_an_out_of_range_geometry_that_resolves_to_the_default_is_the_same_version() -> None:
    rows = copy.deepcopy(BASE)
    rows[TASK_KEY_GUARDRAIL_SAFETY]["policy"]["screenWindowChars"] = 4_000
    assert await _version(rows) == await _version(BASE)


async def test_an_absent_tenant_header_is_428() -> None:
    with pytest.raises(HTTPException) as exc:
        await get_policy_version(_request(BASE, tenant=None))
    assert exc.value.status_code == 428


async def test_an_unreadable_tenant_config_is_503_not_a_different_version() -> None:
    request = _request(BASE)
    request.app.state.tenant_config_resolver.raise_for = TASK_KEY_GUARDRAIL_VALIDATE
    with pytest.raises(HTTPException) as exc:
        await get_policy_version(request)
    assert exc.value.status_code == 503


async def test_no_resolver_is_503() -> None:
    request = _request(BASE)
    request.app.state.tenant_config_resolver = None
    with pytest.raises(HTTPException) as exc:
        await get_policy_version(request)
    assert exc.value.status_code == 503


async def test_the_route_is_mounted_and_service_token_protected(monkeypatch) -> None:
    monkeypatch.setenv("GUARDRAIL_SERVICE_TOKEN", "svc-secret")
    from guardrail.main import create_app

    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        unauthenticated = await client.get(
            "/api/v1/guardrail/policy-version", headers={"X-Tenant-Id": TENANT}
        )
        authenticated = await client.get(
            "/api/v1/guardrail/policy-version",
            headers={"X-Tenant-Id": TENANT, "X-Service-Token": "svc-secret"},
        )
    assert unauthenticated.status_code == 401
    # Mounted (not 404); no lifespan ran, so no resolver is wired ⇒ a DECLARED 503.
    assert authenticated.status_code == 503
