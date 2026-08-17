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

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from temporalio import activity as temporal_activity
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.activities import (
        interpreter_noop,
        interpreter_passthrough,
    )
    from harness.temporal.interpreter.nodes.consultation import (
        interpreter_consultation_consent_gate,
        interpreter_consultation_hitl_gate,
        interpreter_consultation_phi_hop,
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

    def __post_init__(self) -> None:
        # frozen dataclass: use object.__setattr__ for the derived field.
        object.__setattr__(self, "activity_name", _registered_activity_name(self.activity))


NODE_REGISTRY: dict[str, NodeSpec] = {
    "noop": NodeSpec(key="noop", implemented=True, activity=interpreter_noop),
    "passthrough": NodeSpec(key="passthrough", implemented=True, activity=interpreter_passthrough),
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
    ),
    "prompt.template_ref": NodeSpec(
        key="prompt.template_ref",
        implemented=True,
        activity=interpreter_template_ref,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
    ),
    "generate.text": NodeSpec(
        key="generate.text",
        implemented=True,
        activity=interpreter_text_generate,
        critical=True,
        default_timeout_seconds=300,
        default_max_attempts=2,
    ),
    "guardrail.check": NodeSpec(
        key="guardrail.check",
        implemented=True,
        activity=interpreter_guardrail_check,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
    ),
    "output.deliver": NodeSpec(
        key="output.deliver",
        implemented=True,
        activity=interpreter_deliver,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
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
    ),
    "stt.vad": NodeSpec(
        key="stt.vad",
        implemented=True,
        activity=interpreter_stt_vad,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
    ),
    "stt.noiseFilter": NodeSpec(
        key="stt.noiseFilter",
        implemented=True,
        activity=interpreter_stt_noise_filter,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
    ),
    "stt.diarization": NodeSpec(
        key="stt.diarization",
        implemented=True,
        activity=interpreter_stt_diarization,
        critical=False,
        default_timeout_seconds=120,
        default_max_attempts=3,
    ),
    "stt.languageDetection": NodeSpec(
        key="stt.languageDetection",
        implemented=True,
        activity=interpreter_stt_language_detection,
        critical=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
    ),
    "stt.asrEngine": NodeSpec(
        key="stt.asrEngine",
        implemented=True,
        activity=interpreter_stt_asr_engine,
        critical=True,
        default_timeout_seconds=600,
        default_max_attempts=2,
    ),
    "stt.transcriptOutput": NodeSpec(
        key="stt.transcriptOutput",
        implemented=True,
        activity=interpreter_stt_transcript_output,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=3,
    ),
    # PLACEHOLDER — implemented=False, see palette.md. TASK-710/phi-redactor is not landed.
    "stt.phiHop": NodeSpec(
        key="stt.phiHop",
        implemented=False,
        activity=interpreter_stt_phi_hop,
        critical=False,
        default_timeout_seconds=60,
        default_max_attempts=1,
    ),
    # Consultation palette (TASK-731) — a PARTIAL pass: only 3 of the palette's 13 node types are
    # wired this pass (contracts/node-types.md has the full 13-node design; nodes/consultation.py's
    # module docstring names exactly why the other 10 are not here yet — real, already-shipped
    # compile targets exist for each, but their interpreter wrappers were judged out of this
    # pass's time budget rather than rushed). See the ticket README §7.
    "consultation.consentGate": NodeSpec(
        key="consultation.consentGate",
        implemented=True,
        activity=interpreter_consultation_consent_gate,
        critical=True,
        external_write=False,
        default_timeout_seconds=30,
        default_max_attempts=3,
    ),
    "consultation.phiHop": NodeSpec(
        key="consultation.phiHop",
        implemented=True,
        activity=interpreter_consultation_phi_hop,
        critical=False,
        external_write=False,
        default_timeout_seconds=60,
        default_max_attempts=3,
    ),
    # PLACEHOLDER — implemented=False. The interpreter's durable-wait extension (Phase B) has not
    # been implemented; compile() therefore refuses any graph containing this node type. See
    # contracts/palette-contract.md §2 and nodes/consultation.py's module docstring.
    "consultation.hitlGate": NodeSpec(
        key="consultation.hitlGate",
        implemented=False,
        activity=interpreter_consultation_hitl_gate,
        critical=True,
        external_write=True,
        default_timeout_seconds=60,
        default_max_attempts=1,
    ),
}
