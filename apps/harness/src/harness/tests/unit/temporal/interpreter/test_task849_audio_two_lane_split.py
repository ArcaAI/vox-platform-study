"""lane B — binary audio obeys the two-lane split, MEASURED.

Lane A proved the split for TEXT deltas. This proves it for the case OD-4 actually put at risk:
**audio**, where one node's payload is measured in megabytes rather than characters, and where a
careless implementation blows the 50 MB per-run BYTE ceiling long before it approaches the
51,200-event one.

The method is lane A's, reused deliberately (``test_task849_two_lane_split.py``): the SAME graph
runs twice against a real ephemeral Temporal server — once with a small artifact, once with one
1000x larger — walked by the real ``WorkflowInterpreter`` through the real, registered
``interpreter.agentic_tts`` activity. Only the Redis socket and the upstream synthesis call are
faked.

Two things this file inherits from lane A's own negative probe and must not lose:

* **Temporal base64-encodes payload bodies**, so a substring search over ``to_json()`` passes
  whether or not the audio is in there. Every content assertion here is on DECODED bytes.
* **An equality that also holds when nothing was emitted proves nothing.** The delta assertions
  check that the frames genuinely landed AND concatenate back to the exact artifact.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid
from typing import Any

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import harness.temporal.activities as harness_activities
from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.run_events import EVENT_TOKEN_DELTA, run_event_stream_key
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.temporal.models import SpeechSynthesisResult

_BUCKET = "harness-claim-check"
TENANT = "22222222-2222-2222-2222-222222222222"

#: One 32 KiB frame vs a thousand of them — 32 KiB against 32 MB of audio, which on its own
#: exceeds the 50 MB per-run history ceiling's safe headroom if it ever reached Temporal.
SMALL_FRAMES = 1
LARGE_FRAMES = 1000
FRAME_BYTES = 32 * 1024


#: A recognisable, DECODABLE marker at the head of every frame, so a decoded-history search has
#: something unambiguous to look for. `b"\xff"` padding keeps the frame non-utf-8, which is the
#: point: audio is not text, and a store or a payload that quietly decoded it would be wrong.
def _frame(index: int) -> bytes:
    marker = f"AUDIOFRAME{index:06d}".encode("ascii")
    return marker + b"\xff" * (FRAME_BYTES - len(marker))


def _audio(frames: int) -> list[bytes]:
    return [_frame(i) for i in range(frames)]


class FakeRedisStream:
    def __init__(self) -> None:
        self.by_key: dict[str, list[dict]] = {}
        self._seq = 0

    async def xadd(self, key, fields, maxlen=None, approximate=None):  # noqa: ANN001
        self._seq += 1
        self.by_key.setdefault(key, []).append(json.loads(fields["data"]))
        return f"{self._seq}-0"


def _decoded_history_payloads(history_json: str) -> bytes:
    """Every payload body in a history, base64-DECODED and concatenated as raw bytes.

    Lane A's helper decoded to `str` because it was hunting for token text. Audio has no valid
    utf-8 decoding, so decoding to text would mangle exactly the bytes being searched for; this
    variant keeps them raw.
    """
    chunks: list[bytes] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "data" and isinstance(value, str):
                    try:
                        chunks.append(base64.b64decode(value))
                    except (ValueError, binascii.Error):
                        pass
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(json.loads(history_json))
    return b"".join(chunks)


def _body() -> dict:
    """A real two-node graph: `agentic.input` → `agentic.tts`.

    No registry monkeypatching — both are the SHIPPED node specs, wired by a real edge, so the
    text the TTS node synthesizes arrives the way it does in production (bound on the `in` port
    from a predecessor's output) rather than being hand-injected into the activity payload.
    """
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "audio-split-test",
        "versionNumber": 1,
        "tenantId": TENANT,
        "paletteKey": "agentic",
        "compiledAt": "2026-09-02T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "src",
                        "type": "agentic.input",
                        "activity": "interpreter.agentic_input",
                        "config": {"sourceKey": "text"},
                        "timeoutSeconds": 30,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [],
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    }
                ],
            },
            {
                "stageIndex": 1,
                "nodes": [
                    {
                        "nodeId": "speak",
                        "type": "agentic.tts",
                        "activity": "interpreter.agentic_tts",
                        "config": {
                            "providerConfigRef": {"taskKey": "tts.synthesize"},
                            "voiceRef": "clinical-en-1",
                        },
                        "timeoutSeconds": 300,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [{"fromNodeId": "src", "fromPort": "out", "toPort": "in"}],
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    }
                ],
            },
        ],
        "gates": [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": 3600, "maxNodeSeconds": 900, "maxAttempts": 5},
    }


async def _run_with(
    frames: int, redis: FakeRedisStream, monkeypatch: pytest.MonkeyPatch
) -> tuple[str, dict[str, Any]]:
    """Run the one-node graph once. Returns `(run_id, {"events": n, "history_json": str})`."""
    chunks = _audio(frames)

    async def _dispatch(_payload: Any) -> SpeechSynthesisResult:
        return SpeechSynthesisResult(chunks=chunks, content_type="audio/wav", provider="azure")

    monkeypatch.setattr(harness_activities, "dispatch_speech_synthesis", _dispatch)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)

    body = _body()
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )
    run_id = str(uuid.uuid4())

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"audio-split-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=INTERPRETER_ACTIVITIES,
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=TENANT,
                    run_id=run_id,
                    payload={"text": "Take two tablets daily."},
                ),
                id=f"wf-audio-{uuid.uuid4()}",
                task_queue=tq,
            )
            result = await handle.result()
            history = await handle.fetch_history()

    return run_id, {
        "events": len(history.events),
        "history_json": history.to_json(),
        "status": result.status,
    }


class TestAudioNeverEntersTemporalHistory:
    @pytest.mark.asyncio
    async def test_a_thousandfold_larger_artifact_adds_no_proportional_history(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """THE measurement, for audio. 32 KiB and 32 MB must produce the same history size."""
        small_redis = FakeRedisStream()
        small_run, small = await _run_with(SMALL_FRAMES, small_redis, monkeypatch)
        large_redis = FakeRedisStream()
        large_run, large = await _run_with(LARGE_FRAMES, large_redis, monkeypatch)

        # The audio really was produced and really did travel the delta lane — without this the
        # equality below would also hold for a node that synthesised nothing.
        small_deltas = [
            e
            for e in small_redis.by_key[run_event_stream_key(small_run)]
            if e["type"] == EVENT_TOKEN_DELTA
        ]
        large_deltas = [
            e
            for e in large_redis.by_key[run_event_stream_key(large_run)]
            if e["type"] == EVENT_TOKEN_DELTA
        ]
        assert len(small_deltas) == SMALL_FRAMES
        assert len(large_deltas) == LARGE_FRAMES

        print(
            f"\n[ lane B audio split, measured] "
            f"audio_bytes={SMALL_FRAMES * FRAME_BYTES} -> temporal_history_events={small['events']}"
            f" | audio_bytes={LARGE_FRAMES * FRAME_BYTES} -> "
            f"temporal_history_events={large['events']} | "
            f"history_bytes={len(large['history_json'])}"
        )

        assert large["events"] == small["events"], (
            f"Temporal history grew with audio size: {small['events']} events for "
            f"{SMALL_FRAMES} frame(s) vs {large['events']} for {LARGE_FRAMES}. "
            "Something is routing audio through Temporal — see program §3.4 rule 17."
        )
        assert large["events"] < 100

    @pytest.mark.asyncio
    async def test_no_history_payload_carries_audio_bytes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The byte-ceiling half of the same limit, which an event count cannot see.

        Folding the artifact into the node's `output` adds no EVENTS at all — it just makes each
        one enormous. Searched on DECODED bytes: Temporal base64s payload bodies, so a raw-JSON
        substring search is vacuous (lane A verified that the hard way).
        """
        small_redis = FakeRedisStream()
        _small_run, small = await _run_with(SMALL_FRAMES, small_redis, monkeypatch)
        large_redis = FakeRedisStream()
        _large_run, large = await _run_with(LARGE_FRAMES, large_redis, monkeypatch)

        # BOTH histories, not just the large one. The negative probe that verified this test
        # showed why: folding the artifact into the node's `output` makes the LARGE run exceed
        # Temporal's 2 MB per-payload ceiling, so the activity errors, the node degrades, and no
        # output reaches history at all — the large history comes back CLEANER than the honest
        # one. Only the small run, which stays under the ceiling, still carries the smuggled
        # bytes. A check that looked at the large history alone would have passed on a node
        # actively routing audio through Temporal.
        for label, observed in (("small", small), ("large", large)):
            decoded = _decoded_history_payloads(observed["history_json"])
            for frame_index in (0, SMALL_FRAMES - 1):
                marker = f"AUDIOFRAME{frame_index:06d}".encode("ascii")
                assert marker not in decoded, f"{label} history carries raw audio"
                # And not smuggled in re-encoded either — base64 is the obvious way audio ends
                # up in a JSON-shaped activity result.
                assert (
                    base64.b64encode(_frame(frame_index)) not in decoded
                ), f"{label} history carries base64 audio"

        print(
            f"\n[ lane B audio split, measured bytes] "
            f"audio_bytes={SMALL_FRAMES * FRAME_BYTES} -> history_bytes={len(small['history_json'])}"
            f" | audio_bytes={LARGE_FRAMES * FRAME_BYTES} -> "
            f"history_bytes={len(large['history_json'])}"
        )
        # 32 MB of audio; the history must not have grown by anything like it.
        assert len(large["history_json"]) < len(small["history_json"]) * 2

    @pytest.mark.asyncio
    async def test_the_run_still_succeeds_and_the_deltas_rebuild_the_artifact(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The split is not "the audio vanished": the run SUCCEEDS, the control lane reports the
        node, and the delta frames concatenate back to exactly what was synthesised."""
        redis = FakeRedisStream()
        run_id, observed = await _run_with(SMALL_FRAMES, redis, monkeypatch)
        assert observed["status"] == "SUCCEEDED"

        events = redis.by_key[run_event_stream_key(run_id)]
        types = [e["type"] for e in events]
        assert "workflow.node.started" in types
        assert "workflow.node.completed" in types
        assert "workflow.run.completed" in types

        deltas = [e for e in events if e["type"] == EVENT_TOKEN_DELTA]
        rebuilt = b"".join(
            base64.b64decode(e["payload"]["text"])
            for e in sorted(deltas, key=lambda e: e["payload"]["sequence"])
        )
        assert rebuilt == b"".join(_audio(SMALL_FRAMES))
