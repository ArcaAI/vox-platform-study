"""/D — node-activity tests for the three node types `nodes/consultation.py`
owns: `consultation.consentGate`, `consultation.phiHop` (both `implemented: true`) and
`consultation.hitlGate` (`implemented: false` — Phase B not built).

The palette's other ten node types are covered by `test_consultation_pipeline_nodes.py`, and the
registry-shape assertions over the full thirteen live in
`packages/workflow-contract/src/__tests__/consultation-node-registry.test.ts`.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from harness.services.guardrail_client import GuardrailServiceError, RedactResult
from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation as nodes_consultation
from harness.temporal.interpreter.registry import NODE_REGISTRY

# TASK-893 Phase 4: these are ACTIONS behind `core.action` now, not node types. The human wait
# `consultation.hitlGate` did not become an action — it became the node type `core.humanReview`,
# so its assertions moved to the registry below.
_CONSULTATION_KEYS = ("consultation.consentGate", "consultation.phiHop")


class TestConsultationRegistryShape:
    """Scoped to the three keys THIS module implements — the full-palette registry shape is
    asserted in consultation-node-registry.test.ts and test_consultation_pipeline_nodes.py."""

    def test_both_keys_present_in_the_action_catalogue(self):
        for key in _CONSULTATION_KEYS:
            assert key in ACTION_CATALOGUE

    def test_only_the_consent_gate_and_the_human_wait_are_critical(self):
        # CR-14: "Only consultation.consentGate and consultation.hitlGate may be critical:true."
        # The human wait is `core.humanReview` since Phase 4; the rule is unchanged.
        assert ACTION_CATALOGUE["consultation.consentGate"].critical is True
        assert ACTION_CATALOGUE["consultation.phiHop"].critical is False
        assert [key for key, spec in ACTION_CATALOGUE.items() if spec.critical] == [
            "consultation.consentGate"
        ]

    def test_the_human_wait_is_a_child_workflow_node(self):
        # The gate is implemented, but NOT as an activity dispatch — `kind="child_workflow"`
        # routes it to a gate workflow. `consultation.hitlGate` carried this until Phase 4;
        # `core.humanReview` is the durable human wait now and carries it unchanged.
        spec = NODE_REGISTRY["core.humanReview"]
        assert spec.implemented is True
        assert spec.kind == "child_workflow"
        assert spec.external_write is True

    def test_consent_gate_and_phi_hop_are_implemented(self):
        assert ACTION_CATALOGUE["consultation.consentGate"].implemented is True
        assert ACTION_CATALOGUE["consultation.phiHop"].implemented is True

    def test_no_consultation_vision_or_priming_key_exists(self):
        # (vision, permanently deferred) / + R-4 (priming, deferred).
        for key in (*NODE_REGISTRY, *ACTION_CATALOGUE):
            assert not key.startswith("consultation.vision")
        assert "consultation.priming" not in NODE_REGISTRY
        assert "consultation.priming" not in ACTION_CATALOGUE

    def test_no_consultation_entry_mentions_signing(self):
        for key in _CONSULTATION_KEYS:
            spec = ACTION_CATALOGUE[key]
            module = getattr(spec.activity, "__module__", "")
            qualname = getattr(spec.activity, "__qualname__", "")
            assert "sign" not in module.lower()
            assert "sign" not in qualname.lower()

    def test_every_consultation_activity_resolves_to_a_real_activity_defn(self):
        for key in _CONSULTATION_KEYS:
            spec = ACTION_CATALOGUE[key]
            assert spec.activity_name.startswith("interpreter.consultation_")


def _payload(**overrides) -> NodeActivityInput:
    base = {
        "node_id": "n1",
        "node_type": "consultation.consentGate",
        "config": {},
        "tenant_id": "10000000-0000-0000-0000-000000000001",
        "sandbox": False,
        "bound_inputs": {},
        "run_payload": {},
    }
    base.update(overrides)
    return NodeActivityInput(**base)


class TestConsentGateActivity:
    @pytest.mark.asyncio
    async def test_allowed_decision_succeeds(self, monkeypatch):
        class _Decision:
            allowed = True
            unavailable = False
            grant_id = "g1"

        monkeypatch.setattr(
            nodes_consultation, "_check_consent", AsyncMock(return_value=_Decision())
        )
        payload = _payload(run_payload={"externalPatientId": "p1", "consultationId": "c1"})
        result = await nodes_consultation.interpreter_consultation_consent_gate(payload)
        assert result.status == "SUCCEEDED"
        assert result.output == {"allowed": True, "grantId": "g1"}

    @pytest.mark.asyncio
    async def test_denied_decision_degrades_with_consent_denied(self, monkeypatch):
        class _Decision:
            allowed = False
            unavailable = False
            grant_id = None

        monkeypatch.setattr(
            nodes_consultation, "_check_consent", AsyncMock(return_value=_Decision())
        )
        payload = _payload(run_payload={"externalPatientId": "p1", "consultationId": "c1"})
        result = await nodes_consultation.interpreter_consultation_consent_gate(payload)
        assert result.status == "DEGRADED"
        assert "consent_denied" in result.reason

    @pytest.mark.asyncio
    async def test_unavailable_decision_degrades_with_consent_unavailable_never_reads_as_pass(
        self, monkeypatch
    ):
        class _Decision:
            allowed = False
            unavailable = True
            grant_id = None

        monkeypatch.setattr(
            nodes_consultation, "_check_consent", AsyncMock(return_value=_Decision())
        )
        payload = _payload(run_payload={})
        result = await nodes_consultation.interpreter_consultation_consent_gate(payload)
        assert result.status == "DEGRADED"
        assert "consent_unavailable" in result.reason


class TestPhiHopActivity:
    @pytest.mark.asyncio
    async def test_successful_redaction_returns_sanitized_text(self, monkeypatch):
        class _FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            async def redact(self, *, text, mode, tenant_id):
                return RedactResult(sanitized_text="[REDACTED] said hello", entities=[], mode=mode)

        monkeypatch.setattr(nodes_consultation, "GuardrailClient", _FakeClient)
        payload = _payload(
            node_type="consultation.phiHop",
            config={"mode": "full"},
            bound_inputs={"in": {"text": "John Smith said hello"}},
        )
        result = await nodes_consultation.interpreter_consultation_phi_hop(payload)
        assert result.status == "SUCCEEDED"
        assert result.output["text"] == "[REDACTED] said hello"

    @pytest.mark.asyncio
    async def test_transport_failure_degrades_never_passes_through_unredacted(self, monkeypatch):
        class _FailingClient:
            def __init__(self, *args, **kwargs):
                pass

            async def redact(self, *, text, mode, tenant_id):
                raise GuardrailServiceError("boom")

        monkeypatch.setattr(nodes_consultation, "GuardrailClient", _FailingClient)
        payload = _payload(
            node_type="consultation.phiHop",
            config={"mode": "pseudonymize"},
            bound_inputs={"in": {"text": "sensitive text"}},
        )
        result = await nodes_consultation.interpreter_consultation_phi_hop(payload)
        assert result.status == "DEGRADED"
        assert "unreachable" in result.reason

    @pytest.mark.asyncio
    async def test_invalid_mode_degrades(self):
        payload = _payload(node_type="consultation.phiHop", config={"mode": "bogus"})
        result = await nodes_consultation.interpreter_consultation_phi_hop(payload)
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_no_bound_text_degrades(self):
        payload = _payload(node_type="consultation.phiHop", config={"mode": "full"})
        result = await nodes_consultation.interpreter_consultation_phi_hop(payload)
        assert result.status == "DEGRADED"


class TestHitlGateActivityIsNotTheExecutionPath:
    """`consultation.hitlGate` is a `kind="child_workflow"` node: the compiler lifts it out of
    `stages` into `gates`, and `WorkflowInterpreter._run_gate` starts `ConsultationGateWorkflow`
    for it. This activity exists only because `NodeSpec.activity` requires a callable and because
    `activity_name` is the S-4 cross-check anchor — reaching it means a routing bug."""

    @pytest.mark.asyncio
    async def test_it_never_returns_succeeded(self):
        # 03-compliance-posture.md §3 — a gate reached by mistake must never read as approved.
        payload = _payload(node_type="consultation.hitlGate")
        result = await nodes_consultation.interpreter_consultation_hitl_gate(payload)
        assert result.status != "SUCCEEDED"
        assert result.status == "DEGRADED"
        assert result.output is None

    @pytest.mark.asyncio
    async def test_it_names_the_real_execution_path(self):
        payload = _payload(node_type="consultation.hitlGate")
        result = await nodes_consultation.interpreter_consultation_hitl_gate(payload)
        assert "child_workflow" in result.reason
        assert "ConsultationGateWorkflow" in result.reason
