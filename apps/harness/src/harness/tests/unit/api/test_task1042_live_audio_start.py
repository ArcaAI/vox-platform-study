"""TASK-1042 C7 — the harness run start accepts the gateway-resolved ``liveAudio`` binding.

``liveAudio`` is a SERVER-resolved channel, like ``subject``: the gateway sets it only after its
run-start checks pass (C3), so the harness carries it onto ``InterpreterInput.live_audio`` and
nothing a caller composes in ``payload`` can create it. ``maxWaitSeconds`` is clamped
tighten-only to ``caps.LIVE_AUDIO_MAX_WAIT_SECONDS``; absent, the constant applies. The clamped
ceiling is added to the Temporal ``execution_timeout`` backstop (OD-4a), because the durable wait
is not charged to the compute budget.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from harness.temporal.interpreter import caps
from harness.tests.unit.api.test_interpreter_endpoints import _BASE, _HEADERS, _build, _start_body
from harness.tests.unit.api.test_task1038_interpreter_start import _config_ref, _start


async def _post(**body_overrides):
    app, _client, _handle, _settings = _build()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        return await http.post(
            f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body(**body_overrides)
        )


class TestTheLiveAudioField:
    @pytest.mark.asyncio
    async def test_it_reaches_the_workflow_input(self):
        wf_input, _, _ = await _start(liveAudio={"sttSessionId": "stt-1", "maxWaitSeconds": 120})

        assert wf_input.live_audio is not None
        assert wf_input.live_audio.stt_session_id == "stt-1"
        assert wf_input.live_audio.max_wait_seconds == 120

    @pytest.mark.asyncio
    async def test_absent_it_stays_absent(self):
        wf_input, _, _ = await _start()

        assert wf_input.live_audio is None

    @pytest.mark.asyncio
    async def test_the_wait_is_clamped_tighten_only_to_the_platform_ceiling(self):
        wf_input, _, _ = await _start(
            liveAudio={"sttSessionId": "stt-1", "maxWaitSeconds": 999_999}
        )

        assert wf_input.live_audio.max_wait_seconds == caps.LIVE_AUDIO_MAX_WAIT_SECONDS

    @pytest.mark.asyncio
    async def test_without_a_max_wait_the_platform_ceiling_applies(self):
        wf_input, _, _ = await _start(liveAudio={"sttSessionId": "stt-1"})

        assert wf_input.live_audio.max_wait_seconds == caps.LIVE_AUDIO_MAX_WAIT_SECONDS
        assert caps.LIVE_AUDIO_MAX_WAIT_SECONDS == 3600

    @pytest.mark.asyncio
    async def test_a_payload_cannot_create_it(self):
        """``payload`` is what a caller composed; ``live_audio`` exists only on its own channel."""
        wf_input, _, _ = await _start(payload={"liveAudio": {"sttSessionId": "stt-x"}})

        assert wf_input.live_audio is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "live_audio",
        [
            {"sttSessionId": ""},
            {"sttSessionId": "stt-1", "maxWaitSeconds": 0},
            {"sttSessionId": "stt-1", "maxWaitSeconds": -5},
            {"sttSessionId": "stt-1", "unexpected": True},
            {"maxWaitSeconds": 60},
        ],
    )
    async def test_a_malformed_binding_is_refused(self, live_audio):
        resp = await _post(liveAudio=live_audio)

        assert resp.status_code == 422, resp.text


class TestTheBackstop:
    @pytest.mark.asyncio
    async def test_the_clamped_wait_is_added_to_the_execution_timeout(self):
        _, kwargs, _ = await _start(
            configRef=await _config_ref(max_total=600),
            liveAudio={"sttSessionId": "stt-1", "maxWaitSeconds": 120},
        )

        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + 120 + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_an_over_ceiling_wait_adds_only_the_ceiling(self):
        _, kwargs, _ = await _start(
            configRef=await _config_ref(max_total=600),
            liveAudio={"sttSessionId": "stt-1", "maxWaitSeconds": 999_999},
        )

        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + caps.LIVE_AUDIO_MAX_WAIT_SECONDS + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_a_run_without_live_audio_is_unchanged(self):
        _, kwargs, _ = await _start(configRef=await _config_ref(max_total=600))

        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + caps.RUN_TIMEOUT_GRACE_SECONDS
        )


class TestCaps:
    def test_clamp_is_tighten_only(self):
        assert caps.live_audio_wait_seconds(None) == caps.LIVE_AUDIO_MAX_WAIT_SECONDS
        assert caps.live_audio_wait_seconds(30) == 30
        assert caps.live_audio_wait_seconds(10_000) == caps.LIVE_AUDIO_MAX_WAIT_SECONDS
