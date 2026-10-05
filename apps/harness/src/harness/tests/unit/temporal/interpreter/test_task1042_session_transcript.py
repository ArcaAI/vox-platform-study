"""TASK-1042 — the ASR ``core.agent`` reads a LIVE STT session's transcript (C5 → C6).

When the ``audio`` port carries ``{sttSessionId}`` (directly, or one level inside the bound value)
and no blob reference, ``_run_transcription`` hands over to ``_run_session_transcript``: ONE C5
read through the gateway client (``X-Service-Token``, ``X-Tenant-Id``, ``runId``), by which time
the walk's durable wait (OD-4a) has already seen the session leave ``live``.

* ``ended`` → SUCCEEDED with the C6 output ``{transcript, segments, language}`` (``segments`` =
  the finals as ``{text, start, end, speaker}``) and the ``transcript.final`` admin event;
* ``truncated`` → ``transcript_truncated`` (OD-9: never a silently short transcript);
* ``timeout``, or still ``live`` past the wait's ceiling → ``live_audio_timeout``;
* 404 (not this tenant's, not bound to this run) → ``live_audio_unbound``.

A node activity cannot report ``FAILED`` (``NodeActivityResult.status``); those three are
``DEGRADED`` results with no output, named by their reason and their trajectory error code. The
blob path is untouched.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services.api_client import ApiClientError, ApiServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

_ASR_WIRE: dict[str, Any] = {
    "agentId": "agent-asr-1",
    "slug": "dictation",
    "versionNumber": 3,
    "task": "SPEECH_TO_TEXT",
    "model": {"slug": "whisper", "provider": "local", "sourceUri": "openai/whisper"},
    "parameters": {},
}

_ENDED = {
    "state": "ended",
    "language": "en",
    "transcript": "hello there doctor",
    "finals": [
        {"text": "hello there", "utteranceIndex": 0, "start": 0.0, "end": 1.2, "speaker": "A"},
        {"text": "doctor", "utteranceIndex": 1},
    ],
}


class _StubApi:
    def __init__(self, transcript: Any) -> None:
        self.transcript = transcript
        self.calls: list[dict[str, Any]] = []

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return _ASR_WIRE

    async def get_stt_session_transcript(
        self, session_id: str, *, tenant_id: str, run_id: str
    ) -> dict[str, Any]:
        self.calls.append({"session_id": session_id, "tenant_id": tenant_id, "run_id": run_id})
        if isinstance(self.transcript, Exception):
            raise self.transcript
        return self.transcript


class _Producer:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def append(self, **kwargs: Any) -> None:
        self.events.append(kwargs)


@pytest.fixture
def flushed(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []

    async def _record(*_args: Any, **kwargs: Any) -> None:
        seen.append(kwargs)

    monkeypatch.setattr(core, "record_and_flush", _record)
    return seen


@pytest.fixture
def producer(monkeypatch: pytest.MonkeyPatch) -> _Producer:
    import harness.temporal.interpreter.activities as interpreter_activities

    recorder = _Producer()
    monkeypatch.setattr(interpreter_activities, "run_event_producer", lambda: recorder)
    return recorder


@pytest.fixture
def batch(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """The BLOB path's dispatch, stubbed: records what it was asked."""
    import harness.temporal.activities as activities_module
    from harness.temporal.models import DispatchBatchTranscriptionOutput

    seen: list[Any] = []

    async def _dispatch(payload: Any) -> Any:
        seen.append(payload)
        return DispatchBatchTranscriptionOutput(job_id="job-1", status="COMPLETED")

    monkeypatch.setattr(activities_module, "dispatch_batch_transcription", _dispatch)
    return seen


def _install(monkeypatch: pytest.MonkeyPatch, transcript: Any) -> _StubApi:
    stub = _StubApi(transcript)
    monkeypatch.setattr(core, "_api_client", lambda _settings: stub)
    return stub


def _payload(audio: Any, **overrides: Any) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "n_asr",
        "node_type": "core.agent",
        "config": {"agentRef": {"slug": "dictation"}},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {"audio": audio},
        "run_payload": {},
        "run_id": _RUN,
    }
    base.update(overrides)
    return NodeActivityInput(**base)


