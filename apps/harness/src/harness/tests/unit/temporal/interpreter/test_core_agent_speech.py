"""``core.agent`` with a ``TEXT_TO_SPEECH`` agent — the speech path, and the shape of it.

TASK-893: this is ``test_task849_agentic_tts.py`` retargeted. ``agentic.tts`` left
``NODE_REGISTRY`` with the rest of the legacy vocabulary and its module is deleted; the activity
that synthesises speech now is ``interpreter.core_agent``, which dispatches on the RESOLVED
agent's task and lands in ``nodes/core.py::_run_speech``. Everything the lane-B promotion pinned
is still pinned, against the live path:

1. **Synthesis is DISPATCHED, never performed here.** The node calls one activity
   (``dispatch_speech_synthesis``) which asks apps/api's internal harness mount to resolve the
   tenant's TTS configuration and call ``apps/tts``. The node resolves nothing and builds no
   client.
2. **The ARTIFACT is written to the claim-check store**, and the activity RESULT carries only the
   ref. Audio bytes must never reach Temporal history: the ceiling is 51,200 events / 50 MB per
   run, and a single 30-second WAV is ~1 MB on its own.
3. **Audio chunks travel the DELTA lane** — ``run_event_producer().emit_token_delta`` — which is
   lane A's single streaming entry point. A second bespoke audio transport is the specific thing
   the risk table forbids.
4. **Every unresolvable binding still DEGRADES observably.**

Two assertions changed shape rather than being dropped. The voice is read from the RESOLVED
agent's ``parameters.voice`` instead of the node's ``voiceRef``, because selection moved to the
Agent. And ``agentic.tts``'s "no tenant id" degrade has no counterpart: ``core.agent`` resolves
its agent through the gateway FIRST, so an unattributable call fails at resolution — which is
covered by ``test_core_agent_resolution.py`` — rather than at the synthesis edge.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

#: Three chunks, so "the deltas concatenate back to the artifact" is a real claim rather than a
#: tautology over a single frame.
_CHUNKS = [b"RIFF\x00\x00\x00\x00WAVE", b"\x01\x02\x03\x04", b"\xfe\xff\x00\x10"]
_AUDIO = b"".join(_CHUNKS)

_TTS_WIRE: dict[str, Any] = {
    "agentId": "agent-tts-1",
    "slug": "clinical-voice",
    "versionNumber": 1,
    "task": "TEXT_TO_SPEECH",
    "model": {"slug": "kokoro", "provider": "local", "sourceUri": "hexgrad/Kokoro-82M"},
    "parameters": {"voice": "clinical-en-1"},
}


def _payload(**overrides: Any) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "tts1",
        "node_type": "core.agent",
        "config": {"agentRef": {"slug": "clinical-voice"}},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {"in": "Take two tablets daily."},
        "run_payload": {},
        "run_id": _RUN,
    }
    base.update(overrides)
    return NodeActivityInput(**base)


class _RecordingProducer:
    """Stands in for lane A's ``RunEventProducer``: records what the DELTA lane was asked to carry."""

    def __init__(self) -> None:
        self.deltas: list[dict[str, Any]] = []

    async def emit_token_delta(
        self, *, tenant_id: str, run_id: str, node_id: str, sequence: int, text: str
    ) -> str | None:
        self.deltas.append(
            {
                "tenant_id": tenant_id,
                "run_id": run_id,
                "node_id": node_id,
                "sequence": sequence,
                "text": text,
            }
        )
        return f"0-{sequence}"


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer


@pytest.fixture(autouse=True)
def _resolves_a_tts_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    monkeypatch.setattr(core, "_api_client", lambda _settings: _StubApi(_TTS_WIRE))


@pytest.fixture
def producer(monkeypatch: pytest.MonkeyPatch) -> _RecordingProducer:
    recorder = _RecordingProducer()
    import harness.temporal.interpreter.activities as interpreter_activities

    monkeypatch.setattr(interpreter_activities, "run_event_producer", lambda: recorder)
    return recorder


