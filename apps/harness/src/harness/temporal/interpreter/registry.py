"""Node-type -> activity routing registry (S-4, S-6).

Mirrors ``LoopActionSpec``/``LOOP_ACTION_REGISTRY`` (``workflows.py:1628-1693``) in shape and in
the ``implemented`` discipline: a node type with NO entry, or an entry with ``implemented=False``,
dispatches as an OBSERVABLE skip (``unsupported_node_type``) — never a silent no-op (see
contracts/execution-semantics.md §10 for the full dispatch/security rationale, including why the
workflow always calls ``spec.activity`` directly and only cross-checks the wire's ``activity``
string, never trusts it for routing).

The registry starts EMPTY of palette nodes — TASK-720 populates it with the summarization
palette's five node types. This ticket ships only the ``noop``/``passthrough`` entries this
package's own tests need (ticket §4 Task 4).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity as temporal_activity
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.activities import (
        interpreter_core_end,
        interpreter_core_start,
        interpreter_noop,
        interpreter_passthrough,
    )
    from harness.temporal.interpreter.nodes.consultation import (
        interpreter_consultation_consent_gate,
        interpreter_consultation_hitl_gate,
        interpreter_consultation_phi_hop,
    )
    from harness.temporal.interpreter.nodes.consultation_capture import (
        interpreter_consultation_capture_binding,
    )
    from harness.temporal.interpreter.nodes.consultation_compose import (
        interpreter_consultation_assemble_prompt,
        interpreter_consultation_retrieve_evidence,
        interpreter_consultation_synthesize,
    )
    from harness.temporal.interpreter.nodes.consultation_nlp import (
        interpreter_consultation_bind_terminology,
        interpreter_consultation_extract_entities,
    )
    from harness.temporal.interpreter.nodes.consultation_persist import (
        interpreter_consultation_finalize_assurance,
        interpreter_consultation_persist_draft,
    )
    from harness.temporal.interpreter.nodes.consultation_realtime import (
        interpreter_consultation_propose_corrections,
        interpreter_consultation_realtime_summary,
        interpreter_consultation_suggestions,
    )
    from harness.temporal.interpreter.nodes.consultation_verify import (
        interpreter_consultation_inferential_sensors,
        interpreter_consultation_sensors,
    )
    from harness.temporal.interpreter.nodes.context_binding import interpreter_context_binding
    from harness.temporal.interpreter.nodes.deliver import interpreter_deliver
    from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check
    from harness.temporal.interpreter.nodes.stt_placeholder import (
        interpreter_stt_asr_engine,
        interpreter_stt_audio_input,
        interpreter_stt_diarization,
        interpreter_stt_language_detection,
        interpreter_stt_noise_filter,
        interpreter_stt_phi_hop,
        interpreter_stt_transcript_output,
        interpreter_stt_vad,
    )
    from harness.temporal.interpreter.nodes.template_ref import interpreter_template_ref
    from harness.temporal.interpreter.nodes.text_generate import interpreter_text_generate


def _registered_activity_name(fn: Callable[..., Any]) -> str:
    """The Temporal-registered name of an ``@activity.defn`` callable.

    Uses ``activity._Definition.from_callable`` — the same SDK-internal helper the Worker itself
    uses to introspect an activity list at registration time; there is no public accessor in this
    SDK version. Computed HERE (registry.py, a plain module the workflow only ever
    pass-through-imports) rather than inside ``workflow.py``'s own sandboxed module namespace —
    calling into ``temporalio.activity`` internals directly from sandboxed workflow code tripped
    the sandbox's import restrictions during workflow validation (observed: a
    ``urllib.request.Request.__mro_entries__`` restriction fired at ``prepare_workflow`` time).
    Doing the introspection in a pass-through module and storing the plain string result on
    ``NodeSpec`` sidesteps that entirely.
    """
    defn = temporal_activity._Definition.from_callable(fn)  # noqa: SLF001 - no public API
    if defn is None or defn.name is None:
        raise ValueError(f"{fn!r} is not a valid @activity.defn callable with a fixed name")
    return defn.name


@dataclass(frozen=True)
class NodeSpec:
    """One entry in the node-type registry.

    ``activity`` is a CALLABLE reference (never a string) — see the module docstring.
    ``activity_name`` is the same activity's Temporal-registered name, precomputed at registry-
    build time (see ``_registered_activity_name``) — the workflow's S-4 cross-check
    (contracts/execution-semantics.md §10) compares against this field, never the callable
    itself, and never re-derives the name inside the sandboxed workflow module. ``kind`` is
    reserved for a future ``child_workflow`` dispatch (mirroring ``LoopActionSpec.kind``); v1 only
    ever uses ``"activity"``. ``critical``/``external_write`` are code-owned safety properties,
    never tenant-configurable (contracts/execution-semantics.md §5/§9).

    ``output_keys`` is TASK-809 OD-15 (option A), and it is the ONE piece of the port contract
    that is SHARED with the TypeScript side rather than TS-only. A port NAME is an authoring
    handle — ``out``, ``entities``, ``verdict``, what the Studio canvas draws and what a graph
    edge's ``fromPort``/``toPort`` names — but this interpreter threads values by reading a KEY
    out of the producing activity's own ``NodeActivityResult.output`` dict, and no activity in
    this platform emits a key called ``"out"``. Until OD-15 the only bridge was
    ``_resolve_bound_inputs``' whole-object fallback, which is precisely the untyped bundle the
    port vocabulary exists to abolish (a bundle cannot be typed as "contains a document", so
    generated prose could reach NER again).

    So each entry maps EVERY declared output port name to the output key it carries, or to
    ``None`` for a ``control`` port, which carries no payload at all. That ``None`` is
    load-bearing: it is what lets ``_resolve_bound_inputs`` tell a legitimate ORDERING edge
    (skip, contribute nothing) apart from an edge naming a port that does not exist (raise).

    Authored here by hand and asserted against the SAME committed fixture the TypeScript
    projection is asserted against (``node-registry.snapshot.json``) — see
    ``test_node_registry_parity.py``. Never add it to one side only.
    """

    key: str
    implemented: bool
    activity: Callable[..., Any]
    activity_name: str = field(init=False)
    kind: str = "activity"
    critical: bool = False
    external_write: bool = False
    default_timeout_seconds: int = 60
    default_max_attempts: int = 1
    entitlement_key: str | None = None
    output_keys: Mapping[str, str | None] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # frozen dataclass: use object.__setattr__ for the derived field.
        object.__setattr__(self, "activity_name", _registered_activity_name(self.activity))


NODE_REGISTRY: dict[str, NodeSpec] = {
    "noop": NodeSpec(
        key="noop", implemented=True, activity=interpreter_noop, output_keys={"next": None}
    ),
    "passthrough": NodeSpec(
        key="passthrough",
        implemented=True,
        activity=interpreter_passthrough,
        output_keys={"next": None},
    ),
    # Graph boundary markers (palette-agnostic). The palette-independent structural rules
    # WF-S-002/003/004/007 are written against these two literal types; until they were
    # registered no graph in ANY palette could satisfy them. They execute nothing (see
    # activities.py), but must be dispatchable because compile() refuses a graph containing an
    # unimplemented node type. `classes: ['boundary']` is TS-only (node-registry.ts) — it is
    # what the reachability predicates use to exempt a marker from a palette's OWN entry/terminal
    # rule; Python needs no counterpart because the interpreter never evaluates rules.
    "core.start": NodeSpec(
        key="core.start",
        implemented=True,
        activity=interpreter_core_start,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=1,
        output_keys={"next": None},
    ),
    "core.end": NodeSpec(
        key="core.end",
        implemented=True,
        activity=interpreter_core_end,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=1,
        output_keys={},
    ),
    # Summarization palette (TASK-720). `critical`/`external_write`/timeouts mirror
    # contracts/palette.md's node table and node-registry.ts's matching five entries exactly.
    # RESTORED (2026-08-17, close-out pass): dropped from this dict by an external tree operation
    # mid-session (see TASK-724/TASK-731 READMEs); the node activities themselves never stopped
    # existing on disk. Re-added verbatim from the last known-good shape (git history, commit
    # 632f93f14).
    "input.context_binding": NodeSpec(
        key="input.context_binding",
        implemented=True,
        activity=interpreter_context_binding,
        critical=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "context", "next": None},
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
    "generate.text": NodeSpec(
        key="generate.text",
        implemented=True,
        activity=interpreter_text_generate,
        critical=True,
        default_timeout_seconds=300,
        default_max_attempts=2,
        output_keys={"out": "text", "next": None},
    ),
    "guardrail.check": NodeSpec(
        key="guardrail.check",
        implemented=True,
        activity=interpreter_guardrail_check,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "verdict", "next": None},
    ),
    "output.deliver": NodeSpec(
        key="output.deliver",
        implemented=True,
        activity=interpreter_deliver,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    # STT palette (TASK-724). Mirrors
    # docs/implementation/TASK-724-Palette-Stt/contracts/palette.md's node table and
    # node-registry.ts's matching eight entries exactly. Every activity here is a documented
    # PLACEHOLDER (nodes/stt_placeholder.py's module docstring) — the STT palette's real
    # execution path is compile-to-AsrPipeline + pipelineId binding, never per-node interpreter
    # dispatch; these entries satisfy the cross-language registry-parity contract compile()
    # depends on.
    "stt.audioInput": NodeSpec(
        key="stt.audioInput",
        implemented=True,
        activity=interpreter_stt_audio_input,
        critical=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "audio", "bypass": "audio", "next": None},
    ),
    "stt.vad": NodeSpec(
        key="stt.vad",
        implemented=True,
        activity=interpreter_stt_vad,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "audio", "next": None},
    ),
    "stt.noiseFilter": NodeSpec(
        key="stt.noiseFilter",
        implemented=True,
        activity=interpreter_stt_noise_filter,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "audio", "next": None},
    ),
    "stt.diarization": NodeSpec(
        key="stt.diarization",
        implemented=True,
        activity=interpreter_stt_diarization,
        critical=False,
        default_timeout_seconds=120,
        default_max_attempts=3,
        output_keys={"out": "audio", "next": None},
    ),
    "stt.languageDetection": NodeSpec(
        key="stt.languageDetection",
        implemented=True,
        activity=interpreter_stt_language_detection,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"out": "audio", "next": None},
    ),
    "stt.asrEngine": NodeSpec(
        key="stt.asrEngine",
        implemented=True,
        activity=interpreter_stt_asr_engine,
        critical=True,
        default_timeout_seconds=600,
        default_max_attempts=2,
        output_keys={"out": "transcript", "loop": None, "next": None},
    ),
    "stt.transcriptOutput": NodeSpec(
        key="stt.transcriptOutput",
        implemented=True,
        activity=interpreter_stt_transcript_output,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"loop": None, "next": None},
    ),
    # PLACEHOLDER — implemented=False, see palette.md. TASK-710/phi-redactor is not landed.
    "stt.phiHop": NodeSpec(
        key="stt.phiHop",
        implemented=False,
        activity=interpreter_stt_phi_hop,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=1,
        output_keys={"out": "transcript", "next": None},
    ),
    # Consultation palette (TASK-731) — all 13 node types from contracts/node-types.md's node
    # table. TASK-731 shipped only 3 (consentGate, phiHop, hitlGate); the other 10 were specified
    # but left unwired, which made the palette unbuildable — DRAFT_CONSULTATION_RULE_SET names
    # nine node types by key and the registry served three of them, so no consultation graph could
    # be authored, let alone compiled. The ten wrappers added here follow the pattern
    # nodes/consultation.py already established for consentGate/phiHop: a thin
    # NodeActivityInput -> NodeActivityResult adapter over the activity
    # contracts/palette-contract.md §1 already names as that node's compile target.
    #
    # `default_timeout_seconds`/`default_max_attempts` are NOT invented here — each mirrors what
    # HarnessDocWorkflow already schedules the SAME underlying activity with (workflows.py's
    # _ACTIVITY_TIMEOUT=150 / _MCP_TIMEOUT=30 / _INFERENTIAL_TIMEOUT=900 / _LOOP_ACTION_TIMEOUT=30
    # and the matching _NLP_RETRY / _MCP_RETRY / _API_RETRY / _GENERATE_RETRY / _RETRIEVAL_RETRY /
    # _INFERENTIAL_RETRY / _LOOP_ACTION_RETRY policies).
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
    "consultation.captureBinding": NodeSpec(
        key="consultation.captureBinding",
        implemented=True,
        activity=interpreter_consultation_capture_binding,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "transcript", "next": None},
    ),
    # external_write=True for the persist leg (persist_entities), not the extraction — see
    # contracts/node-types.md's `critical` rationale, third bullet.
    "consultation.extractEntities": NodeSpec(
        key="consultation.extractEntities",
        implemented=True,
        activity=interpreter_consultation_extract_entities,
        critical=False,
        external_write=True,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "entities", "next": None},
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
    "consultation.assemblePrompt": NodeSpec(
        key="consultation.assemblePrompt",
        implemented=True,
        activity=interpreter_consultation_assemble_prompt,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=3,
        output_keys={"out": "text", "next": None},
    ),
    "consultation.synthesize": NodeSpec(
        key="consultation.synthesize",
        implemented=True,
        activity=interpreter_consultation_synthesize,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "text", "next": None},
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
    # The ONE durable human wait in this substrate (TASK-731 Phase B). `kind="child_workflow"` is
    # the field NodeSpec has reserved for exactly this since TASK-718 and this is its first use:
    # the interpreter does NOT dispatch `activity` for this node — the compiler lifts every
    # `gate`-classed node out of `stages` into `gates`, and `WorkflowInterpreter._run_gate` starts
    # `ConsultationGateWorkflow` as a child instead (see gate_workflow.py). `activity` stays a
    # real callable because NodeSpec requires one and because `activity_name` is the S-4
    # cross-check anchor; reaching it means a routing bug, and it degrades saying so.
    "consultation.hitlGate": NodeSpec(
        key="consultation.hitlGate",
        implemented=True,
        activity=interpreter_consultation_hitl_gate,
        kind="child_workflow",
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=1,
        output_keys={"out": None, "next": None},
    ),
    # R3's three missing capabilities (TASK-791 W1-W3). TASK-789 verified none of them had a
    # node, activity or sensor anywhere. Mirrors node-registry.ts's matching three entries and
    # the committed parity fixture exactly.
    #
    # `realtimeSummary` is `external_write=True` because it PUBLISHES to the live consultation
    # feed; that also makes the interpreter's sandbox suppression correct for free — a sandbox
    # run must not push interim summaries into a real consultation's UI.
    #
    # `suggestions` and `proposeCorrections` are `external_write=False` on purpose: both are
    # PROPOSAL surfaces that return their output and write nothing. `proposeCorrections` in
    # particular must never be the thing that edits clinical text — see
    # nodes/consultation_realtime.py's module docstring.
    #
    # None is `critical`: CR-14 makes only consentGate/hitlGate critical, and a suggestion or a
    # spelling proposal failing must never fail a consultation that is otherwise producing a note.
    "consultation.realtimeSummary": NodeSpec(
        key="consultation.realtimeSummary",
        implemented=True,
        activity=interpreter_consultation_realtime_summary,
        critical=False,
        external_write=True,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "text", "next": None},
    ),
    "consultation.suggestions": NodeSpec(
        key="consultation.suggestions",
        implemented=True,
        activity=interpreter_consultation_suggestions,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "suggestions", "next": None},
    ),
    "consultation.proposeCorrections": NodeSpec(
        key="consultation.proposeCorrections",
        implemented=True,
        activity=interpreter_consultation_propose_corrections,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "proposals", "next": None},
    ),
}