class TestAnEndedSession:
    async def test_it_succeeds_with_the_c6_output(self, monkeypatch, flushed, producer):
        _install(monkeypatch, _ENDED)

        result = await core.interpreter_core_agent(_payload({"sttSessionId": "stt-1"}))

        assert result.status == "SUCCEEDED", result.reason
        assert result.output is not None
        assert result.output["transcript"] == "hello there doctor"
        assert result.output["language"] == "en"
        assert result.output["segments"] == [
            {"text": "hello there", "start": 0.0, "end": 1.2, "speaker": "A"},
            {"text": "doctor", "start": None, "end": None, "speaker": None},
        ]
        assert flushed[-1].get("error_code") is None

    async def test_it_reads_c5_once_for_this_run_and_tenant(self, monkeypatch, flushed, producer):
        stub = _install(monkeypatch, _ENDED)

        await core.interpreter_core_agent(_payload({"sttSessionId": "stt-1"}))

        assert stub.calls == [{"session_id": "stt-1", "tenant_id": _TENANT, "run_id": _RUN}]

    async def test_a_missing_transcript_is_the_finals_joined(self, monkeypatch, flushed, producer):
        _install(monkeypatch, {**_ENDED, "transcript": None})

        result = await core.interpreter_core_agent(_payload({"sttSessionId": "stt-1"}))

        assert result.output["transcript"] == "hello there doctor"

    async def test_it_emits_the_transcript_final_admin_event(self, monkeypatch, flushed, producer):
        _install(monkeypatch, _ENDED)

        await core.interpreter_core_agent(_payload({"sttSessionId": "stt-1"}, protocol=2))

        finals = [e for e in producer.events if e["type"] == "transcript.final"]
        assert len(finals) == 1
        assert finals[0]["data"] == {"text": "hello there doctor"}
        assert finals[0]["node_id"] == "n_asr"

    async def test_the_session_id_may_sit_one_level_inside_the_bound_value(
        self, monkeypatch, flushed, producer
    ):
        """A legacy edge from the trigger hands the whole run input to `audio`."""
        stub = _install(monkeypatch, _ENDED)

        result = await core.interpreter_core_agent(
            _payload({"note": "x", "audio_stream": {"sttSessionId": "stt-9"}})
        )

        assert result.status == "SUCCEEDED", result.reason
        assert stub.calls[0]["session_id"] == "stt-9"


class TestASessionThatDidNotEndCleanly:
    @pytest.mark.parametrize(
        ("answer", "code"),
        [
            ({"state": "truncated", "finals": [{"text": "partial"}]}, "transcript_truncated"),
            ({"state": "timeout", "finals": []}, "live_audio_timeout"),
            ({"state": "live", "finals": [{"text": "still talking"}]}, "live_audio_timeout"),
            (ApiClientError("apps/api /x failed: 404", status_code=404), "live_audio_unbound"),
        ],
    )
    async def test_it_fails_by_name_and_returns_no_transcript(
        self, monkeypatch, flushed, producer, answer, code
    ):
        _install(monkeypatch, answer)

        result = await core.interpreter_core_agent(_payload({"sttSessionId": "stt-1"}, protocol=2))

        assert result.status == "DEGRADED"
        assert result.reason is not None and code in result.reason
        assert result.output is None
        assert flushed[-1]["error_code"] == code
        assert not [e for e in producer.events if e["type"] == "transcript.final"]

    async def test_a_transport_failure_raises_so_temporal_retries(
        self, monkeypatch, flushed, producer
    ):
        _install(monkeypatch, ApiServiceError("apps/api /x failed: connection refused"))

        with pytest.raises(ApiServiceError):
            await core.interpreter_core_agent(_payload({"sttSessionId": "stt-1"}))


class TestTheBlobPathIsUnchanged:
    async def test_a_blob_reference_still_batch_transcribes(
        self, monkeypatch, flushed, producer, batch
    ):
        stub = _install(monkeypatch, _ENDED)

        result = await core.interpreter_core_agent(_payload({"uri": "s3://bucket/a.wav"}))

        assert result.status == "SUCCEEDED", result.reason
        assert result.output["jobId"] == "job-1"
        assert batch[0].audio_uri == "s3://bucket/a.wav"
        assert stub.calls == []

    async def test_a_blob_reference_wins_over_a_session_id(
        self, monkeypatch, flushed, producer, batch
    ):
        stub = _install(monkeypatch, _ENDED)

        await core.interpreter_core_agent(
            _payload({"uri": "s3://bucket/a.wav", "sttSessionId": "stt-1"})
        )

        assert len(batch) == 1
        assert stub.calls == []

    async def test_an_empty_session_id_is_still_no_audio(self, monkeypatch, flushed, producer):
        stub = _install(monkeypatch, _ENDED)

        result = await core.interpreter_core_agent(_payload({"sttSessionId": ""}))

        assert result.status == "DEGRADED"
        assert flushed[-1]["error_code"] == "no_audio"
        assert stub.calls == []
