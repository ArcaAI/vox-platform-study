"""TASK-849 lane B (step 5) — ``agentic.tts`` promoted from observable ``DEGRADED`` to REAL.

What this file pins is the SHAPE of the promotion, not merely that it happened:

1. **Synthesis is DISPATCHED, never performed here.** The node calls one activity
   (``dispatch_speech_synthesis``) which asks apps/api's internal harness mount to resolve the
   tenant's TTS configuration and call ``apps/tts``. The node resolves nothing and builds no
   client — the same reference-only posture ``agentic.stt`` already holds.
2. **The ARTIFACT is written to the claim-check store**, and the activity RESULT carries only the
   ref. Audio bytes must never reach Temporal history: the ceiling is 51,200 events / 50 MB per
   run, and a single 30-second WAV is ~1 MB on its own.
3. **Audio chunks travel the DELTA lane** — ``run_event_producer().emit_token_delta`` — which is
   lane A's single streaming entry point. A second bespoke audio transport is the specific thing
   this ticket's §5 risk table forbids.
4. **Every unresolvable binding still DEGRADES observably.** Promoting a node to "real" is only
   an improvement if its failure modes stay honest.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import agentic

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

#: Three chunks, so "the deltas concatenate back to the artifact" is a real claim rather than a
#: tautology over a single frame.
_CHUNKS = [b"RIFF\x00\x00\x00\x00WAVE", b"\x01\x02\x03\x04", b"\xfe\xff\x00\x10"]
_AUDIO = b"".join(_CHUNKS)


def _payload(**overrides: Any) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "tts1",
        "node_type": "agentic.tts",
        "config": {"providerConfigRef": {"taskKey": "tts.synthesize"}, "voiceRef": "clinical-en-1"},
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


@pytest.fixture(autouse=True)
def _no_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(agentic, "record_and_flush", _noop)


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
        result = await agentic.interpreter_agentic_tts(_payload())
        assert result.status == "SUCCEEDED", result.reason
        assert result.output is not None
        ref = result.output["audio"]
        assert ref["content_type"] == "audio/wav"
        assert ref["size"] == len(_AUDIO)
        assert ref["key"] and ref["bucket"] and ref["sha256"]

    async def test_the_node_asks_the_gateway_for_the_bound_text_and_voice(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        await agentic.interpreter_agentic_tts(_payload())
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
        result = await agentic.interpreter_agentic_tts(_payload())
        serialized = json.dumps(result.model_dump()).encode()
        assert _AUDIO not in serialized
        assert base64.b64encode(_AUDIO) not in serialized
        assert _AUDIO.hex().encode() not in serialized


class TestTheDeltaLane:
    async def test_every_audio_chunk_is_emitted_on_lane_As_delta_entry_point(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        await agentic.interpreter_agentic_tts(_payload())
        assert len(producer.deltas) == len(_CHUNKS)
        assert [d["sequence"] for d in producer.deltas] == [0, 1, 2]
        assert {d["run_id"] for d in producer.deltas} == {_RUN}
        assert {d["node_id"] for d in producer.deltas} == {"tts1"}
        assert {d["tenant_id"] for d in producer.deltas} == {_TENANT}

    async def test_the_deltas_decode_back_to_exactly_the_stored_artifact(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        await agentic.interpreter_agentic_tts(_payload())
        rebuilt = b"".join(base64.b64decode(d["text"]) for d in producer.deltas)
        assert rebuilt == _AUDIO

    async def test_a_run_with_no_run_id_still_synthesizes_and_simply_does_not_stream(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        # `run_id` is additive-optional (lane A). Losing the live view must never lose the audio.
        result = await agentic.interpreter_agentic_tts(_payload(run_id=""))
        assert result.status == "SUCCEEDED"
        assert producer.deltas == []


class TestItStillResolvesNothingItself:
    async def test_a_missing_voice_reference_degrades_rather_than_picking_one(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        result = await agentic.interpreter_agentic_tts(
            _payload(config={"providerConfigRef": {"taskKey": "tts.synthesize"}})
        )
        assert result.status == "DEGRADED"
        assert "voiceRef" in (result.reason or "")

    async def test_no_bound_text_degrades_rather_than_synthesizing_silence(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        result = await agentic.interpreter_agentic_tts(_payload(bound_inputs={}))
        assert result.status == "DEGRADED"
        assert "text" in (result.reason or "")

    async def test_no_tenant_degrades_because_synthesis_must_be_attributable(
        self, producer: _RecordingProducer, synthesized: dict[str, Any]
    ) -> None:
        result = await agentic.interpreter_agentic_tts(_payload(tenant_id=""))
        assert result.status == "DEGRADED"
        assert "tenant" in (result.reason or "")

    async def test_a_dispatch_failure_degrades_and_never_claims_an_artifact(
        self, producer: _RecordingProducer, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import harness.temporal.activities as activities_module

        async def _boom(_payload: Any) -> Any:
            raise RuntimeError("tts upstream 503")

        monkeypatch.setattr(activities_module, "dispatch_speech_synthesis", _boom)
        result = await agentic.interpreter_agentic_tts(_payload())
        assert result.status == "DEGRADED"
        assert not result.output
