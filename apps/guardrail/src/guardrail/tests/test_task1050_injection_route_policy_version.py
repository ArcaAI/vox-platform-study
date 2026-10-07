"""TASK-1050 W2a3 / TASK-1049 R1 — the `guardrail.injection` key and the policy version.

The policy version must move exactly when a screening verdict could: a change to the
injection row's model, taxonomy or serving library re-screens and colds the window cache.
Fakes only.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.config import Settings
from guardrail.core.policy_version import HASHED_TASK_KEYS, resolve_policy_version
from guardrail.core.tenant_config import (
    TASK_KEY_GUARDRAIL_INJECTION,
    TASK_KEY_GUARDRAIL_SAFETY,
    GuardrailTenantConfig,
    TenantSelectionVetoedError,
)

TENANT = "11111111-1111-1111-1111-111111111111"

BASE: dict[str, dict[str, Any]] = {
    TASK_KEY_GUARDRAIL_SAFETY: {
        "model": "gliguard-300m",
        "library_name": "gliner2",
        "label_taxonomy": {"tasks": {"prompt_safety": {"labels": ["safe", "unsafe"]}}},
    },
    TASK_KEY_GUARDRAIL_INJECTION: {
        "model": "meta-llama/Llama-Prompt-Guard-2-86M",
        "library_name": "transformers",
        "label_taxonomy": {
            "threshold": 0.5,
            "benignLabels": ["BENIGN"],
            "tasks": {
                "jailbreak_detection": {"labels": ["BENIGN", "MALICIOUS"], "multi_label": False}
            },
        },
    },
}


class _Resolver:
    def __init__(self, rows: dict[str, Any]) -> None:
        self.rows = rows
        self.asked: list[str] = []

    async def resolve(self, tenant_id: str, task_key: str = "") -> Any:
        self.asked.append(task_key)
        row = self.rows.get(task_key)
        if isinstance(row, BaseException):
            raise row
        if row is None:
            return GuardrailTenantConfig(source_tenant_id=tenant_id)
        return GuardrailTenantConfig(source_tenant_id=tenant_id, **row)


async def _version(rows: dict[str, Any]) -> str:
    state = SimpleNamespace(tenant_config_resolver=_Resolver(rows), settings=Settings())
    return await resolve_policy_version(state, TENANT)


def test_the_task_key_is_the_frozen_contract_name() -> None:
    assert TASK_KEY_GUARDRAIL_INJECTION == "guardrail.injection"
    assert TASK_KEY_GUARDRAIL_INJECTION in HASHED_TASK_KEYS


@pytest.mark.asyncio
async def test_the_injection_row_is_read_for_the_policy_version() -> None:
    resolver = _Resolver(BASE)
    await resolve_policy_version(
        SimpleNamespace(tenant_config_resolver=resolver, settings=Settings()), TENANT
    )
    assert TASK_KEY_GUARDRAIL_INJECTION in resolver.asked


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r[TASK_KEY_GUARDRAIL_INJECTION].update(model="another-injection-model"),
        lambda r: r[TASK_KEY_GUARDRAIL_INJECTION].update(library_name="gliner2"),
        lambda r: r[TASK_KEY_GUARDRAIL_INJECTION]["label_taxonomy"].update(threshold=0.7),
        lambda r: r[TASK_KEY_GUARDRAIL_INJECTION]["label_taxonomy"].update(
            benignLabels=["BENIGN", "SAFE"]
        ),
        lambda r: r[TASK_KEY_GUARDRAIL_INJECTION]["label_taxonomy"]["tasks"][
            "jailbreak_detection"
        ].update(cls_threshold=0.9),
        lambda r: r.pop(TASK_KEY_GUARDRAIL_INJECTION),
        lambda r: r.__setitem__(
            TASK_KEY_GUARDRAIL_INJECTION,
            TenantSelectionVetoedError(tenant_id=TENANT, task_key=TASK_KEY_GUARDRAIL_INJECTION),
        ),
    ],
)
async def test_an_injection_row_change_moves_the_version(mutate: Any) -> None:
    rows = copy.deepcopy(BASE)
    mutate(rows)
    assert await _version(rows) != await _version(BASE)


@pytest.mark.asyncio
async def test_the_version_is_stable_for_the_same_injection_row() -> None:
    assert await _version(copy.deepcopy(BASE)) == await _version(BASE)
