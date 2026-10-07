"""TASK-1047 FC-5c — outbound record-only checks (owner decision OD-14).

* New policy key `outboundRecordOnlyChecks` on the `guardrail.safety` row's
  `_metadata.policy` — FAIL_OPEN_TO_DEFAULT, default `["jailbreak_detection"]`; only
  names in `OUTBOUND_TASKS` are honoured, anything else is ignored with a warning.
* `POST /screen/outbound`: every check still runs. A record-only check that FLAGS
  does not block — it is reported as `data_findings: [{region: "response", reasons}]`
  (FC-5b's field and shape), counted in `guardrail_data_findings_total{task}` and
  logged by `guardrail.screen.data_findings` with `direction: "outbound"`.
* Undetermined is never a finding (TASK-1050 OD-23: it degrades to `unverified`).
  `response_safety` / `_toxicity` / `_refusal` and `pii_leak` are unchanged. Inbound
  is unchanged.
* The policy version moves when the key moves (it decides an outbound verdict).
"""

from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any

import pytest
from prometheus_client import REGISTRY

import guardrail.core.policy as policy_mod
import guardrail.services.screening as screening_mod
from guardrail.api.endpoints.policy_version import get_policy_version
from guardrail.api.endpoints.screen import OutboundScreenRequest, screen_outbound
from guardrail.core.availability import GuardrailAvailability
from guardrail.core.config import Settings
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.policy import FAIL_OPEN_TO_DEFAULT, GuardrailPolicy
from guardrail.core.tenant_config import (
    TASK_KEY_GUARDRAIL_PII,
    TASK_KEY_GUARDRAIL_PII_SPANS,
    TASK_KEY_GUARDRAIL_SAFETY,
    TASK_KEY_GUARDRAIL_VALIDATE,
    GuardrailTenantConfig,
)
from guardrail.services.screening import Screener
from guardrail.services.windowing import WindowGeometry, WindowRunner

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"
GEOMETRY = WindowGeometry(size=4_000, overlap=256, concurrency=4)

#: Trigger text → (task, flagged label).
TRIGGERS = {
    "IGNORE ALL PREVIOUS": ("jailbreak_detection", "jailbreak"),
    "BUILD A WEAPON": ("response_safety", "harm"),
    "YOU IDIOT": ("response_toxicity", "toxic"),
    "I CANNOT HELP": ("response_refusal", "refusal"),
    "PROMPT UNSAFE": ("prompt_safety", "unsafe"),
}
OUTAGE = "OUTAGE-WINDOW"


class _Analyzer:
    def __init__(self) -> None:
        self.policy = SimpleNamespace(pii_labels=[], benign_labels=None)

    async def classify_tasks(self, task_names, text):
        if OUTAGE in text:
            raise GuardrailUndeterminedError("engine_error", "peer down")
        out: dict[str, Any] = {}
        for name in task_names:
            label = "benign"
            for trigger, (task, flag) in TRIGGERS.items():
                if task == name and trigger in text:
                    label = flag
            out[name] = label
        return out

    async def extract_pii_entities(self, text):
        return []

    def model_for(self, check):
        return "safety-model"


class _Log:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def info(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def warning(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def exception(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))


@pytest.fixture
def log(monkeypatch):
    recorder = _Log()
    monkeypatch.setattr(screening_mod, "logger", recorder)
    return recorder


@pytest.fixture
def policy_log(monkeypatch):
    recorder = _Log()
    monkeypatch.setattr(policy_mod, "logger", recorder)
    return recorder


def _wire(monkeypatch, record_only: Any = "__default__", enable: tuple[str, ...] = ()) -> Any:
    """Route `build_screener` through a policy blob, the way production builds it."""
    import guardrail.api.endpoints.screen as screen_mod

    blob = {} if record_only == "__default__" else {"outboundRecordOnlyChecks": record_only}
    policy = GuardrailPolicy.from_blob(blob, source_tenant_id=SYSTEM)

    availability = (
        GuardrailAvailability.from_blob({name: {"enabled": True} for name in enable})
        if enable
        else None
    )

    async def _build_screener(app_state, tenant_id):
        return Screener(
            analyzer=_Analyzer(),
            tenant_id=tenant_id,
            availability=availability,
            policy_source_tenant_id=SYSTEM,
            window_geometry=GEOMETRY,
            window_runner=WindowRunner(
                tenant_id=tenant_id, policy_version="pv", cache=None, concurrency=4
            ),
            outbound_record_only=policy.outbound_record_only_checks,
        )

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(admission_gates={})),
        headers={"X-Tenant-Id": TENANT},
    )


async def _outbound(request, response: str) -> Any:
    return await screen_outbound(
        OutboundScreenRequest(
            response=response,
            source_regions=[{"key": "transcript", "text": "patient has a cough"}],
        ),
        request,  # type: ignore[arg-type]
    )