@pytest.fixture
def synthesized(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Stub the dispatch activity; capture what the node asked the gateway for."""
    import harness.temporal.activities as activities_module
    from harness.temporal.models import SpeechSynthesisResult

    seen: dict[str, Any] = {}

    async def _dispatch(payload: Any) -> SpeechSynthesisResult:
        seen["input"] = payload
        return SpeechSynthesisResult(
            chunks=list(_CHUNKS),
            content_type="audio/wav",
            provider="azure",
            characters=23,
        )

    monkeypatch.setattr(activities_module, "dispatch_speech_synthesis", _dispatch)
    return seen


class TestTheArtifactWrite:
    async def test_it_succeeds_and_publishes_a_claim_check_ref_for_the_audio(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        result = await core.interpreter_core_agent(_payload())
        assert result.status == "SUCCEEDED", result.reason
        assert result.output is not None
        ref = result.output["audio"]
        assert ref["content_type"] == "audio/wav"
        assert ref["size"] == len(_AUDIO)
        assert ref["key"] and ref["bucket"] and ref["sha256"]

    async def test_the_node_asks_the_gateway_for_the_bound_text_and_the_agents_voice(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        await core.interpreter_core_agent(_payload())
        sent = synthesized["input"]
        assert sent.tenant_id == _TENANT
        assert sent.text == "Take two tablets daily."
        assert sent.voice == "clinical-en-1"

    async def test_the_activity_RESULT_carries_no_audio_bytes(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        # The result is what Temporal persists. A ref is ~200 bytes; the audio is not in it, in
        # any encoding — checked by DECODING, because a base64 body defeats a substring search
        # (lane A's own finding).
        result = await core.interpreter_core_agent(_payload())
        serialized = json.dumps(result.model_dump()).encode()
        assert _AUDIO not in serialized
        assert base64.b64encode(_AUDIO) not in serialized
        assert _AUDIO.hex().encode() not in serialized


class TestTheDeltaLane:
    async def test_every_audio_chunk_is_emitted_on_lane_As_delta_entry_point(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        await core.interpreter_core_agent(_payload())
        assert len(producer.deltas) == len(_CHUNKS)
        assert [d["sequence"] for d in producer.deltas] == [0, 1, 2]
        assert {d["run_id"] for d in producer.deltas} == {_RUN}
        assert {d["node_id"] for d in producer.deltas} == {"tts1"}
        assert {d["tenant_id"] for d in producer.deltas} == {_TENANT}

    async def test_the_deltas_decode_back_to_exactly_the_stored_artifact(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        await core.interpreter_core_agent(_payload())
        rebuilt = b"".join(base64.b64decode(d["text"]) for d in producer.deltas)
        assert rebuilt == _AUDIO

    async def test_a_run_with_no_run_id_still_synthesizes_and_simply_does_not_stream(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        # `run_id` is additive-optional. Losing the live view must never lose the audio.
        result = await core.interpreter_core_agent(_payload(run_id=""))
        assert result.status == "SUCCEEDED"
        assert producer.deltas == []


class TestItStillResolvesNothingItself:
    async def test_an_agent_that_names_no_voice_degrades_rather_than_picking_one(
        self, producer: _RecordingProducer, synthesized: dict[str, Any],
        monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            core, "_api_client", lambda _settings: _StubApi({**_TTS_WIRE, "parameters": {}})
        )
        result = await core.interpreter_core_agent(_payload())
        assert result.status == "DEGRADED"
        assert "voice" in (result.reason or "")

    async def test_no_bound_text_degrades_rather_than_synthesizing_silence(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        result = await core.interpreter_core_agent(_payload(bound_inputs={}))
        assert result.status == "DEGRADED"
        assert "text" in (result.reason or "")

    async def test_a_sandbox_run_skips_the_artifact_write(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        # `core.agent` is not `external_write` on the TYPE — an LLM agent must run in a sandbox —
        # so the artifact write of a TTS agent is suppressed here instead.
        result = await core.interpreter_core_agent(_payload(sandbox=True))
        assert result.status == "SKIPPED"
        assert result.reason == "sandbox"

    async def test_a_dispatch_failure_degrades_and_never_claims_an_artifact(
        self, producer: _RecordingProducer, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import harness.temporal.activities as activities_module

        async def _boom(_payload: Any) -> Any:
            raise RuntimeError("tts upstream 503")

        monkeypatch.setattr(activities_module, "dispatch_speech_synthesis", _boom)
        result = await core.interpreter_core_agent(_payload())
        assert result.status == "DEGRADED"
        assert not result.output
