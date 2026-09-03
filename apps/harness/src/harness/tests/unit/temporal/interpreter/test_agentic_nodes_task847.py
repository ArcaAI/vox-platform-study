"""the GENERIC (agentic) catalogue, Python half.

The TypeScript package owns the CONTRACT (what the eight node types are, what they may hold,
what they may be wired to). This file owns the half that only the interpreter can prove:

 1. every one of the eight is DISPATCHABLE — registered, served by the worker, and carrying the
    activity name the cross-language fixture pins;
 2. the two that do not execute yet degrade OBSERVABLY and never claim success; and
 3. the Data node — the only one with real logic of its own — reshapes deterministically and
    never invents a value.

Point 2 is the one worth being strict about. ``agentic.loop`` and ``agentic.tts`` are
``implemented=True`` because ``compile()`` refuses a graph containing an unimplemented type, so
the ONLY thing standing between "declared but not built" and "silently claims to have run" is
these activities returning ``DEGRADED``. A future change that makes either return ``SUCCEEDED``
without doing the work would be invisible in production and is exactly what this pins.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio import activity as temporal_activity

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import agentic
from harness.temporal.interpreter.registry import NODE_REGISTRY

_TENANT = "10000000-0000-0000-0000-000000000001"

AGENTIC_KEYS = [
    "agentic.input",
    "agentic.output",
    "agentic.agent",
    "agentic.guardrail",
    "agentic.data",
    "agentic.loop",
    "agentic.stt",
    "agentic.tts",
]


def _payload(node_type: str, **overrides: Any) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "n1",
        "node_type": node_type,
        "config": {},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {},
        "run_payload": {},
    }
    base.update(overrides)
    return NodeActivityInput(**base)


@pytest.fixture(autouse=True)
def _no_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    """The trajectory emitter opens a Redis/HTTP batch. These tests are about node BEHAVIOUR, and
    the harness CI suite is hermetic (rule 06 §Pitfalls), so it is stubbed rather than served."""

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(agentic, "record_and_flush", _noop)


class TestDispatchability:
    def test_all_eight_are_registered(self) -> None:
        for key in AGENTIC_KEYS:
            assert key in NODE_REGISTRY, f"{key} is missing from NODE_REGISTRY"

    def test_all_eight_are_implemented_so_a_graph_using_them_can_compile(self) -> None:
        # `compile()` refuses any graph containing an `implemented=False` type, and this ticket's
        # verification criterion is that a graph using every new node type compiles.
        for key in AGENTIC_KEYS:
            assert NODE_REGISTRY[key].implemented is True

    def test_every_one_is_served_by_the_worker(self) -> None:
        served = {temporal_activity._Definition.from_callable(fn).name for fn in agentic.AGENTIC_ACTIVITIES}  # noqa: SLF001
        for key in AGENTIC_KEYS:
            assert NODE_REGISTRY[key].activity_name in served, f"{key} is dispatched but not served"

    def test_the_writers_are_declared_as_writers(self) -> None:
        # `external_write` is what a SANDBOXED run suppresses. Getting it wrong on `agentic.stt`
        # would mean a sandbox test-run dispatching a real transcription job.
        assert NODE_REGISTRY["agentic.output"].external_write is True
        assert NODE_REGISTRY["agentic.stt"].external_write is True
        assert NODE_REGISTRY["agentic.tts"].external_write is True
        assert NODE_REGISTRY["agentic.agent"].external_write is False
        assert NODE_REGISTRY["agentic.data"].external_write is False


class TestObservableNonExecution:
    """`implemented=True` and does not run — the ONE honest posture, and the one thing that can
    silently rot into a false success claim."""

    async def test_the_loop_degrades_and_names_the_ticket_that_owns_the_body(self) -> None:
        result = await agentic.interpreter_agentic_loop(_payload("agentic.loop"))
        assert result.status == "DEGRADED"
        assert "" in (result.reason or "")

    # lane B NARROWED this class from two node types to one, deliberately.
    #
    # `agentic.tts` is now REAL — it dispatches synthesis and writes an audio artifact — so a
    # test asserting it can never report SUCCEEDED would fail for the RIGHT reason and be
    # "fixed" by deleting the guard on `agentic.loop` alongside it. `agentic.loop`'s pin STAYS,
    # and it is still load-bearing for a subtler reason than before: made the loop real
    # via a CHILD WORKFLOW, and this activity is the REPLAY-ONLY path that survives for
    # histories recorded before that gate. It must never start claiming iterations it did not
    # run. `agentic.tts`'s own honesty is pinned by `test_task849_agentic_tts.py`
    # (`TestItStillResolvesNothingItself`), which asserts every unresolvable binding still
    # degrades and produces no output — the same property, moved to where the behaviour lives.
    async def test_the_loop_never_claims_to_have_produced_anything(self) -> None:
        result = await agentic.interpreter_agentic_loop(_payload("agentic.loop"))
        assert result.status != "SUCCEEDED"
        assert not result.output


class TestInputNode:
    async def test_binds_the_named_key_of_the_run_payload(self) -> None:
        result = await agentic.interpreter_agentic_input(
            _payload("agentic.input", config={"sourceKey": "note"}, run_payload={"note": "hello", "other": 1})
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"payload": "hello"}

    async def test_binds_the_whole_payload_when_no_key_is_named(self) -> None:
        result = await agentic.interpreter_agentic_input(_payload("agentic.input", run_payload={"a": 1}))
        assert result.output == {"payload": {"a": 1}}


class TestDataNode:
    """The tier-2 escape hatch, and the only agentic node with logic of its own."""

    async def test_maps_dotted_reads_onto_renamed_keys(self) -> None:
        result = await agentic.interpreter_agentic_data(
            _payload(
                "agentic.data",
                config={"mappings": [{"from": "in.patient.name", "to": "patient_name"}]},
                bound_inputs={"in": {"patient": {"name": "A. Patient"}}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"data": {"patient_name": "A. Patient"}}

    async def test_merges_literal_constants(self) -> None:
        result = await agentic.interpreter_agentic_data(
            _payload("agentic.data", config={"mappings": [], "constants": {"source": "workflow"}}, bound_inputs={})
        )
        assert result.output == {"data": {"source": "workflow"}}

    async def test_an_optional_mapping_that_does_not_resolve_is_simply_ABSENT(self) -> None:
        # Never invented. A fabricated field is worse than a missing one, because a downstream
        # schema check passes on it and the run looks healthy.
        result = await agentic.interpreter_agentic_data(
            _payload("agentic.data", config={"mappings": [{"from": "in.ghost", "to": "ghost"}]}, bound_inputs={"in": {}})
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"data": {}}

    async def test_a_REQUIRED_mapping_that_does_not_resolve_DEGRADES_observably(self) -> None:
        result = await agentic.interpreter_agentic_data(
            _payload(
                "agentic.data",
                config={"mappings": [{"from": "in.ghost", "to": "ghost", "required": True}]},
                bound_inputs={"in": {}},
            )
        )
        assert result.status == "DEGRADED"
        assert "in.ghost" in (result.reason or "")


class TestSttNodeResolvesNothingItself:
    """The reference-only rule, at the runtime edge: this activity resolves no reference and
    builds no client. A pipeline named by SLUG needs the gateway's tenant -> SYSTEM cascade, so
    it degrades rather than guessing — guessing here would be the cascade bypass the whole
    contract exists to prevent."""

    async def test_a_slug_bound_pipeline_degrades_rather_than_being_resolved_here(self) -> None:
        result = await agentic.interpreter_agentic_stt(
            _payload("agentic.stt", config={"pipelineRef": {"pipelineSlug": "clinical-en"}}, bound_inputs={"in": "s3://bucket/a.wav"})
        )
        assert result.status == "DEGRADED"
        assert "pipelineId" in (result.reason or "")

    async def test_a_missing_audio_reference_degrades_rather_than_dispatching_an_empty_job(self) -> None:
        result = await agentic.interpreter_agentic_stt(
            _payload("agentic.stt", config={"pipelineRef": {"pipelineId": "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"}}, bound_inputs={})
        )
        assert result.status == "DEGRADED"
        assert "audio" in (result.reason or "")
