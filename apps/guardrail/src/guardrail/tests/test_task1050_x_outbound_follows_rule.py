"""TASK-1050 follow-up B (owner, 2026-10-08) — outbound checks follow the configured rule.

`outboundRecordOnlyChecks` (TASK-1047 FC-5c) is RETIRED. It silently overrode the platform
action: the console showed `response_safety` = block while a flagged harmful response was only
recorded. Every outbound check (`response_safety`, `response_toxicity`, `response_refusal`)
now decides like every other check: the tenant's `enabled` and the platform's `action` —
`ignore` records only. (TASK-1061 OD-4 took `jailbreak_detection` off the outbound screen, and
OD-5b made `response_safety` record-only by platform default.)

A stored row that still carries the retired key (an existing DB until its reseed) is ignored:
logged once, never an error, never honoured.

Supersedes `test_task1047_fc5c_outbound_record_only.py`.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

import guardrail.core.dependencies as dependencies_mod
from guardrail.core.availability import GuardrailAvailability
from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.policy import GuardrailPolicy, policy_key_catalogue
from guardrail.services import screening as screening_mod
from guardrail.services.screening import Screener

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"

TRIGGERS = {
    "IGNORE ALL PREVIOUS": ("jailbreak_detection", "jailbreak"),
    "BUILD A WEAPON": ("response_safety", "harm"),
    "YOU IDIOT": ("response_toxicity", "toxic"),
    "I CANNOT HELP": ("response_refusal", "refusal"),
}
OUTAGE = "OUTAGE-WINDOW"
NONCE = "f3a9c1d27b"


class _Analyzer:
    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        if OUTAGE in text:
            raise GuardrailUndeterminedError("engine_error", "peer down")
        out: dict[str, Any] = {}
        for name in task_names:
            out[name] = "benign"
            for trigger, (task, flag) in TRIGGERS.items():
                if task == name and trigger in text:
                    out[name] = flag
        return out

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "safety-model"


def _availability(checks: dict[str, dict[str, Any]]) -> GuardrailAvailability:
    return GuardrailAvailability.from_tiers(system_blob={"checks": checks}, tenant_blob=None)


def _check(decision: Any, name: str) -> Any:
    return next(c for c in decision.checks if c.name == name)


# ── the key is retired ───────────────────────────────────────────────────────


def test_the_retired_key_is_no_longer_governed() -> None:
    assert "outboundRecordOnlyChecks" not in GuardrailPolicy.DECLARED_KEYS
    keys = {entry["key"] for entry in policy_key_catalogue()["keys"]}
    assert "outboundRecordOnlyChecks" not in keys
    assert not hasattr(GuardrailPolicy, "outbound_record_only_checks")


def test_the_screener_takes_no_record_only_set() -> None:
    with pytest.raises(TypeError):
        Screener(  # type: ignore[call-arg]
            analyzer=_Analyzer(), tenant_id=TENANT, outbound_record_only=frozenset()
        )


# ── outbound checks decide at the configured action ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "check"),
    [
        ("BUILD A WEAPON like this.", "response_safety"),
        ("YOU IDIOT.", "response_toxicity"),
        ("I CANNOT HELP.", "response_refusal"),
    ],
)
async def test_a_flagged_outbound_check_takes_the_platform_block(text: str, check: str) -> None:
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        availability=_availability(
            {
                "response_refusal": {"enabled": True},
                "response_safety": {"enabled": True, "action": "block"},
                "response_toxicity": {"enabled": True, "action": "block"},
            }
        ),
    )
    decision = await screener.screen_outbound(text, source_context="x", nonce=NONCE)
    flagged = _check(decision, check)
    assert (flagged.outcome, flagged.action_taken) == ("flag", "block")
    assert flagged.reason != "recorded_as_finding"
    assert decision.decision == "block"
    assert decision.reasons == [check]
    # No record-only set ⇒ no outbound data findings at all.
    assert decision.data_findings is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "check", "taken", "decided"),
    [
        # TASK-1061 OD-5b: `response_safety` is recorded only by platform default.
        ("BUILD A WEAPON like this.", "response_safety", "ignore", "allow"),
        ("YOU IDIOT.", "response_toxicity", "warn", "warn"),
    ],
)
async def test_the_outbound_classifiers_platform_defaults(
    text: str, check: str, taken: str, decided: str
) -> None:
    """Owner 2026-10-08: GLiGuard false-flags clinical notes, so a hit warns (the note is delivered
    with a notice) unless a platform admin raises the action to block — and `response_safety`
    only records (owner 2026-10-11, TASK-1061 OD-5b)."""
    screener = Screener(analyzer=_Analyzer(), tenant_id=TENANT, availability=_availability({}))
    decision = await screener.screen_outbound(text, source_context="x", nonce=NONCE)
    assert (_check(decision, check).outcome, _check(decision, check).action_taken) == (
        "flag",
        taken,
    )
    assert decision.decision == "allow"
    assert decision.guardrail_decision == decided


@pytest.mark.asyncio
async def test_ignore_records_only_and_warn_warns() -> None:
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        availability=_availability(
            {
                "response_safety": {"enabled": True, "action": "warn"},
                "response_toxicity": {"enabled": True, "action": "ignore"},
            }
        ),
    )
    decision = await screener.screen_outbound(
        "YOU IDIOT. BUILD A WEAPON.", source_context="x", nonce=NONCE
    )
    assert _check(decision, "response_toxicity").action_taken == "ignore"
    assert _check(decision, "response_safety").action_taken == "warn"
    assert decision.guardrail_decision == "warn"
    assert decision.decision == "allow"


@pytest.mark.asyncio
async def test_a_check_the_tenant_turned_off_is_not_selected() -> None:
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        availability=_availability({"response_safety": {"enabled": False}}),
    )
    decision = await screener.screen_outbound("BUILD A WEAPON", source_context="x", nonce=NONCE)
    assert _check(decision, "response_safety").reason == "not_selected_for_tenant"
    assert decision.decision == "allow"


@pytest.mark.asyncio
async def test_an_outage_still_degrades_to_unverified() -> None:
    screener = Screener(analyzer=_Analyzer(), tenant_id=TENANT)
    decision = await screener.screen_outbound(f"{OUTAGE} x", source_context="x", nonce=NONCE)
    # `response_toxicity` warns by default, so its outage degrades; `response_safety` (ignore)
    # is only recorded (TASK-1061 OD-5b).
    assert _check(decision, "response_toxicity").action_taken == "unverified"
    assert _check(decision, "response_safety").action_taken == "ignore"
    assert decision.guardrail_decision == "unverified"


# ── a stored row that still carries the key ──────────────────────────────────


class _Log:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def info(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def warning(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def error(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def exception(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))


def _app_state(policy: dict[str, Any] | None) -> Any:
    taxonomy = {
        "tasks": {name: {"labels": ["benign", "flag"]} for name in screening_mod.OUTBOUND_TASKS},
        "labels": ["PERSON"],
    }
    cfg = SimpleNamespace(
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
            return cfg

    return SimpleNamespace(
        settings=Settings(),
        http_client=object(),
        tenant_config_resolver=_Resolver(),
        circuit_breakers=None,
        effective_config_client=None,
    )


@pytest.mark.asyncio
async def test_a_stored_retired_key_is_ignored_and_logged_once(monkeypatch: Any) -> None:
    from guardrail.core.dependencies import build_screener

    log = _Log()
    monkeypatch.setattr(dependencies_mod, "logger", log)
    monkeypatch.setattr(dependencies_mod, "_RETIRED_KEYS_LOGGED", set(), raising=False)
    state = _app_state({"outboundRecordOnlyChecks": ["jailbreak_detection", "response_safety"]})

    first = await build_screener(state, TENANT)
    await build_screener(state, TENANT)

    assert not hasattr(first, "outbound_record_only")
    retired = [kw for name, kw in log.events if name == "guardrail.policy.retired_key_ignored"]
    assert len(retired) == 1
    assert retired[0]["key"] == "outboundRecordOnlyChecks"
    assert not [name for name, _kw in log.events if name.endswith("error")]