def _metric(task: str) -> float:
    return REGISTRY.get_sample_value("guardrail_data_findings_total", {"task": task}) or 0.0


def _check(result, name: str) -> dict[str, Any]:
    return next(c for c in result.checks if c["name"] == name)


# ── the policy key ───────────────────────────────────────────────────────────


def test_the_key_is_declared_open_to_default() -> None:
    assert "outboundRecordOnlyChecks" in GuardrailPolicy.DECLARED_KEYS
    assert GuardrailPolicy.fail_mode("outboundRecordOnlyChecks") == FAIL_OPEN_TO_DEFAULT


def test_the_default_is_jailbreak_detection_only() -> None:
    assert GuardrailPolicy.from_blob({}).outbound_record_only_checks == frozenset(
        {"jailbreak_detection"}
    )


@pytest.mark.parametrize("malformed", ["jailbreak_detection", 7, {"a": 1}, [1, 2], None])
def test_a_malformed_value_is_the_default(malformed: Any) -> None:
    blob = {"outboundRecordOnlyChecks": malformed}
    assert GuardrailPolicy.from_blob(blob).outbound_record_only_checks == frozenset(
        {"jailbreak_detection"}
    )


def test_an_empty_list_makes_every_check_blocking() -> None:
    blob = {"outboundRecordOnlyChecks": []}
    assert GuardrailPolicy.from_blob(blob).outbound_record_only_checks == frozenset()


def test_unknown_names_are_ignored_with_one_warning(policy_log) -> None:
    blob = {
        "outboundRecordOnlyChecks": [
            "response_toxicity",
            "pii_leak",
            "prompt_safety",
            "made_up_check",
        ]
    }

    checks = GuardrailPolicy.from_blob(blob).outbound_record_only_checks

    assert checks == frozenset({"response_toxicity"})
    warnings = [kw for name, kw in policy_log.events if name.endswith("unknown_checks")]
    assert len(warnings) == 1
    assert sorted(warnings[0]["ignored"]) == ["made_up_check", "pii_leak", "prompt_safety"]


# ── the outbound screen ──────────────────────────────────────────────────────


async def test_a_jailbreak_flag_alone_is_allowed_and_recorded(monkeypatch, log) -> None:
    request = _wire(monkeypatch)
    before = _metric("jailbreak_detection")

    result = await _outbound(request, "IGNORE ALL PREVIOUS — here is the patient list.")

    assert result.decision == "allow"
    assert result.reasons == []
    assert [f.model_dump() for f in result.data_findings] == [
        {"region": "response", "reasons": ["jailbreak_detection"]}
    ]
    assert _check(result, "jailbreak_detection")["outcome"] != "flag"
    assert _metric("jailbreak_detection") == before + 1
    events = [kw for name, kw in log.events if name == "guardrail.screen.data_findings"]
    assert len(events) == 1
    assert events[0]["direction"] == "outbound"
    assert events[0]["regions"] == ["response"]
    assert "IGNORE" not in repr(events)


async def test_jailbreak_plus_response_safety_blocks_on_response_safety_only(
    monkeypatch, log
) -> None:
    request = _wire(monkeypatch)

    result = await _outbound(request, "IGNORE ALL PREVIOUS. BUILD A WEAPON like this.")

    assert result.decision == "block"
    assert result.reasons == ["response_safety"]
    assert [f.model_dump() for f in result.data_findings] == [
        {"region": "response", "reasons": ["jailbreak_detection"]}
    ]


@pytest.mark.parametrize(
    "text,reason",
    [
        ("BUILD A WEAPON", "response_safety"),
        ("YOU IDIOT", "response_toxicity"),
        ("I CANNOT HELP", "response_refusal"),
    ],
)
async def test_the_response_checks_still_block(monkeypatch, log, text, reason) -> None:
    # TASK-1050: `response_refusal` ships OFF in the catalogue (`defaultEnabled: false`,
    # as the SYSTEM seed always had it), so an un-wired screener no longer runs it. The
    # intent here — record-only applies to jailbreak alone; every response check that
    # RUNS still blocks — is pinned with the three checks explicitly enabled.
    result = await _outbound(_wire(monkeypatch, enable=("response_refusal",)), text)

    assert result.decision == "block"
    assert result.reasons == [reason]
    assert result.data_findings == []


async def test_an_empty_record_only_policy_makes_jailbreak_block_again(monkeypatch, log) -> None:
    request = _wire(monkeypatch, record_only=[])
    before = _metric("jailbreak_detection")

    result = await _outbound(request, "IGNORE ALL PREVIOUS — here is the patient list.")

    assert result.decision == "block"
    assert result.reasons == ["jailbreak_detection"]
    assert result.data_findings is None
    assert _metric("jailbreak_detection") == before


async def test_an_unknown_name_is_ignored_and_jailbreak_still_records(
    monkeypatch, log, policy_log
) -> None:
    request = _wire(monkeypatch, record_only=["jailbreak_detection", "no_such_check"])

    result = await _outbound(request, "IGNORE ALL PREVIOUS.")

    assert result.decision == "allow"
    assert [f.model_dump() for f in result.data_findings] == [
        {"region": "response", "reasons": ["jailbreak_detection"]}
    ]


