"""TASK-1038 — what the dispatcher stamps on a run at START.

* **R-3** — the run's payload ceiling (``RunLimits``), resolved from ``ClaimCheckConfig`` here
  because the deterministic workflow cannot read settings.
* **D-B** — a Temporal ``execution_timeout`` derived from the compiled ``caps.maxTotalSeconds``
  (the in-workflow deadline is the primary bound; this is the backstop for a run that cannot
  reach its own deadline).
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter import caps
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.tests.unit.api.test_interpreter_endpoints import _BASE, _HEADERS, _build, _start_body


async def _config_ref(*, max_total: int = 600, gates: list | None = None, stages=None) -> dict:
    body = {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "t",
        "versionNumber": 1,
        "tenantId": "t-1",
        "paletteKey": "core",
        "compiledAt": "2026-10-04T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc",
        "ruleSetVersion": 1,
        "stages": stages or [],
        "gates": gates or [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": max_total, "maxNodeSeconds": 300, "maxAttempts": 3},
    }
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}),
        store=_MEMORY_STORE,
        bucket="harness-claim-check",
    )
    return ref.model_dump()


async def _start(**body_overrides):
    app, client, _handle, settings = _build()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        resp = await http.post(
            f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body(**body_overrides)
        )
    assert resp.status_code == 200, resp.text
    args, kwargs = client.start_workflow.call_args
    return args[1], kwargs, settings


class TestRunLimits:
    @pytest.mark.asyncio
    async def test_the_payload_ceiling_is_stamped_from_the_claim_check_config(self):
        wf_input, _kwargs, settings = await _start()

        assert wf_input.limits is not None
        assert (
            wf_input.limits.activity_input_max_bytes
            == settings.claim_check.activity_input_max_bytes
        )


class TestExecutionTimeout:
    @pytest.mark.asyncio
    async def test_the_backstop_is_the_compiled_budget_plus_the_grace(self):
        _, kwargs, _ = await _start(configRef=await _config_ref(max_total=600))

        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_the_budget_is_clamped_to_the_platform_ceiling(self):
        _, kwargs, _ = await _start(configRef=await _config_ref(max_total=999_999))

        assert kwargs["execution_timeout"] == timedelta(
            seconds=caps.MAX_TOTAL_SECONDS + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_a_consultation_bound_run_adds_the_live_handoff_wait(self):
        _, kwargs, _ = await _start(
            configRef=await _config_ref(max_total=600),
            subject={"consultationId": "c-1"},
        )

        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + caps.LIVE_HANDOFF_MAX_WAIT_SECONDS + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_a_graph_with_a_human_gate_gets_no_backstop(self):
        """A gate waits on a tenant-policy SLA ladder the compiled config does not bound, so no
        honest ceiling can be computed here; the in-workflow deadline still bounds the walk."""
        gate = {
            "nodeId": "n_gate",
            "gateType": "core.humanReview",
            "blocking": True,
            "timeoutSeconds": 900,
            "onTimeout": "TIMED_OUT",
        }
        _, kwargs, _ = await _start(configRef=await _config_ref(gates=[gate]))

        assert kwargs.get("execution_timeout") is None

    @pytest.mark.asyncio
    async def test_review_nodes_extend_the_backstop_by_their_own_timeouts(self):
        review = {
            "nodeId": "n_review",
            "type": "core.humanReview",
            "activity": "interpreter.core_human_review",
            "config": {"timeoutSeconds": 1200},
            "timeoutSeconds": 3600,
            "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
            "inputs": [],
            "onError": "degrade",
            "emitsTrajectory": True,
        }
        _, kwargs, _ = await _start(
            configRef=await _config_ref(
                max_total=600, stages=[{"stageIndex": 0, "nodes": [review]}]
            )
        )

        assert kwargs["execution_timeout"] == timedelta(
            seconds=600 + 1200 + caps.RUN_TIMEOUT_GRACE_SECONDS
        )

    @pytest.mark.asyncio
    async def test_an_unreadable_config_never_blocks_the_start(self):
        """The workflow's own `load_config` fails such a run loudly; the dispatcher must not
        turn a backstop computation into a refused start."""
        _, kwargs, _ = await _start()  # the default configRef points at nothing

        assert kwargs.get("execution_timeout") is None
