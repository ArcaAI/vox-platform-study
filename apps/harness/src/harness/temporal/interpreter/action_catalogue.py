"""The ACTION catalogue behind `core.action` — a FIRST-CLASS table (TASK-893 Phase 2).

Mirrors `packages/workflow-contract/src/action-catalogue.ts`. Until this ticket the catalogue was
`{key: NODE_REGISTRY[key] for key in ACTION_KEYS}` — a filtered VIEW of the legacy node types,
which is why those types could never be deleted (they WERE the implementation of `core.action`).
Each entry here is the `NodeSpec` a `core.action` instance runs on: `interpreter_core_action`
calls `spec.activity` directly, and `effective_spec` (`registry.py`) applies its `critical` /
`external_write` / `lane` / `output_keys` to the instance.

Every value was copied VERBATIM from the registry entry it replaces (INTERFACES §7.2). Asserted
against the same committed fixture the TypeScript side is —
`packages/workflow-contract/src/__tests__/fixtures/action-catalogue.snapshot.json`, by
`test_action_catalogue_parity.py` — never against the other language directly.
"""

from __future__ import annotations

from temporalio import workflow

from harness.temporal.interpreter.node_spec import NodeSpec

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.nodes.consultation import (
        interpreter_consultation_consent_gate,
        interpreter_consultation_phi_hop,
    )
    from harness.temporal.interpreter.nodes.consultation_compose import (
        interpreter_consultation_retrieve_evidence,
    )
    from harness.temporal.interpreter.nodes.consultation_endpoint import (
        interpreter_feedback_capture,
        interpreter_harness_finalize,
        interpreter_livedoc_stop,
        interpreter_session_timeout,
        interpreter_summary_finalize,
    )
    from harness.temporal.interpreter.nodes.consultation_nlp import (
        interpreter_consultation_bind_terminology,
    )
    from harness.temporal.interpreter.nodes.consultation_persist import (
        interpreter_consultation_finalize_assurance,
        interpreter_consultation_persist_draft,
    )
    from harness.temporal.interpreter.nodes.consultation_verify import (
        interpreter_consultation_inferential_sensors,
        interpreter_consultation_sensors,
    )
    from harness.temporal.interpreter.nodes.guards import (
        interpreter_guard_groundedness,
        interpreter_guard_moderation,
        interpreter_guard_phi,
    )
    from harness.temporal.interpreter.nodes.template_ref import interpreter_template_ref

#: The 17 kept action keys, in contract order (INTERFACES §7.2). The 17 agent-shaped keys the
#: old view also carried are `core.agent` now and are NOT actions.
ACTION_KEYS: tuple[str, ...] = (
    "consultation.consentGate",
    "consultation.bindTerminology",
    "consultation.phiHop",
    "consultation.retrieveEvidence",
    "consultation.sensors",
    "consultation.inferentialSensors",
    "consultation.persistDraft",
    "consultation.finalizeAssurance",
    "guard.phi",
    "guard.moderation",
    "guard.groundedness",
    "session.timeout",
    "feedback.capture",
    "livedoc.stop",
    "harness.finalize",
    "summary.finalize",
    "prompt.template_ref",
)

ACTION_CATALOGUE: dict[str, NodeSpec] = {
    "consultation.consentGate": NodeSpec(
        key="consultation.consentGate",
        implemented=True,
        activity=interpreter_consultation_consent_gate,
        critical=True,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"out": None, "next": None},
    ),
    "consultation.bindTerminology": NodeSpec(
        key="consultation.bindTerminology",
        implemented=True,
        activity=interpreter_consultation_bind_terminology,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=1,
        output_keys={"out": "entities", "next": None},
    ),
    "consultation.phiHop": NodeSpec(
        key="consultation.phiHop",
        implemented=True,
        activity=interpreter_consultation_phi_hop,
        critical=False,
        external_write=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "text", "next": None},
    ),
    "consultation.retrieveEvidence": NodeSpec(
        key="consultation.retrieveEvidence",
        implemented=True,
        activity=interpreter_consultation_retrieve_evidence,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "context", "next": None},
    ),
    "consultation.sensors": NodeSpec(
        key="consultation.sensors",
        implemented=True,
        activity=interpreter_consultation_sensors,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "verdict", "document": "text", "next": None},
    ),
    "consultation.inferentialSensors": NodeSpec(
        key="consultation.inferentialSensors",
        implemented=True,
        activity=interpreter_consultation_inferential_sensors,
        critical=False,
        external_write=False,
        default_timeout_seconds=900,
        default_max_attempts=2,
        output_keys={"out": "verdict", "document": "text", "next": None},
    ),
    "consultation.persistDraft": NodeSpec(
        key="consultation.persistDraft",
        implemented=True,
        activity=interpreter_consultation_persist_draft,
        critical=False,
        external_write=True,
        default_timeout_seconds=150,
        default_max_attempts=3,
        output_keys={"out": "text", "contextItemId": "contextItemId", "next": None},
    ),
    "consultation.finalizeAssurance": NodeSpec(
        key="consultation.finalizeAssurance",
        implemented=True,
        activity=interpreter_consultation_finalize_assurance,
        critical=False,
        external_write=True,
        default_timeout_seconds=150,
        default_max_attempts=3,
        output_keys={"contextItemId": "contextItemId", "next": None},
    ),
    "guard.phi": NodeSpec(
        key="guard.phi",
        implemented=True,
        activity=interpreter_guard_phi,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "verdict", "text": "text", "next": None},
    ),
    "guard.moderation": NodeSpec(
        key="guard.moderation",
        implemented=True,
        activity=interpreter_guard_moderation,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "verdict", "next": None},
    ),
    "guard.groundedness": NodeSpec(
        key="guard.groundedness",
        implemented=True,
        activity=interpreter_guard_groundedness,
        critical=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "verdict", "next": None},
    ),
    "session.timeout": NodeSpec(
        key="session.timeout",
        implemented=True,
        activity=interpreter_session_timeout,
        critical=False,
        external_write=True,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    "feedback.capture": NodeSpec(
        key="feedback.capture",
        implemented=True,
        activity=interpreter_feedback_capture,
        critical=False,
        external_write=True,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    "livedoc.stop": NodeSpec(
        key="livedoc.stop",
        implemented=True,
        activity=interpreter_livedoc_stop,
        critical=False,
        external_write=True,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    "harness.finalize": NodeSpec(
        key="harness.finalize",
        implemented=True,
        activity=interpreter_harness_finalize,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    "summary.finalize": NodeSpec(
        key="summary.finalize",
        implemented=True,
        activity=interpreter_summary_finalize,
        critical=False,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    "prompt.template_ref": NodeSpec(
        key="prompt.template_ref",
        implemented=True,
        activity=interpreter_template_ref,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"out": "content", "next": None},
    ),
}

assert tuple(ACTION_CATALOGUE) == ACTION_KEYS  # noqa: S101 — the table and its key order are one fact
