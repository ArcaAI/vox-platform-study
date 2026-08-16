"""STT-palette node activities (TASK-724 Task 3) — DELIBERATE PLACEHOLDERS, not the real
execution path.

Read `docs/implementation/TASK-724-Palette-Stt/README.md` §1 before assuming these should do real
work: **the STT palette's central design decision is that a published STT `WorkflowDefinition`
compiles into an `AsrPipeline` + `AsrPipelineVersion` row (TASK-724 Task 4) rather than being
executed node-by-node by this interpreter.** Realtime sessions bind `pipelineId` directly
(`stt-ws.gateway.ts` -> Redis Streams -> `apps/stt`); batch dispatches through a single harness
Temporal activity (TASK-724 Task 5) that calls the EXISTING `TranscriptionJobController`/Dramatiq
path once per job, never per-node. No per-frame audio, no per-token transcript, and no realtime
session lifecycle ever executes inside a Temporal workflow (rule 06's determinism constraint would
make a per-frame signal loop both a correctness risk and a latency disaster for 16kHz realtime
audio — see the ticket README's "Known pitfall").

So why do these activities exist at all? The cross-language node-registry parity guard
(`node-registry.ts` / `registry.py` / `node-registry.snapshot.json`) requires every
`implemented: true` node type on the TypeScript side to have a REAL, registrable
`@activity.defn` callable on the Python side (`NodeSpec.activity` is a required field;
`_registered_activity_name` introspects it) — `compile()` needs `nodeInfo(type)` to resolve so a
published STT graph's `compiledConfig` can be stamped (Task 4 walks that same `compiledConfig` to
emit `AsrPipeline.configYaml`). These seven activities (`stt.phiHop`'s is separate and registered
`implemented: false` — see `palette.md`) satisfy that registration requirement HONESTLY: each one,
if ever actually dispatched by the generic interpreter (e.g. a future Workbench single-node
sandbox test-run — design.md names this as a real, if not-yet-built, use case), returns
`DEGRADED` with a `reason` naming exactly why it is not the real execution path, rather than
either raising confusingly or silently claiming `SUCCEEDED` for work that never happened. This
mirrors the `stt.phiHop` precedent's own rule: "fail loudly... never pass through while claiming
the hop ran" — generalised to every node in this palette, since none of them execute for real
inside a Temporal workflow today.
"""

from __future__ import annotations

from temporalio import activity

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import STATUS_OK, now, record_and_flush

_NOT_A_REAL_EXECUTION_PATH = (
    "stt-palette nodes are compiled into an AsrPipeline at publish time (TASK-724 Task 4) and "
    "bound by pipelineId at session-open/batch-dispatch time — this interpreter activity is a "
    "registry-parity placeholder, not the pipeline's real execution path. See "
    "docs/implementation/TASK-724-Palette-Stt/README.md §1."
)


async def _placeholder_result(payload: NodeActivityInput) -> NodeActivityResult:
    started = now()
    # STATUS_OK here is the TRAJECTORY step's own status (the activity completed cleanly,
    # observably), independent of the NodeActivityResult.status below, which is DEGRADED.
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="DEGRADED", reason=_NOT_A_REAL_EXECUTION_PATH)


@activity.defn(name="interpreter.stt_audio_input")
async def interpreter_stt_audio_input(payload: NodeActivityInput) -> NodeActivityResult:
    """N-1 `stt.audioInput` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_vad")
async def interpreter_stt_vad(payload: NodeActivityInput) -> NodeActivityResult:
    """N-2 `stt.vad` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_noise_filter")
async def interpreter_stt_noise_filter(payload: NodeActivityInput) -> NodeActivityResult:
    """N-3 `stt.noiseFilter` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_diarization")
async def interpreter_stt_diarization(payload: NodeActivityInput) -> NodeActivityResult:
    """N-4 `stt.diarization` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_language_detection")
async def interpreter_stt_language_detection(payload: NodeActivityInput) -> NodeActivityResult:
    """N-5 `stt.languageDetection` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_asr_engine")
async def interpreter_stt_asr_engine(payload: NodeActivityInput) -> NodeActivityResult:
    """N-6 `stt.asrEngine` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_transcript_output")
async def interpreter_stt_transcript_output(payload: NodeActivityInput) -> NodeActivityResult:
    """N-7 `stt.transcriptOutput` — placeholder, see module docstring."""
    return await _placeholder_result(payload)


@activity.defn(name="interpreter.stt_phi_hop")
async def interpreter_stt_phi_hop(payload: NodeActivityInput) -> NodeActivityResult:
    """N-8 `stt.phiHop` — registered `implemented: false` in `registry.py`'s `NODE_REGISTRY`, so
    `compile()` refuses any graph that includes this node type; this callable exists only to
    satisfy `NodeSpec.activity`'s required-callable contract for the registration itself. If ever
    reached anyway (a bug bypassing the registry gate), it degrades exactly like its siblings
    rather than claiming a redaction that TASK-710 has not shipped.
    """
    return await _placeholder_result(payload)
