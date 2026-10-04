"""TASK-1038 lane E3 — a run RESULT object lives under its tenant's prefix (security).

Before: a run result larger than the inline ceiling travelled on ``run.completed`` as
``{kind: "ref", bucket, key, sizeBytes, sha256}`` where ``key`` was the bare sha256 in the
platform claim-check bucket — or, when the result was exactly one ``core.output`` value, the
NODE-OUTPUT claim-check object itself. Nothing tied the object to a tenant, so the gateway could
not assert ownership before signing a URL for it, nor find a tenant's objects to delete on purge.

After: the result object is written under ``<tenantId>/<sha256>`` (still content-addressed within
the prefix), the ref says so with ``tenantPrefixed: true``, and a node-output claim-check object
is never handed out as a result — it is COPIED under the tenant prefix first. Reads of existing
un-prefixed refs keep working (the key is opaque to every reader).
"""

from __future__ import annotations

import hashlib
import json

import pytest

from harness.temporal.claim_check import (
    _MEMORY_STORE,
    ClaimCheckError,
    InMemoryBlobStore,
    load_blob,
    store_blob,
    tenant_key_prefix,
)
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.run_protocol import run_event_problems
from harness.tests.unit.temporal.interpreter import _task1038_harness as h
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


@pytest.fixture
def stream(monkeypatch):
    fake = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", fake, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    h.reset()
    yield fake
    h.reset()


def _graph(*, outputs: int) -> dict:
    big = h.agent(
        "n_agent", _stub="big", _stub_bytes=200_000, inputs=[h.edge("n_trigger", "out", "in")]
    )
    sinks = [h.output([h.edge("n_agent", "out", "in")])]
    if outputs == 2:
        second = h.output([h.edge("n_agent", "out", "in")])
        second["nodeId"] = "n_output_2"
        sinks.append(second)
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {"stageIndex": 1, "nodes": [big]},
            {"stageIndex": 2, "nodes": sinks},
        ]
    )


async def _assert_tenant_object(result: dict) -> bytes:
    assert result["kind"] == "ref"
    assert result["tenantPrefixed"] is True
    stored = await _MEMORY_STORE.get(result["bucket"], result["key"])
    digest = hashlib.sha256(stored).hexdigest()
    # Content-addressed WITHIN the tenant's prefix.
    assert result["key"] == f"{h.TENANT}/{digest}"
    assert result["sha256"] == digest
    assert result["sizeBytes"] == len(stored)
    return stored


class TestRunResultObjectIsTenantPrefixed:
    @pytest.mark.asyncio
    async def test_a_single_offloaded_output_is_copied_under_the_tenant_prefix(self, stream):
        await h.run_graph(_graph(outputs=1), payload={"q": 1})

        result = stream.terminal()["data"]["result"]
        stored = await _assert_tenant_object(result)
        assert json.loads(stored.decode("utf-8")) == "x" * 200_000
        # The node-output object (bare sha256 key) is never what a caller is handed.
        assert "/" in result["key"]

    @pytest.mark.asyncio
    async def test_a_composed_result_is_written_under_the_tenant_prefix(self, stream):
        await h.run_graph(_graph(outputs=2), payload={"q": 1})

        result = stream.terminal()["data"]["result"]
        stored = await _assert_tenant_object(result)
        assert json.loads(stored.decode("utf-8")) == {
            "n_output": "x" * 200_000,
            "n_output_2": "x" * 200_000,
        }

    def test_the_v2_protocol_accepts_the_flag_and_refuses_a_non_boolean(self):
        def event(flag: object) -> dict:
            return {
                "seq": 3,
                "runId": "run_01J9ZQ4V8W3K2N5P7R9T1X3Z5B",
                "type": "run.completed",
                "ts": "2026-10-04T10:00:00.000Z",
                "data": {
                    "status": "COMPLETED",
                    "durationMs": 1,
                    "tokens": {"in": 0, "out": 0},
                    "result": {
                        "kind": "ref",
                        "bucket": "b",
                        "key": "t/k",
                        "sizeBytes": 1,
                        "sha256": "a" * 64,
                        "tenantPrefixed": flag,
                    },
                },
            }

        assert run_event_problems(event(True)) == []
        assert run_event_problems(event("yes")) != []


class TestTenantKeyPrefix:
    @pytest.mark.asyncio
    async def test_a_prefixed_write_is_content_addressed_within_the_prefix(self):
        store = InMemoryBlobStore()
        ref = await store_blob("hello", store=store, bucket="b", key_prefix=h.TENANT)

        assert ref.key == f"{h.TENANT}/{hashlib.sha256(b'hello').hexdigest()}"
        assert await load_blob(ref, store=store) == "hello"

    @pytest.mark.asyncio
    async def test_an_unprefixed_write_and_read_are_unchanged(self):
        store = InMemoryBlobStore()
        ref = await store_blob("hello", store=store, bucket="b")

        assert ref.key == hashlib.sha256(b"hello").hexdigest()
        assert await load_blob(ref, store=store) == "hello"

    @pytest.mark.parametrize("bad", ["", " ", "a/b", "..", ".", "t\n1", "../x"])
    def test_a_tenant_id_that_is_not_a_single_safe_segment_is_refused(self, bad):
        with pytest.raises(ClaimCheckError):
            tenant_key_prefix(bad)
