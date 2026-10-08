"""TASK-1050 follow-up A (owner, 2026-10-08) — an outbound `pii_leak` is not too strict.

`piiLeakQuasiIdentifierLabels` (`guardrail.pii` row, `string[]`): a `pii_leak` flag whose
flagged labels are ALL in the list is taken at `warn` when the configured action is `block`.
Any other label (a direct identifier, a secret) keeps the configured action; `ignore` stays
`ignore`; absent / empty ⇒ today's behaviour. Matched exactly — an unknown label is never
treated as quasi.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.availability import GuardrailAvailability
from guardrail.core.config import Settings
from guardrail.core.policy import GuardrailPolicy, policy_key_catalogue
from guardrail.services import screening as screening_mod
from guardrail.services.screening import Screener

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"
QUASI = frozenset({"healthcare_facility", "city", "date_of_birth"})
SOURCE = "patient has a cough"


class _Analyzer:
    """Every span named in ``spans`` is reported over a fragment absent from the source."""

    def __init__(self, labels: tuple[str, ...]) -> None:
        self.labels = labels

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        return dict.fromkeys(task_names, "benign")

    async def extract_pii_entities(self, text: str) -> list[Any]:
        spans = []
        for label in self.labels:
            start = text.index(label.upper())
            spans.append(
                SimpleNamespace(label=label, start=start, end=start + len(label), score=0.9)
            )
        return spans

    def model_for(self, check: str) -> str:
        return "pii-model"


def _response(labels: tuple[str, ...]) -> str:
    return "Seen at " + " and ".join(label.upper() for label in labels) + "."


async def _pii_leak(
    labels: tuple[str, ...], *, quasi: frozenset[str] = QUASI, action: str | None = None
) -> Any:
    availability = (
        GuardrailAvailability.from_tiers(
            system_blob={"checks": {"pii_leak": {"enabled": True, "action": action}}},
            tenant_blob=None,
        )
        if action
        else None
    )
    screener = Screener(
        analyzer=_Analyzer(labels),
        tenant_id=TENANT,
        availability=availability,
        pii_leak_quasi_identifier_labels=quasi,
    )
    decision = await screener.screen_outbound(
        _response(labels), source_context=SOURCE, response_items=[("item-9", 3)]
    )
    return decision, next(c for c in decision.checks if c.name == "pii_leak")


# ── the key ─────────────────────────────────────────────────────────────────


def test_the_key_is_declared_on_the_pii_row() -> None:
    entry = next(
        e for e in policy_key_catalogue()["keys"] if e["key"] == "piiLeakQuasiIdentifierLabels"
    )
    assert entry == {
        "key": "piiLeakQuasiIdentifierLabels",
        "kind": "operational",
        "type": "string[]",
        "min": None,
        "max": None,
        "failMode": "open-to-default",
        "taskKey": "guardrail.pii",
        "inPolicyVersion": True,
        "editable": True,
    }


@pytest.mark.parametrize("blob", [{}, {"piiLeakQuasiIdentifierLabels": "city"}, {"x": 1}])
def test_absent_or_malformed_is_empty(blob: dict[str, Any]) -> None:
    assert GuardrailPolicy.from_blob(blob).pii_leak_quasi_identifier_labels == frozenset()


def test_the_list_is_read_case_folded() -> None:
    blob = {"piiLeakQuasiIdentifierLabels": ["City", " healthcare_facility "]}
    assert GuardrailPolicy.from_blob(blob).pii_leak_quasi_identifier_labels == frozenset(
        {"city", "healthcare_facility"}
    )


# ── the decision ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_quasi_identifiers_alone_warn_under_a_block_action() -> None:
    decision, check = await _pii_leak(("healthcare_facility", "city"))
    assert check.verdict == "flag"
    assert check.action == "block"
    assert check.action_taken == "warn"
    assert check.flagged_items == (("item-9", 3),)
    assert check.flagged_regions == ("response",)
    assert decision.guardrail_decision == "warn"
    assert decision.decision == "allow"


@pytest.mark.asyncio
async def test_a_direct_identifier_keeps_the_block() -> None:
    decision, check = await _pii_leak(("healthcare_facility", "person"))
    assert check.action_taken == "block"
    assert decision.decision == "block"


@pytest.mark.asyncio
async def test_an_unknown_label_is_never_quasi() -> None:
    decision, check = await _pii_leak(("api_key",))
    assert check.action_taken == "block"


@pytest.mark.asyncio
async def test_an_empty_list_is_todays_behaviour() -> None:
    decision, check = await _pii_leak(("healthcare_facility",), quasi=frozenset())
    assert check.action_taken == "block"
    assert decision.decision == "block"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["warn", "ignore"])
async def test_never_stricter_than_configured(action: str) -> None:
    _decision, quasi = await _pii_leak(("city",), action=action)
    _decision, direct = await _pii_leak(("person",), action=action)
    assert quasi.action_taken == action
    assert direct.action_taken == action


# ── build_screener reads the PII row's list ─────────────────────────────────


def _app_state(pii_policy: dict[str, Any] | None) -> Any:
    taxonomy = {
        "tasks": {name: {"labels": ["benign", "flag"]} for name in screening_mod.OUTBOUND_TASKS},
        "labels": ["PERSON"],
    }

    def _cfg(policy: dict[str, Any] | None) -> Any:
        return SimpleNamespace(
            provider="lm-studio",
            model="some-selected-model",
            timeout_s=None,
            entailment=None,
            policy=policy,
            source_tenant_id=SYSTEM,
            label_taxonomy=taxonomy,
        )

    class _Resolver:
        async def resolve(self, tenant_id: str | None, task_key: str) -> Any:
            return _cfg(pii_policy if task_key == "guardrail.pii" else None)

    return SimpleNamespace(
        settings=Settings(),
        http_client=object(),
        tenant_config_resolver=_Resolver(),
        circuit_breakers=None,
        effective_config_client=None,
    )


@pytest.mark.asyncio
async def test_build_screener_reads_the_pii_rows_list() -> None:
    from guardrail.core.dependencies import build_screener

    screener = await build_screener(
        _app_state({"piiLeakQuasiIdentifierLabels": ["healthcare_facility"]}), TENANT
    )
    assert screener.pii_leak_quasi_identifier_labels == frozenset({"healthcare_facility"})
    plain = await build_screener(_app_state(None), TENANT)
    assert plain.pii_leak_quasi_identifier_labels == frozenset()
