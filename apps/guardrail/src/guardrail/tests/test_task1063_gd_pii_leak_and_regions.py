"""TASK-1063 lane GD — quasi-only `pii_leak` on a local model, the pii_leak retry, flaggedRegions.

* Item 2 (owner 2026-10-11): on a LOCAL provider, an outbound `pii_leak` flag whose labels are
  ALL quasi-identifiers (`piiLeakQuasiIdentifierLabels`) is taken at `ignore` — recorded only,
  no notice. Cloud keeps the follow-up-A block → warn downgrade. Never raises an action.
* Item 5a: the pii_leak span extraction gets ONE bounded retry when the engine timed out or
  answered 5xx (`NlpPeerTransientError`); a second failure stays undetermined → `unverified`
  (fail-closed, never a silent pass). Any other failure is not retried.
* Item 5b: every evaluation check that flags carries `flaggedRegions: [{key, trust, label,
  score}]` — region KEYS and labels only, never the screened text.

Fakes only: no peer, no model.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from guardrail.core.availability import GuardrailAvailability
from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.services.evaluation_outbox import build_evaluation_record
from guardrail.services.external_nlp_client import NlpGuardClient, NlpPeerTransientError
from guardrail.services.notices import GuardrailCorrelation, build_notices
from guardrail.services.screening import Screener

TENANT = "11111111-1111-1111-1111-111111111111"
QUASI = frozenset({"healthcare_facility", "city"})
SOURCE = "patient has a cough"
CORRELATION = GuardrailCorrelation(request_id="req-1", consultation_id="c-1")
AT = "2026-10-11T09:00:00.000Z"


class _Analyzer:
    """Each label in ``labels`` is reported over its UPPER-cased name in the response."""

    def __init__(self, labels: tuple[str, ...] = (), *, failures: list[Exception] | None = None):
        self.labels = labels
        self.failures = list(failures or [])
        self.pii_calls = 0
        self.unsafe_word: str | None = None

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        bad = bool(self.unsafe_word and self.unsafe_word in text)
        return {task: ["unsafe" if bad else "benign"] for task in task_names}

    async def extract_pii_entities(self, text: str) -> list[Any]:
        self.pii_calls += 1
        if self.failures:
            raise self.failures.pop(0)
        spans = []
        for label in self.labels:
            start = text.index(label.upper())
            spans.append(
                SimpleNamespace(label=label, start=start, end=start + len(label), score=0.9)
            )
        return spans

    def model_for(self, check: str) -> str:
        return "pii-model"


def _availability(action: str = "block", **extra: dict[str, Any]) -> GuardrailAvailability:
    checks: dict[str, Any] = {"pii_leak": {"enabled": True, "action": action}, **extra}
    return GuardrailAvailability.from_tiers(system_blob={"checks": checks}, tenant_blob=None)


def _response(labels: tuple[str, ...]) -> str:
    return "Seen at " + " and ".join(label.upper() for label in labels) + "."


async def _outbound(
    analyzer: _Analyzer,
    *,
    locality: str | None,
    action: str = "block",
    quasi: frozenset[str] = QUASI,
) -> tuple[Any, Any, list[dict[str, Any]], dict[str, Any]]:
    screener = Screener(
        analyzer=analyzer,
        tenant_id=TENANT,
        availability=_availability(action),
        pii_leak_quasi_identifier_labels=quasi,
        policy_version="pv-1",
    )
    decision = await screener.screen_outbound(
        _response(analyzer.labels),
        source_context=SOURCE,
        response_items=[("note-1", 2)],
        locality=locality,
    )
    notices = build_notices(
        decision, tenant_id=TENANT, correlation=CORRELATION, policy_version="pv-1", occurred_at=AT
    )
    record = build_evaluation_record(
        decision,
        tenant_id=TENANT,
        correlation=CORRELATION,
        caller="text.generate",
        notices=notices,
        occurred_at=AT,
    )
    pii = next(c for c in decision.checks if c.name == "pii_leak")
    return decision, pii, notices, record


def _record_check(record: dict[str, Any], name: str) -> dict[str, Any]:
    return next(c for c in record["checks"] if c["checkId"] == name)


# ── item 2: local + quasi-only is record-only ────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["block", "warn"])
async def test_local_quasi_only_pii_leak_is_ignored_with_no_notice(action: str) -> None:
    decision, pii, notices, record = await _outbound(
        _Analyzer(("healthcare_facility", "city")), locality="local", action=action
    )

    assert pii.effective_verdict == "flag"
    assert pii.effective_action_taken == "ignore"
    assert decision.guardrail_decision == "allow"
    assert decision.decision == "allow"
    assert notices == []
    assert record["noticeIds"] == []
    assert record["decision"] == "allow"
    entry = _record_check(record, "pii_leak")
    assert entry["actionTaken"] == "ignore"
    assert entry["reason"] == "recorded_as_finding"


@pytest.mark.asyncio
@pytest.mark.parametrize("locality", ["cloud", None])
async def test_cloud_quasi_only_pii_leak_still_warns(locality: str | None) -> None:
    decision, pii, notices, _record = await _outbound(
        _Analyzer(("healthcare_facility",)), locality=locality
    )

    assert pii.effective_action_taken == "warn"
    assert decision.guardrail_decision == "warn"
    assert [n["type"] for n in notices] == ["guardrail.warning"]


@pytest.mark.asyncio
async def test_local_pii_leak_with_a_direct_identifier_is_not_ignored() -> None:
    # `email` is not quasi: the TASK-1059 local detect-only rule (block → warn) applies.
    _decision, pii, notices, _record = await _outbound(
        _Analyzer(("city", "email")), locality="local"
    )

    assert pii.effective_action_taken == "warn"
    assert [n["type"] for n in notices] == ["guardrail.warning"]


@pytest.mark.asyncio
async def test_local_quasi_only_never_raises_an_ignore_action() -> None:
    _decision, pii, notices, _record = await _outbound(
        _Analyzer(("city",)), locality="local", action="ignore"
    )

    assert pii.effective_action_taken == "ignore"
    assert notices == []


@pytest.mark.asyncio
async def test_local_quasi_with_no_quasi_list_keeps_today_behaviour() -> None:
    _decision, pii, _notices, _record = await _outbound(
        _Analyzer(("city",)), locality="local", quasi=frozenset()
    )

    assert pii.effective_action_taken == "warn"


# ── item 5a: one bounded retry on a timeout / 5xx ───────────────────────────


def _transient() -> NlpPeerTransientError:
    return NlpPeerTransientError(
        REASON_ENGINE_ERROR, "apps/nlp pii delegation failed (TimeoutError)"
    )


@pytest.mark.asyncio
async def test_pii_leak_retries_once_after_a_timeout_and_then_decides() -> None:
    analyzer = _Analyzer(("email",), failures=[_transient()])
    _decision, pii, _notices, _record = await _outbound(analyzer, locality="cloud")

    assert analyzer.pii_calls == 2
    assert pii.effective_verdict == "flag"
    assert pii.effective_action_taken == "block"


@pytest.mark.asyncio
async def test_pii_leak_retries_only_once_then_is_unverified_never_a_pass() -> None:
    analyzer = _Analyzer(("email",), failures=[_transient(), _transient(), _transient()])
    decision, pii, notices, record = await _outbound(analyzer, locality="cloud")

    assert analyzer.pii_calls == 2
    assert pii.effective_verdict == "undetermined"
    assert pii.effective_action_taken == "unverified"
    assert decision.guardrail_decision == "unverified"
    assert [n["type"] for n in notices] == ["guardrail.unverified"]
    assert _record_check(record, "pii_leak")["reason"] == REASON_ENGINE_ERROR


@pytest.mark.asyncio
async def test_pii_leak_does_not_retry_a_non_transient_failure() -> None:
    analyzer = _Analyzer(
        ("email",), failures=[GuardrailUndeterminedError(REASON_ENGINE_ERROR, "HTTP 400")]
    )
    _decision, pii, _notices, _record = await _outbound(analyzer, locality="cloud")

    assert analyzer.pii_calls == 1
    assert pii.effective_verdict == "undetermined"


def _client(handler: Any) -> NlpGuardClient:
    return NlpGuardClient(
        base_url="http://nlp.invalid",
        service_token="t",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        tenant_id=TENANT,
        model_id="pii-model",
        retry_backoff_s=0.0,
    )


@pytest.mark.asyncio
async def test_client_marks_a_read_timeout_transient() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(NlpPeerTransientError) as caught:
        await _client(handler).extract_pii_entities("text")
    assert caught.value.reason == REASON_ENGINE_ERROR


@pytest.mark.asyncio
async def test_client_marks_a_5xx_transient() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "busy"})

    with pytest.raises(NlpPeerTransientError):
        await _client(handler).extract_pii_entities("text")


@pytest.mark.asyncio
async def test_client_does_not_mark_a_4xx_transient() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"detail": "bad"})

    with pytest.raises(GuardrailUndeterminedError) as caught:
        await _client(handler).extract_pii_entities("text")
    assert not isinstance(caught.value, NlpPeerTransientError)


# ── item 5b: flaggedRegions on every flagged check ──────────────────────────


@pytest.mark.asyncio
async def test_pii_leak_flag_records_its_region_and_labels_never_the_fragment() -> None:
    _decision, _pii, _notices, record = await _outbound(_Analyzer(("email",)), locality="cloud")

    entry = _record_check(record, "pii_leak")
    assert entry["flaggedRegions"] == [
        {"key": "response", "trust": None, "label": "email", "score": 0.9}
    ]
    assert "EMAIL" not in json.dumps(entry)


@pytest.mark.asyncio
async def test_inbound_classifier_flag_records_each_flagged_region_with_its_trust() -> None:
    analyzer = _Analyzer()
    analyzer.unsafe_word = "BADWORD"
    screener = Screener(
        analyzer=analyzer,
        tenant_id=TENANT,
        availability=GuardrailAvailability.from_tiers(
            system_blob={
                "checks": {"prompt_safety": {"enabled": True, "action": "warn"}},
            },
            tenant_blob=None,
        ),
        policy_version="pv-1",
    )
    decision = await screener.screen_inbound_regions(
        [
            ("system", "clinical rules", "instruction"),
            ("encounter_1", "patient said BADWORD twice", "data"),
            ("draft_ai", "the BADWORD note", "instruction"),
        ],
    )
    record = build_evaluation_record(
        decision,
        tenant_id=TENANT,
        correlation=CORRELATION,
        caller="text.generate",
        notices=[],
        occurred_at=AT,
    )

    entry = _record_check(record, "prompt_safety")
    assert entry["verdict"] == "flag"
    regions = entry["flaggedRegions"]
    assert {(r["key"], r["trust"], r["label"]) for r in regions} == {
        ("encounter_1", "data", "unsafe"),
        ("draft_ai", "instruction", "unsafe"),
    }
    assert all(set(r) == {"key", "trust", "label", "score"} for r in regions)
    dumped = json.dumps(regions)
    assert "BADWORD" not in dumped and "patient" not in dumped
    # A check that did not flag carries no flaggedRegions.
    assert all("flaggedRegions" not in c for c in record["checks"] if c["verdict"] != "flag")


@pytest.mark.asyncio
async def test_a_flag_with_no_region_detail_still_names_its_regions() -> None:
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        availability=GuardrailAvailability.from_tiers(
            system_blob={"checks": {"containment_echo": {"enabled": True, "action": "block"}}},
            tenant_blob=None,
        ),
        policy_version="pv-1",
    )
    decision = await screener.screen_outbound("echo NONCE-123 here", nonce="NONCE-123")
    record = build_evaluation_record(
        decision,
        tenant_id=TENANT,
        correlation=CORRELATION,
        caller="text.generate",
        notices=[],
        occurred_at=AT,
    )

    entry = _record_check(record, "containment_echo")
    assert entry["verdict"] == "flag"
    assert entry["flaggedRegions"] == [
        {"key": "response", "trust": None, "label": "envelope_echoed", "score": None}
    ]