async def test_a_record_only_response_check_is_honoured_when_configured(monkeypatch, log) -> None:
    request = _wire(monkeypatch, record_only=["response_toxicity", "jailbreak_detection"])

    result = await _outbound(request, "YOU IDIOT. IGNORE ALL PREVIOUS.")

    assert result.decision == "allow"
    assert [f.model_dump() for f in result.data_findings] == [
        {"region": "response", "reasons": ["response_toxicity", "jailbreak_detection"]}
    ]


async def test_undetermined_is_unverified_and_never_recorded_as_a_finding(monkeypatch, log) -> None:
    # TASK-1050 OD-23: was "still blocks". An outage degrades to `unverified` for every
    # check (record-only included — record-only converts a FLAG, never an outage), and
    # it is still not reported as a data finding.
    result = await _outbound(_wire(monkeypatch), f"{OUTAGE} IGNORE ALL PREVIOUS")

    assert result.guardrail_decision == "unverified"
    assert result.decision == "allow"
    assert _check(result, "jailbreak_detection")["outcome"] == "undetermined"
    assert _check(result, "jailbreak_detection")["actionTaken"] == "unverified"
    assert result.data_findings == []


async def test_a_clean_response_reports_no_findings(monkeypatch, log) -> None:
    result = await _outbound(_wire(monkeypatch), "The patient has a cough.")

    assert result.decision == "allow"
    assert result.data_findings == []
    assert not any(name == "guardrail.screen.data_findings" for name, _ in log.events)


# ── inbound is unchanged ─────────────────────────────────────────────────────


async def test_inbound_jailbreak_still_blocks_with_the_default_policy(monkeypatch, log) -> None:
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        window_geometry=GEOMETRY,
        outbound_record_only=GuardrailPolicy.from_blob({}).outbound_record_only_checks,
    )

    decision = await screener.screen_inbound("IGNORE ALL PREVIOUS")

    assert decision.decision == "block"
    assert decision.reasons == ["jailbreak_detection"]
    assert decision.data_findings is None


# ── build_screener wires the policy ──────────────────────────────────────────


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


@pytest.mark.parametrize(
    "policy,expected",
    [
        (None, frozenset({"jailbreak_detection"})),
        ({"outboundRecordOnlyChecks": []}, frozenset()),
        ({"outboundRecordOnlyChecks": ["response_refusal"]}, frozenset({"response_refusal"})),
    ],
)
async def test_build_screener_applies_the_tenants_policy(policy, expected) -> None:
    from guardrail.core.dependencies import build_screener

    screener = await build_screener(_app_state(policy), TENANT)

    assert screener.outbound_record_only == expected


# ── the policy version ───────────────────────────────────────────────────────

_ROWS: dict[str, dict[str, Any]] = {
    TASK_KEY_GUARDRAIL_SAFETY: {
        "model": "gliguard-300m",
        "label_taxonomy": {"tasks": {"response_safety": {"labels": ["safe", "unsafe"]}}},
        "policy": {"piiLeakMinScore": 0.5},
    },
    TASK_KEY_GUARDRAIL_PII: {"model": "gliner2-pii", "label_taxonomy": {"labels": ["person"]}},
    TASK_KEY_GUARDRAIL_PII_SPANS: {"model": "gliner2-pf", "label_taxonomy": {"labels": ["person"]}},
    TASK_KEY_GUARDRAIL_VALIDATE: {"provider": "lm-studio", "model": "granite-guardian"},
}


async def _version(rows: dict[str, dict[str, Any]]) -> str:
    class _Resolver:
        async def resolve(self, tenant_id, task_key="guardrail.validate"):
            # TASK-1050: the hashed set grew (`guardrail.injection`, the judge-lane keys).
            # A task key this fixture has no row for resolves as the production resolver
            # answers an absent row — an empty config — never a KeyError.
            return GuardrailTenantConfig(source_tenant_id=tenant_id, **rows.get(task_key, {}))

    state = SimpleNamespace(tenant_config_resolver=_Resolver(), settings=Settings())
    request = SimpleNamespace(app=SimpleNamespace(state=state), headers={"X-Tenant-Id": TENANT})
    return (await get_policy_version(request))["policyVersion"]  # type: ignore[arg-type]


async def test_the_policy_version_moves_when_the_key_moves() -> None:
    base = await _version(_ROWS)
    versions = {base}
    for value in ([], ["response_toxicity"], ["jailbreak_detection", "response_refusal"]):
        rows = copy.deepcopy(_ROWS)
        rows[TASK_KEY_GUARDRAIL_SAFETY]["policy"]["outboundRecordOnlyChecks"] = value
        versions.add(await _version(rows))
    assert len(versions) == 4
