"""TASK-1050 W2f — the harness side of resuming a guardrail hold (README §9.8.1).

``POST /api/v1/internal/workflow-runs/{runId}/guardrail-resolution`` (service token) signals the
run's ``guardrail_resolution``: 404 for an unknown run, 409 when the run is not parked on that
notice (closed, no such hold, or a worker that predates the hold), else the signal is sent.
``limits.guardrailHoldTimeoutSeconds`` on the run start reaches the workflow input and widens the
``execution_timeout`` backstop by one hold. Same mocking pattern as ``test_interpreter_endpoints``:
the Temporal client is a MagicMock — no Temporal server.
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from temporalio.client import WorkflowQueryFailedError
from temporalio.service import RPCError, RPCStatusCode

from harness.temporal.interpreter import caps
from harness.temporal.interpreter.models import GuardrailHoldState, GuardrailResolutionSignal
from harness.tests.unit.api.test_interpreter_endpoints import _BASE, _HEADERS, _build
from harness.tests.unit.api.test_task1038_interpreter_start import _config_ref, _start

_NOTICE = "01927f6e-9999-7000-8000-0000000000ab"
_BODY = {"noticeId": _NOTICE, "resolution": "acknowledged", "by": "doctor-1"}


def _held(notice_id: str = _NOTICE) -> list[GuardrailHoldState]:
    return [GuardrailHoldState(noticeId=notice_id, nodeId="n_note", kind="blocked")]


async def _resolve(handle_setup, body=None, headers=None):
    app, client, handle, _settings = _build()
    handle_setup(handle)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        resp = await http.post(
            f"{_BASE}/workflow-runs/run-1/guardrail-resolution",
            headers=_HEADERS if headers is None else headers,
            json=_BODY if body is None else body,
        )
    return resp, client, handle


class TestTheRoute:
    @pytest.mark.asyncio
    async def test_a_parked_hold_is_signalled(self):
        def setup(handle):
            handle.query = AsyncMock(return_value=_held())

        resp, client, handle = await _resolve(setup)
        assert resp.status_code == 202, resp.text
        assert resp.json() == {
            "runId": "run-1",
            "noticeId": _NOTICE,
            "nodeId": "n_note",
            "resolution": "acknowledged",
            "signaled": True,
        }
        client.get_workflow_handle.assert_called_with("workflow-interpreter-run-1")
        handle.signal.assert_awaited_once()
        (_signal_ref, payload), _ = handle.signal.call_args
        assert payload == GuardrailResolutionSignal(
            noticeId=_NOTICE, resolution="acknowledged", by="doctor-1"
        )

    @pytest.mark.asyncio
    async def test_an_unknown_run_is_404(self):
        def setup(handle):
            handle.describe = AsyncMock(
                side_effect=RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
            )

        resp, _client, handle = await _resolve(setup)
        assert resp.status_code == 404
        handle.signal.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_closed_run_is_409(self):
        def setup(handle):
            handle.describe = AsyncMock(
                return_value=SimpleNamespace(
                    run_id="t", status=SimpleNamespace(name="COMPLETED"), start_time=None
                )
            )

        resp, _client, handle = await _resolve(setup)
        assert resp.status_code == 409
        handle.signal.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_run_not_paused_on_that_notice_is_409(self):
        def setup(handle):
            handle.query = AsyncMock(return_value=_held("another-notice"))

        resp, _client, handle = await _resolve(setup)
        assert resp.status_code == 409
        assert "not paused" in resp.json()["detail"]
        handle.signal.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_worker_without_the_hold_query_is_409(self):
        def setup(handle):
            handle.query = AsyncMock(side_effect=WorkflowQueryFailedError("unknown query"))

        resp, _client, handle = await _resolve(setup)
        assert resp.status_code == 409
        handle.signal.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "body",
        [
            {"noticeId": _NOTICE, "resolution": "skip_it", "by": "d"},
            {"noticeId": "", "resolution": "acknowledged", "by": "d"},
            {"noticeId": _NOTICE, "resolution": "acknowledged"},
            {"noticeId": _NOTICE, "resolution": "acknowledged", "by": "d", "extra": 1},
        ],
    )
    async def test_a_malformed_body_is_refused(self, body):
        resp, _client, handle = await _resolve(lambda h: None, body=body)
        assert resp.status_code == 422, resp.text
        handle.signal.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_the_service_token_is_required(self):
        resp, _client, handle = await _resolve(lambda h: None, headers={})
        assert resp.status_code in (401, 403)
        handle.signal.assert_not_awaited()


class TestTheHoldTimeoutLimit:
    @pytest.mark.asyncio
    async def test_it_reaches_the_workflow_input(self):
        wf_input, _, _ = await _start(limits={"guardrailHoldTimeoutSeconds": 900})
        assert wf_input.limits is not None
        assert wf_input.limits.guardrail_hold_timeout_seconds == 900

    @pytest.mark.asyncio
    async def test_absent_it_stays_absent(self):
        wf_input, _, _ = await _start()
        assert wf_input.limits is not None
        assert wf_input.limits.guardrail_hold_timeout_seconds is None

    @pytest.mark.asyncio
    async def test_one_hold_is_added_to_the_execution_timeout(self):
        _, kwargs, _ = await _start(
            configRef=await _config_ref(max_total=600),
            limits={"guardrailHoldTimeoutSeconds": 900},
        )
        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + 900 + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_an_over_ceiling_hold_adds_only_the_ceiling(self):
        _, kwargs, _ = await _start(
            configRef=await _config_ref(max_total=600),
            limits={"guardrailHoldTimeoutSeconds": 10_000_000},
        )
        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + caps.GUARDRAIL_HOLD_MAX_WAIT_SECONDS + caps.RUN_TIMEOUT_GRACE_SECONDS
        )


def test_the_hold_clamp_is_tighten_only() -> None:
    assert caps.guardrail_hold_wait_seconds(None) == caps.GUARDRAIL_HOLD_MAX_WAIT_SECONDS
    assert caps.guardrail_hold_wait_seconds(30) == 30
    assert caps.guardrail_hold_wait_seconds(10**9) == caps.GUARDRAIL_HOLD_MAX_WAIT_SECONDS
