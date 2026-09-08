"""Node-type -> activity routing registry (S-4, S-6).

Mirrors ``LoopActionSpec``/``LOOP_ACTION_REGISTRY`` (``workflows.py:1628-1693``) in shape and in
the ``implemented`` discipline: a node type with NO entry, or an entry with ``implemented=False``,
dispatches as an OBSERVABLE skip (``unsupported_node_type``) — never a silent no-op (see
contracts/ for the full dispatch/security rationale, including why the
workflow always calls ``spec.activity`` directly and only cross-checks the wire's ``activity``
string, never trusts it for routing).

The registry starts EMPTY of palette nodes — populates it with the summarization
palette's five node types. This ticket ships only the ``noop``/``passthrough`` entries this
package's own tests need ( Task 4).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from temporalio import workflow

from harness.temporal.interpreter.node_spec import NodeSpec, _registered_activity_name

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE
    from harness.temporal.interpreter.activities import (
        interpreter_core_end,
        interpreter_core_start,
        interpreter_noop,
        interpreter_passthrough,
    )
    from harness.temporal.interpreter.nodes.agent_catalogue import (
        interpreter_agent_discharge_summary,
        interpreter_agent_dna_redaction,
        interpreter_agent_dna_style,
        interpreter_agent_feedback,
        interpreter_agent_grammar,
        interpreter_agent_important_findings,
        interpreter_agent_ner,
        interpreter_agent_normalization,
        interpreter_agent_presummarization,
        interpreter_agent_retrieval,
        interpreter_agent_summarization,
        interpreter_agent_transcription,
    )
    from harness.temporal.interpreter.nodes.agentic import (
        interpreter_agentic_agent,
        interpreter_agentic_data,
        interpreter_agentic_guardrail,
        interpreter_agentic_input,
        interpreter_agentic_loop,
        interpreter_agentic_output,
        interpreter_agentic_stt,
        interpreter_agentic_tts,
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
    from harness.temporal.interpreter.nodes.consultation_endpoint import (
        interpreter_feedback_capture,
        interpreter_harness_finalize,
        interpreter_livedoc_stop,
        interpreter_session_timeout,
        interpreter_summary_finalize,
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
    from harness.temporal.interpreter.nodes.core import (
        interpreter_core_action,
        interpreter_core_agent,
        interpreter_core_classify,
        interpreter_core_condition,
        interpreter_core_data,
        interpreter_core_human_review,
        interpreter_core_loop,
        interpreter_core_note,
        interpreter_core_output,
        interpreter_core_trigger,
        interpreter_core_variables,
    )
    from harness.temporal.interpreter.nodes.deliver import interpreter_deliver
    from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check
    from harness.temporal.interpreter.nodes.guards import (
        interpreter_guard_groundedness,
        interpreter_guard_moderation,
        interpreter_guard_phi,
    )
    from harness.temporal.interpreter.nodes.template_ref import interpreter_template_ref
    from harness.temporal.interpreter.nodes.text_generate import interpreter_text_generate


__all__ = [
    "ACTION_CATALOGUE",
    "CORE_LOOP_NODE_TYPE",
    "CORE_REVIEW_NODE_TYPE",
    "NODE_REGISTRY",
    "NodeSpec",
    "_registered_activity_name",
    "effective_spec",
    "output_keys_for",
]

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
    # Summarization palette. `critical`/`external_write`/timeouts mirror
    # contracts/palette.md's node table and node-registry.ts's matching five entries exactly.
    # RESTORED (2026-08-17, close-out pass): dropped from this dict by an external tree operation
    # mid-session (see / READMEs); the node activities themselves never stopped
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
    # STT palette — RETIRED, deliberately NO spec (TASK-861 step 10, closed by TASK-867).
    # The TypeScript registry keeps the eight `stt.*` descriptors for the deprecation window as
    # `implemented: false`, so `compile()` refuses them upstream; here they are simply absent,
    # which the interpreter already handles identically (`NODE_REGISTRY.get()` -> None ->
    # SKIPPED `unsupported_node_type`) and which costs no dead callable — a `NodeSpec` cannot exist
    # without a registered `@activity.defn`, and `nodes/stt_placeholder.py` is gone.
    # `test_node_registry_parity.py` pins the asymmetry: an `implemented: false` fixture entry must
    # have no spec here and no served activity.
    # Consultation palette — all 13 node types from contracts/node-types.md's node
    # table. shipped only 3 (consentGate, phiHop, hitlGate); the other 10 were specified
    # but left unwired, which made the palette unbuildable — DRAFT_CONSULTATION_RULE_SET names
    # nine node types by key and the registry served three of them, so no consultation graph could
    # be authored, let alone compiled. The ten wrappers added here follow the pattern
    # nodes/consultation.py already established for consentGate/phiHop: a thin
    # NodeActivityInput -> NodeActivityResult adapter over the activity
    # contracts/ already names as that node's compile target.
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
        lane="realtime",
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
        lane="realtime",
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
    # The ONE durable human wait in this substrate. `kind="child_workflow"` is
    # the field NodeSpec has reserved for exactly this since and this is its first use:
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
    # R3's three missing capabilities (-W3). verified none of them had a
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
        lane="realtime",
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
    # -----------------------------------------------------------------------------------------
    # The ENDPOINT STAGE — the ordered sequence that runs before a consultation
    # session closes. Mirrors node-registry.ts's matching three entries and the committed parity
    # fixture exactly.
    #
    # All three are `external_write=True`, which is load-bearing in this registry specifically:
    # `workflow.py` SKIPS any external_write node on a sandboxed run before the activity is ever
    # scheduled, so a Workbench run of a consultation graph can never lock a real clinician's
    # note or promote a correction onto a real transcript.
    #
    # None is `critical` (CR-14 keeps consentGate/hitlGate the only critical nodes): a feedback
    # capture that fails must not fail a consultation whose note is already finalized. What
    # protects the clinical work is ORDER — the default sequence runs finalize before anything
    # that may legitimately degrade — not criticality.
    #
    # `max_attempts=3` on all three because they are idempotent by construction (converging
    # upsert / state transition / deterministic promotion key), which is exactly the property
    # that makes a retry safe rather than a second write.
    # -----------------------------------------------------------------------------------------
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
    # TASK-882 — the two endpoint stages that had no node type. `livedoc.stop` closes a real
    # live session (external_write=True); `harness.finalize` is an ordering marker inside an
    # interpreter run (the graph IS the document workflow), so it writes nothing.
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
    # ---------------------------------------------------------------------------------------
    # The TARGET CATALOGUE (/DD-9) and the guards — lane A.
    # Every entry delegates to an engine that already exists; see
    # `nodes/agent_catalogue.py` and `nodes/guards.py` for the mapping and the reasoning.
    # Registered ALONGSIDE the pipeline keys above, never instead of them: a node type is a
    # contract with every saved tenant graph, and the seeds name the pipeline keys.
    # ---------------------------------------------------------------------------------------
    "agent.transcription": NodeSpec(
        key="agent.transcription",
        implemented=True,
        activity=interpreter_agent_transcription,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "transcript", "next": None},
        lane="realtime",
    ),
    "agent.normalization": NodeSpec(
        key="agent.normalization",
        implemented=True,
        activity=interpreter_agent_normalization,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=1,
        output_keys={"out": "entities", "next": None},
    ),
    "agent.ner": NodeSpec(
        key="agent.ner",
        implemented=True,
        activity=interpreter_agent_ner,
        critical=False,
        external_write=True,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "entities", "next": None},
        lane="realtime",
    ),
    # Lane R (R1) — the realtime grammar/spelling pass. `lane="realtime"` means `_dispatch_node`
    # SKIPS it here (reason `realtime_lane`) and live executor owns it; the durable
    # wrapper exists so the node type is dispatchable and admissible at all.
    "agent.grammar": NodeSpec(
        key="agent.grammar",
        implemented=True,
        activity=interpreter_agent_grammar,
        critical=False,
        default_timeout_seconds=20,
        default_max_attempts=1,
        output_keys={"out": "proposals", "next": None},
        lane="realtime",
    ),
    # Lane N — IMPORTANT FINDINGS, the one catalogue entry that is NOT a
    # delegation, because the capability had no engine anywhere to delegate to. `realtime` for the
    # same reason `agent.grammar` is and a stronger one: the owner's bar is findings surfaced
    # DURING the session, so this interpreter SKIPS it (reason `realtime_lane`) and
    # live executor owns it. `external_write=True` mirrors `agent.ner`: findings reach the live
    # consultation feed and the persisted flush snapshot through the same projection, so the flag
    # is the truth about the node rather than a claim about this durable wrapper.
    #
    # `output_keys["out"] = "findings"`, deliberately NOT "entities". The port PRIMITIVE is
    # `entities` so findings ride the existing highlight path; the distinct runtime KEY is what
    # keeps "the tenant said this matters" apart from "the detector saw a drug name" instead of
    # merging two different claims into one highlight set.
    "agent.important_findings": NodeSpec(
        key="agent.important_findings",
        implemented=True,
        activity=interpreter_agent_important_findings,
        critical=False,
        external_write=True,
        default_timeout_seconds=25,
        default_max_attempts=1,
        output_keys={"out": "findings", "next": None},
        lane="realtime",
    ),
    "agent.presummarization": NodeSpec(
        key="agent.presummarization",
        implemented=True,
        activity=interpreter_agent_presummarization,
        critical=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "text", "next": None},
    ),
    "agent.summarization": NodeSpec(
        key="agent.summarization",
        implemented=True,
        activity=interpreter_agent_summarization,
        critical=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "text", "next": None},
    ),
    "agent.discharge_summary": NodeSpec(
        key="agent.discharge_summary",
        implemented=True,
        activity=interpreter_agent_discharge_summary,
        critical=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "text", "next": None},
    ),
    "agent.retrieval": NodeSpec(
        key="agent.retrieval",
        implemented=True,
        activity=interpreter_agent_retrieval,
        critical=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "context", "next": None},
    ),
    "agent.feedback": NodeSpec(
        key="agent.feedback",
        implemented=True,
        activity=interpreter_agent_feedback,
        critical=False,
        external_write=True,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"next": None},
    ),
    "agent.dna_redaction": NodeSpec(
        key="agent.dna_redaction",
        implemented=True,
        activity=interpreter_agent_dna_redaction,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
        output_keys={"out": "text", "next": None},
    ),
    # TASK-882 -- the DNA writing-style gate: an ordering marker in an interpreter run (the
    # gateway applies the style at prompt assembly, keyed off this node's presence).
    "agent.dna_style": NodeSpec(
        key="agent.dna_style",
        implemented=True,
        activity=interpreter_agent_dna_style,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
        output_keys={"next": None},
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
    # ---------------------------------------------------------------------------------------
    # the GENERIC (`agentic`) catalogue.
    #
    # Eight node types whose behaviour is CONFIGURATION rather than key, mirroring
    # `node-registry.ts`. `output_keys` and `implemented` here are asserted against the SAME
    # committed fixture the TypeScript projection is (`node-registry.snapshot.json`), so a value
    # changed on one side only is a failing test rather than a silent drift.
    #
    # `agentic.loop` is `implemented=True` and still does not run on THIS path: `compile()`
    # refuses any graph containing an unimplemented type, so the honest posture is an
    # OBSERVABLE `DEGRADED` naming the owning ticket rather than a graph nobody can publish.
    # made the loop real via a CHILD WORKFLOW; this activity is the replay-only path
    # a pre-gate history walks through. `agentic.tts` is now REAL: it
    # dispatches synthesis, streams frames on the delta lane and writes an audio artifact.
    # See `nodes/agentic.py`'s module docstring.
    # ---------------------------------------------------------------------------------------
    "agentic.input": NodeSpec(
        key="agentic.input",
        implemented=True,
        activity=interpreter_agentic_input,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "payload", "next": None},
    ),
    "agentic.output": NodeSpec(
        key="agentic.output",
        implemented=True,
        activity=interpreter_agentic_output,
        critical=False,
        external_write=True,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "payload", "next": None},
    ),
    "agentic.agent": NodeSpec(
        key="agentic.agent",
        implemented=True,
        activity=interpreter_agentic_agent,
        critical=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={"out": "text", "data": "data", "next": None},
    ),
    "agentic.guardrail": NodeSpec(
        key="agentic.guardrail",
        implemented=True,
        activity=interpreter_agentic_guardrail,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=2,
        output_keys={"out": "verdict", "next": None},
    ),
    "agentic.data": NodeSpec(
        key="agentic.data",
        implemented=True,
        activity=interpreter_agentic_data,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "data", "next": None},
    ),
    "agentic.loop": NodeSpec(
        key="agentic.loop",
        implemented=True,
        activity=interpreter_agentic_loop,
        critical=False,
        # The whole `maxDurationSeconds` ceiling the config schema permits, because
        # spends that budget as a workflow timer INSIDE the loop; a smaller activity timeout
        # would cap the loop somewhere the author cannot see.
        default_timeout_seconds=3600,
        default_max_attempts=1,
        output_keys={"out": "result", "next": None},
    ),
    "agentic.stt": NodeSpec(
        key="agentic.stt",
        implemented=True,
        activity=interpreter_agentic_stt,
        critical=False,
        # Dispatching a batch transcription CREATES a `TranscriptionJob` row through apps/api,
        # so a sandboxed run must suppress it.
        external_write=True,
        default_timeout_seconds=900,
        default_max_attempts=2,
        output_keys={"out": "transcript", "next": None},
    ),
    "agentic.tts": NodeSpec(
        key="agentic.tts",
        implemented=True,
        activity=interpreter_agentic_tts,
        critical=False,
        external_write=True,
        default_timeout_seconds=300,
        default_max_attempts=2,
        output_keys={"out": "audio", "next": None},
    ),
    # -----------------------------------------------------------------------------------------
    # TASK-864 — the `core` vocabulary. Mirrors `node-registry.ts`; the parity fixture pins both.
    # The router/review handles (`otherwise`, `else`, `approved`/`rejected`/`timedOut`) are
    # CONTROL ports (`None`); the per-class / per-branch handles are per-instance and never
    # resolved as inputs — an edge from one becomes a `branchGuards` entry on the target, which
    # `_resolve_bound_inputs` never sees. `core.loop`'s `each` carries the current `item`.
    # -----------------------------------------------------------------------------------------
    "core.trigger": NodeSpec(
        key="core.trigger",
        implemented=True,
        activity=interpreter_core_trigger,
        critical=True,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=1,
        output_keys={"out": "context", "next": None},
    ),
    "core.agent": NodeSpec(
        key="core.agent",
        implemented=True,
        activity=interpreter_core_agent,
        critical=False,
        external_write=False,
        default_timeout_seconds=300,
        default_max_attempts=2,
        output_keys={
            "out": "text",
            "data": "data",
            "transcript": "transcript",
            "audio": "audio",
            "next": None,
        },
    ),
    "core.classify": NodeSpec(
        key="core.classify",
        implemented=True,
        activity=interpreter_core_classify,
        critical=False,
        external_write=False,
        default_timeout_seconds=60,
        default_max_attempts=2,
        output_keys={"out": "classification", "otherwise": None, "next": None},
    ),
    "core.humanReview": NodeSpec(
        key="core.humanReview",
        implemented=True,
        activity=interpreter_core_human_review,
        kind="child_workflow",
        critical=False,
        external_write=True,
        default_timeout_seconds=3600,
        default_max_attempts=1,
        output_keys={
            "out": "decision",
            "approved": None,
            "rejected": None,
            "timedOut": None,
            "next": None,
        },
    ),
    "core.variable": NodeSpec(
        key="core.variable",
        implemented=True,
        activity=interpreter_core_variables,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "vars", "next": None},
    ),
    "core.condition": NodeSpec(
        key="core.condition",
        implemented=True,
        activity=interpreter_core_condition,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "evaluation", "else": None, "next": None},
    ),
    "core.loop": NodeSpec(
        key="core.loop",
        implemented=True,
        activity=interpreter_core_loop,
        kind="child_workflow",
        critical=False,
        external_write=False,
        default_timeout_seconds=3600,
        default_max_attempts=1,
        output_keys={"each": "item", "done": "result", "next": None},
    ),
    "core.note": NodeSpec(
        key="core.note",
        implemented=True,
        activity=interpreter_core_note,
        critical=False,
        external_write=False,
        default_timeout_seconds=1,
        default_max_attempts=1,
        output_keys={},
    ),
    "core.output": NodeSpec(
        key="core.output",
        implemented=True,
        activity=interpreter_core_output,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=2,
        output_keys={},
    ),
    "core.data": NodeSpec(
        key="core.data",
        implemented=True,
        activity=interpreter_core_data,
        critical=False,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=2,
        output_keys={"out": "data", "next": None},
    ),
    "core.action": NodeSpec(
        key="core.action",
        implemented=True,
        activity=interpreter_core_action,
        critical=False,
        external_write=False,
        default_timeout_seconds=150,
        default_max_attempts=2,
        output_keys={
            "out": "result",
            "text": "text",
            "entities": "entities",
            "verdict": "verdict",
            "document": "document",
            "context": "context",
            "next": None,
        },
    ),
}

# TASK-893 — the `core.action` catalogue is a first-class table (`action_catalogue.py`);
# `effective_spec` resolves a `core.action` instance through it, never through NODE_REGISTRY.

#: The node types the interpreter dispatches as CHILD WORKFLOWS under the TASK-864 patch, rather
#: than as activities. Named once so `_dispatch_node` and the registry agree.
CORE_LOOP_NODE_TYPE = "core.loop"
CORE_REVIEW_NODE_TYPE = "core.humanReview"


def effective_spec(node_type: str, config: Mapping[str, Any] | None) -> NodeSpec | None:
    """The spec whose SAFETY properties govern an instance.

    For `core.action` that is the catalogue descriptor's spec (a `consultation.persistDraft`
    action writes, so a sandbox must suppress it); for everything else it is the type's own.
    `None` for an unknown type or an unknown action key.
    """
    spec = NODE_REGISTRY.get(node_type)
    if spec is None:
        return None
    if node_type == "core.action":
        key = config.get("actionKey") if isinstance(config, Mapping) else None
        return ACTION_CATALOGUE.get(key) if isinstance(key, str) else None
    return spec


def output_keys_for(
    node_type: str, config: Mapping[str, Any] | None
) -> Mapping[str, str | None] | None:
    """The output sockets an INSTANCE publishes — a `core.action`'s are its catalogue entry's."""
    spec = effective_spec(node_type, config)
    return None if spec is None else spec.output_keys
