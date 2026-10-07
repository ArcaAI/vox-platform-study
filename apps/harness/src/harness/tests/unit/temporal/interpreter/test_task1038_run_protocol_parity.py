"""TASK-1038 R6 (lane B1) — run protocol v2, Python mirror parity.

``tests/contracts/run-protocol.fixture.json`` is the file
``packages/async-contract/src/__tests__/run-protocol.test.ts`` reads; ``protocol-v2.md`` §9 lists
what the Python mirror must assert: the constants, ``nodeScope``, ``agentRunNodeId``,
``errorMessages``, every ``examples`` entry valid under its ``runKind``/``plane``, every
``invalid`` entry refused with its ``problem``, the ``sse`` bytes, the sequencer Lua (byte for
byte) and, for each ``stored`` entry, the same EVAL ``keys`` and ``args`` (``body`` compared as
parsed JSON — consumers parse it, they never compare its bytes).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter import run_protocol as rp

_CONTRACTS = Path(__file__).resolve().parents[8] / "tests" / "contracts"
_BASE: dict[str, Any] = json.loads(
    (_CONTRACTS / "run-protocol.fixture.json").read_text(encoding="utf-8")
)
# TASK-1050: the guardrail additions ship as an OVERLAY every reader merges (maps into the base
# maps, lists appended), exactly as `run-protocol.test.ts` does — so these assertions cover the
# whole catalogue. The overlay's own vocabulary is asserted in `test_task1050_run_protocol_guardrail`.
_OVERLAY: dict[str, Any] = json.loads(
    (_CONTRACTS / "guardrail-run-events.fixture.json").read_text(encoding="utf-8")
)
_FIXTURE: dict[str, Any] = {
    **_BASE,
    "visibility": {**_BASE["visibility"], **_OVERLAY["visibility"]},
    "nodeScope": {**_BASE["nodeScope"], **_OVERLAY["nodeScope"]},
    "examples": [*_BASE["examples"], *_OVERLAY["examples"]],
    "invalid": [*_BASE["invalid"], *_OVERLAY["invalid"]],
}


class TestConstants:
    def test_protocol_selection_constants(self) -> None:
        assert rp.RUN_PROTOCOL_VERSION == _FIXTURE["protocolVersion"]
        assert rp.RUN_PROTOCOL_HEADER == _FIXTURE["header"]
        assert rp.RUN_PROTOCOL_QUERY_PARAM == _FIXTURE["query"]
        assert rp.RUN_RESULT_INLINE_MAX_BYTES == _FIXTURE["inlineResultMaxBytes"]

    def test_visibility_scope_and_agent_node_id(self) -> None:
        assert rp.RUN_EVENT_VISIBILITY == _FIXTURE["visibility"]
        assert rp.RUN_EVENT_NODE_SCOPE == _FIXTURE["nodeScope"]
        assert rp.AGENT_RUN_NODE_ID == _FIXTURE["agentRunNodeId"]

    def test_error_labels(self) -> None:
        assert rp.RUN_ERROR_MESSAGES == _FIXTURE["errorMessages"]
        assert rp.RUN_ERROR_FALLBACK_MESSAGE == _FIXTURE["errorFallbackMessage"]
        assert rp.run_error_message("NOT_LISTED") == _FIXTURE["errorFallbackMessage"]

    def test_sequencer_constants_and_the_lua_bytes(self) -> None:
        seq = _FIXTURE["sequencer"]
        assert rp.RUN_APPEND_LUA == seq["lua"]
        assert list(rp.RUN_STREAM_FIELDS) == seq["fields"]
        assert rp.RUN_STREAM_MAX_LEN == seq["maxLen"]
        assert rp.RUN_STREAM_CLOSED_ERROR == seq["closedError"]
        assert list(rp.TERMINAL_RUN_EVENT_TYPES) == seq["terminalTypes"]
        assert rp.run_seq_key("<runId>") == seq["keys"]["seq"]
        assert rp.run_events_key("<runId>") == seq["keys"]["events"]
        assert rp.run_dedupe_key("<runId>") == seq["keys"]["dedupe"]


@pytest.mark.parametrize("entry", _FIXTURE["examples"], ids=lambda e: e["name"])
def test_every_example_is_valid(entry: dict[str, Any]) -> None:
    problems = rp.run_event_problems(
        entry["event"], run_kind=entry.get("runKind"), plane=entry.get("plane")
    )
    assert problems == []


@pytest.mark.parametrize("entry", _FIXTURE["invalid"], ids=lambda e: e["name"])
def test_every_invalid_entry_is_refused_with_its_problem(entry: dict[str, Any]) -> None:
    problems = rp.run_event_problems(
        entry["event"], run_kind=entry.get("runKind"), plane=entry.get("plane")
    )
    assert any(entry["problem"] in problem for problem in problems), problems


@pytest.mark.parametrize("entry", _FIXTURE["sse"], ids=lambda e: e["name"])
def test_sse_frame_bytes(entry: dict[str, Any]) -> None:
    assert rp.to_sse_frame(entry["event"]) == entry["frame"]


@pytest.mark.parametrize("entry", _FIXTURE["stored"], ids=lambda e: e["name"])
def test_an_append_builds_the_fixture_command(entry: dict[str, Any]) -> None:
    append = entry["append"]
    command = rp.build_run_append(
        run_id=append["runId"],
        type=append["type"],
        ts=append["ts"],
        node_id=append.get("nodeId"),
        data=append["data"],
        dedupe_key=append.get("dedupeKey"),
        retention_seconds=append.get("retentionSeconds"),
    )
    assert command.keys == entry["command"]["keys"]
    expected_args = entry["command"]["args"]
    assert command.args[:-1] == expected_args[:-1]
    assert json.loads(command.args[-1]) == json.loads(expected_args[-1])
    assert all(isinstance(arg, str) for arg in command.args)


@pytest.mark.parametrize("entry", _FIXTURE["stored"], ids=lambda e: e["name"])
def test_a_stored_entry_reads_back_as_its_event(entry: dict[str, Any]) -> None:
    parsed = rp.parse_stored_run_event(entry["append"]["runId"], entry["entry"])
    assert parsed["kind"] == "event"
    assert parsed["event"] == entry["event"]


class TestAppendRefusals:
    def test_a_synthetic_type_is_never_stored(self) -> None:
        with pytest.raises(rp.RunProtocolError):
            rp.build_run_append(run_id="r", type="ping", ts="2026-10-04T10:00:00.000Z", data={})

    def test_a_terminal_event_needs_retention(self) -> None:
        with pytest.raises(rp.RunProtocolError):
            rp.build_run_append(
                run_id="r",
                type="run.cancelled",
                ts="2026-10-04T10:00:00.000Z",
                data={"status": "CANCELED", "durationMs": 1},
            )

    def test_retention_only_on_a_terminal_event(self) -> None:
        with pytest.raises(rp.RunProtocolError):
            rp.build_run_append(
                run_id="r",
                type="node.started",
                ts="2026-10-04T10:00:00.000Z",
                node_id="n",
                data={"kind": "core.agent"},
                retention_seconds=60,
            )

    def test_a_terminal_append_of_a_run_started_before_injection_may_carry_no_retention(
        self,
    ) -> None:
        """Transition (one release): a run started before the gateway injected
        `retentionSeconds` appends its terminal event with `'0'`, so the gateway's own
        `EXPIRE … NX` backstop starts the clock — never a retention literal in the producer."""
        command = rp.build_run_append(
            run_id="r",
            type="run.cancelled",
            ts="2026-10-04T10:00:00.000Z",
            data={"status": "CANCELED", "durationMs": 1},
            allow_missing_retention=True,
        )
        assert command.args[1] == "0"


def test_the_public_plane_drops_admin_events_and_error_detail() -> None:
    admin = {"type": "output.data", "data": {"field": "text", "value": 1, "visibility": "admin"}}
    assert rp.run_event_audience(admin) == "admin"
    failed = {
        "seq": 3,
        "runId": "r",
        "type": "node.failed",
        "ts": "2026-10-04T10:00:00.000Z",
        "nodeId": "n",
        "data": {
            "durationMs": 1,
            "error": {
                "code": "MODEL_ERROR",
                "message": "The model returned an error.",
                "detail": "x",
            },
        },
    }
    public = rp.to_public_run_event(failed)
    assert public is not None and "detail" not in public["data"]["error"]
