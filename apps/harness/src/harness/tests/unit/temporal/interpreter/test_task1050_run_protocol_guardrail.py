"""TASK-1050 W2f — the run-protocol v2 guardrail additions, Python mirror parity.

Held to the OVERLAY fixture ``tests/contracts/guardrail-run-events.fixture.json`` (merged into
``run-protocol.fixture.json`` by every reader) and the vocabulary fixture
``tests/contracts/guardrail-vocabulary.fixture.json`` — the same assertions
``packages/async-contract/src/__tests__/run-protocol.guardrail.task1050.test.ts`` makes of the TS
copy (README §9.7.3, §9.8.1).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter import run_protocol as rp

_CONTRACTS = Path(__file__).resolve().parents[8] / "tests" / "contracts"
_OVERLAY: dict[str, Any] = json.loads(
    (_CONTRACTS / "guardrail-run-events.fixture.json").read_text(encoding="utf-8")
)
_VOCABULARY: dict[str, Any] = json.loads(
    (_CONTRACTS / "guardrail-vocabulary.fixture.json").read_text(encoding="utf-8")
)


class TestCatalogue:
    def test_the_two_new_types_are_public_and_the_trace_stays_admin(self) -> None:
        assert "guardrail.notice" in rp.PUBLIC_RUN_EVENT_TYPES
        assert "run.paused" in rp.PUBLIC_RUN_EVENT_TYPES
        for type_, visibility in _OVERLAY["visibility"].items():
            assert rp.RUN_EVENT_VISIBILITY[type_] == visibility, type_
        assert rp.RUN_EVENT_VISIBILITY["guardrail.inbound"] == "admin"
        assert rp.RUN_EVENT_VISIBILITY["guardrail.outbound"] == "admin"

    def test_node_scope(self) -> None:
        for type_, scope in _OVERLAY["nodeScope"].items():
            assert rp.RUN_EVENT_NODE_SCOPE[type_] == scope, type_

    def test_vocabulary_agrees_with_both_fixtures(self) -> None:
        assert list(rp.RUN_PAUSED_REASONS) == _OVERLAY["runPausedReasons"]
        assert list(rp.RUN_GUARDRAIL_EVENT_ACTIONS) == _OVERLAY["guardrailEventActions"]
        assert list(rp.RUN_GUARDRAIL_CHECK_IDS) == _VOCABULARY["checkIds"]
        assert rp.RUN_GUARDRAIL_NOTICE_TYPE_ACTION == _VOCABULARY["notice"]["typeAction"]
        assert rp.RUN_GUARDRAIL_NOTICE_MESSAGES == _VOCABULARY["notice"]["defaultMessages"]

    def test_guardrail_blocked_stays_the_run_error_code(self) -> None:
        assert rp.RUN_ERROR_MESSAGES["GUARDRAIL_BLOCKED"] == "A guardrail blocked the content."

    def test_correlation_and_override_headers(self) -> None:
        assert rp.GUARDRAIL_CORRELATION_HEADERS == _VOCABULARY["correlationHeaders"]
        assert rp.GUARDRAIL_OVERRIDE_HEADER == "X-Hope-Guardrail-Override"
        assert rp.GUARDRAIL_BLOCKED_PROBLEM_TYPE == _VOCABULARY["notice"]["blockedProblemType"]


@pytest.mark.parametrize("entry", _OVERLAY["examples"], ids=lambda e: e["name"])
def test_every_overlay_example_is_valid(entry: dict[str, Any]) -> None:
    problems = rp.run_event_problems(
        entry["event"], run_kind=entry.get("runKind"), plane=entry.get("plane")
    )
    assert problems == []


@pytest.mark.parametrize("notice", _OVERLAY["notices"], ids=lambda n: n["messageKey"])
def test_every_fixture_notice_is_a_valid_notice_payload(notice: dict[str, Any]) -> None:
    event = {
        "seq": 1,
        "runId": "r",
        "type": "guardrail.notice",
        "ts": "2026-10-07T09:15:00.000Z",
        "data": notice,
    }
    assert rp.run_event_problems(event, plane="public") == []
    assert rp.guardrail_notice_problems(notice) == []


@pytest.mark.parametrize("entry", _OVERLAY["invalid"], ids=lambda e: e["name"])
def test_every_overlay_invalid_entry_is_refused_by_name(entry: dict[str, Any]) -> None:
    problems = rp.run_event_problems(
        entry["event"], run_kind=entry.get("runKind"), plane=entry.get("plane")
    )
    assert problems
    assert entry["problem"] in "\n".join(problems)


def test_the_public_plane_passes_notice_and_paused_and_drops_the_trace() -> None:
    by_type = {entry["event"]["type"]: entry["event"] for entry in _OVERLAY["examples"]}
    assert rp.to_public_run_event(by_type["guardrail.notice"]) == by_type["guardrail.notice"]
    assert rp.to_public_run_event(by_type["run.paused"]) == by_type["run.paused"]
    assert rp.to_public_run_event(by_type["guardrail.inbound"]) is None


def test_a_notice_is_appended_without_a_node_and_paused_carries_its_node_in_data() -> None:
    notice = next(n for n in _OVERLAY["notices"] if n["type"] == "guardrail.unverified")
    command = rp.build_run_append(
        run_id="r", type="guardrail.notice", ts="2026-10-07T09:15:00.000Z", data=notice
    )
    assert "nodeId" not in command.args
    paused = rp.build_run_append(
        run_id="r",
        type="run.paused",
        ts="2026-10-07T09:15:00.000Z",
        data={"reason": "guardrail_hold", "noticeId": notice["noticeId"], "nodeId": "n_note"},
    )
    assert paused.args[paused.args.index("vis") + 1] == "public"


def test_guardrail_notice_problems_names_the_cross_field_rules() -> None:
    notice = dict(_OVERLAY["notices"][0])
    notice["defaultMessage"] = "Patient John Doe asked about …"
    assert any("fixed label" in p for p in rp.guardrail_notice_problems(notice))
    assert rp.guardrail_notice_problems({"type": 1}) != []
