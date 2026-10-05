"""TASK-1036 / TASK-1038 (lane B1) — what the interpreter now ADMITS.

* A compiled config carrying the data contract (``emitDataContract``: per-node ``bindings`` and
  ``consultationReads``, root ``settings``) loads — before this lane ``extra="forbid"`` refused
  every such artifact at ``load_config``, which is also why no existing history can carry one.
* The start route takes the gateway-resolved ``retentionSeconds`` and ``limits`` (lane B3a) and
  stamps them on the run; without them it falls back to the ``HARNESS_CLAIM_CHECK_*`` settings for
  one release (the transition).
"""

from __future__ import annotations

import copy

import pytest
from httpx import ASGITransport, AsyncClient

from harness.temporal.interpreter.compiled_config import InterpreterConfigError, parse_and_verify
from harness.tests.unit.api.test_interpreter_endpoints import _BASE, _HEADERS, _build, _start_body
from harness.tests.unit.temporal.interpreter.test_compiled_config import (
    _sample_body,
    _signed_document,
)


def _with_contract() -> dict:
    body = _sample_body()
    node = body["stages"][0]["nodes"][0]
    node["bindings"] = {
        "message": {"from": "nodes.n0.outputs.text"},
        "context": {"firstOf": ["context.a", "consultation.patient"]},
        "label": {"value": None},
        "intro": {"template": "x {{run.id}}"},
    }
    node["consultationReads"] = [{"path": "consultation.patient", "at": "nodeStart"}]
    body["settings"] = {"connections": ["api", "sse"], "sources": ["consultation"]}
    return body


class TestDataContractAdmission:
    def test_a_config_carrying_the_data_contract_loads(self) -> None:
        body = _with_contract()
        config = parse_and_verify(_signed_document(**body))
        node = config.stages[0].nodes[0]
        assert node.bindings is not None and node.bindings["message"] == {
            "from": "nodes.n0.outputs.text"
        }
        assert [r.model_dump(by_alias=True) for r in node.consultation_reads] == [
            {"path": "consultation.patient", "at": "nodeStart"}
        ]
        assert config.settings is not None and config.settings.sources == ["consultation"]

    def test_a_legacy_config_has_none_of_it(self) -> None:
        config = parse_and_verify(_signed_document())
        assert config.settings is None
        assert config.stages[0].nodes[0].bindings is None
        assert config.stages[0].nodes[0].consultation_reads == []

    def test_a_malformed_binding_is_refused_loudly(self) -> None:
        body = _with_contract()
        body["stages"][0]["nodes"][0]["bindings"] = {"message": {"from": "a", "value": 1}}
        with pytest.raises(InterpreterConfigError):
            parse_and_verify(_signed_document(**copy.deepcopy(body)))


async def _start(**overrides):
    app, client, _handle, settings = _build()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        resp = await http.post(
            f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body(**overrides)
        )
    assert resp.status_code == 200, resp.text
    args, _kwargs = client.start_workflow.call_args
    return args[1], settings


class TestGatewayInjectedRunParameters:
    @pytest.mark.asyncio
    async def test_retention_and_limits_from_the_gateway_are_stamped(self) -> None:
        wf_input, _ = await _start(
            retentionSeconds=86_400,
            limits={
                "nodeOutputClaimCheckMinBytes": 10_000,
                "resultInlineMaxBytes": 32_768,
                "activityInputMaxBytes": 1_000_000,
            },
        )
        assert wf_input.retention_seconds == 86_400
        assert wf_input.limits.activity_input_max_bytes == 1_000_000
        assert wf_input.limits.node_output_claim_check_min_bytes == 10_000
        assert wf_input.limits.result_inline_max_bytes == 32_768

    @pytest.mark.asyncio
    async def test_absent_values_fall_back_to_the_claim_check_settings(self) -> None:
        wf_input, settings = await _start()
        assert wf_input.retention_seconds is None
        assert wf_input.limits.activity_input_max_bytes == (
            settings.claim_check.activity_input_max_bytes
        )
        assert wf_input.limits.node_output_claim_check_min_bytes == (
            settings.claim_check.node_output_min_bytes
        )
        assert wf_input.limits.result_inline_max_bytes == (
            settings.claim_check.result_inline_max_bytes
        )

    @pytest.mark.asyncio
    async def test_a_partial_limits_block_fills_only_what_is_missing(self) -> None:
        wf_input, settings = await _start(limits={"resultInlineMaxBytes": 1_024})
        assert wf_input.limits.result_inline_max_bytes == 1_024
        assert wf_input.limits.activity_input_max_bytes == (
            settings.claim_check.activity_input_max_bytes
        )
