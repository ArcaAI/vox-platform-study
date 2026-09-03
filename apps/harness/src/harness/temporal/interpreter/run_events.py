"""lane A step 1 — the **Phase C** producer for workflow runs.

shipped the envelope and the resume-token CONVENTION (Phases A/B) and
explicitly deferred Phase C: *a reference producer wired into any service*. Until
now nothing produced run events at all, which is why the gateway's
``WorkflowStreamService`` had to POLL the dispatcher's plain-JSON status read
(``workflow-stream.service.ts``'s own class doc says so). This module is that
producer, and its existence is what lets the poll go away.

**Two lanes, and the split is the whole point** (program rule 17,
step 2):

* **Redis Streams — the DELTA lane.** Token / STT / TTS deltas, and the control
  events' own MIRROR, are written here. Redis assigns the message id, which is the
  transport-native cursor a resume token wraps (async-contract The stream is
  ``MAXLEN``-trimmed, so a consumer that falls far enough behind gets a *gap* rather
  than silence — the gateway detects it and re-snapshots.
* **Temporal — the CONTROL lane.** Node/stage/run outcomes remain what they already
  were: workflow history plus the ``state`` query. Nothing in this module makes
  Temporal the transport for a delta. Signals land in history and the ceiling is
  51,200 events / 50 MB per run, so a token stream routed through Temporal kills a
  long deliberation mid-flight.

**Durability posture: this stream is a MIRROR, never the record.** Every write here
is best-effort and swallows its own failure, exactly like ``_TrajectoryBatch.flush()``
and ``report_progress`` already do in this package. Temporal's history is the durable
truth; a Redis outage costs a client its live push and nothing else — it re-snapshots
from the ``state`` query and carries on. A producer that could FAIL a clinical run
because an observability mirror was unreachable would be trading the thing that
matters for the thing that does not.

**No Public-Preview dependency.** Temporal's Workflow Streams is Public Preview; the
day-1 design is a ``@workflow.query`` state snapshot (already shipped) plus this Redis
mirror. Adopting Workflow Streams at GA is a change behind the gateway, not a change
to this contract.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import structlog
from hope_async_contract import AsyncEnvelope, AsyncIdempotencyKey

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Stream identity
# ---------------------------------------------------------------------------

#: Key prefix for a run's event stream. Mirrors apps/text's ``text:stream:<taskId>``
#: (``services/task_manager.py``) — one stream per unit of work, never one shared
#: stream partitioned by a field, so a consumer's ``XREAD`` cursor means exactly one
#: run and a trim can never evict another run's backlog.
RUN_EVENT_STREAM_KEY_PREFIX = "wf:run:"

#: Bounded, and the bound is load-bearing: an unbounded stream is an unbounded memory
#: commitment on a shared Redis, and the delta lane is deliberately high-volume. Same
#: value apps/text's ``TaskManager`` uses for the same reason. A consumer that falls
#: further behind than this sees a TRIMMED-ID GAP, which the client contract handles by
# re-snapshotting rather than by silently losing tokens.
RUN_EVENT_STREAM_MAX_LEN = 10_000

# The transport name embedded in the opaque resume token (async-contract The
#: consumer never parses the token; this string exists so a future transport swap is
#: detectable rather than silently mis-read.
RUN_EVENT_TRANSPORT = "redis-stream"


def run_event_stream_key(run_id: str) -> str:
    """The Redis Stream key carrying one run's events (pure)."""
    return f"{RUN_EVENT_STREAM_KEY_PREFIX}{run_id}:events"


# ---------------------------------------------------------------------------
# Event types — the lane each one belongs to is stated, not implied
# ---------------------------------------------------------------------------

#: CONTROL lane (mirrored from Temporal). Two-to-five lowercase dotted segments, per
#: the envelope's own ``type`` pattern.
EVENT_NODE_STARTED = "workflow.node.started"
EVENT_NODE_COMPLETED = "workflow.node.completed"
EVENT_NODE_FAILED = "workflow.node.failed"
EVENT_LOOP_ITERATION = "workflow.loop.iteration"
EVENT_GUARDRAIL_VERDICT = "workflow.guardrail.verdict"
EVENT_RUN_COMPLETED = "workflow.run.completed"

#: DELTA lane. Never routed through Temporal — that is the split this module exists
#: to enforce, and ``test_task849_two_lane_split.py`` MEASURES it rather than asserting it.
EVENT_TOKEN_DELTA = "workflow.token.delta"

CONTROL_EVENT_TYPES = frozenset(
    {
        EVENT_NODE_STARTED,
        EVENT_NODE_COMPLETED,
        EVENT_NODE_FAILED,
        EVENT_LOOP_ITERATION,
        EVENT_GUARDRAIL_VERDICT,
        EVENT_RUN_COMPLETED,
    }
)

DELTA_EVENT_TYPES = frozenset({EVENT_TOKEN_DELTA})


# ---------------------------------------------------------------------------
# Idempotency keys — derived from INTENT, never from chance (async-contract
# ---------------------------------------------------------------------------


def node_started_key(run_id: str, node_id: str, attempt_generation: int) -> str:
    """``…:node:<nodeId>:<gen>:started``.

    The recipe table's ``workflowNode`` key names *node completion*; "this node began"
    is a DIFFERENT intent and needs a different key, or a consumer collapsing on the key
    would drop the start. Still a pure function of (run, node, attempt) — never a clock,
    never a counter, never a UUID.
    """
    return f"{AsyncIdempotencyKey.workflow_node(run_id, node_id, attempt_generation)}:started"


def node_settled_key(run_id: str, node_id: str, attempt_generation: int) -> str:
    """The recipe table's ``workflowNode`` key, unchanged.

    Deliberately the SAME key for the completed and failed paths — the corollary spelled
    out in ``idempotency.py``'s header: *"the abort/failure path uses the SAME key as the
    completion path for the same intent. Inventing an `...:aborted` suffix double-delivers."*
    """
    return AsyncIdempotencyKey.workflow_node(run_id, node_id, attempt_generation)


def token_delta_key(run_id: str, node_id: str, sequence: int) -> str:
    """``wf:run:<runId>:node:<nodeId>:delta:<sequence>`` — shaped after ``textChunk``."""
    return f"wf:run:{run_id}:node:{node_id}:delta:{sequence}"


def loop_iteration_key(run_id: str, node_id: str, iteration: int) -> str:
    """``wf:run:<runId>:node:<nodeId>:iter:<n>``."""
    return f"wf:run:{run_id}:node:{node_id}:iter:{iteration}"


def run_completed_key(run_id: str) -> str:
    """``wf:run:<runId>:completed`` — one terminal event per run, however often it is retried."""
    return f"wf:run:{run_id}:completed"


# ---------------------------------------------------------------------------
# Envelope construction
# ---------------------------------------------------------------------------


def build_run_event(
    *,
    tenant_id: str,
    run_id: str,
    event_type: str,
    idempotency_key: str,
    payload: dict[str, Any],
    causation_id: str | None = None,
) -> AsyncEnvelope:
    """One conforming async-contract envelope for a run event.

    ``correlationId`` is the ``runId``: every event caused by or about the same run
    shares it, which is what lets a debug surface join a token delta to the node that
    produced it and to the run that contains both.

    Called only from ACTIVITY code (never a workflow body) — ``uuid4`` and
    ``datetime.now`` are both forbidden inside ``@workflow.defn``.
    """
    return AsyncEnvelope(
        schema_version=1,
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        type=event_type,
        occurred_at=datetime.now(UTC).isoformat(),
        correlation_id=run_id,
        causation_id=causation_id,
        idempotency_key=idempotency_key,
        payload=payload,
    )


def encode_run_event(envelope: AsyncEnvelope) -> str:
    """Wire form of one envelope: camelCase JSON, matching the TypeScript twin exactly.

    ``exclude_unset=True``, and it is not cosmetic — the same reason apps/text's
    ``TaskManager`` uses it (``task_manager.py:192``). ``payload_ref`` was never
    assigned, and the contract's XOR is "exactly one of the two is PRESENT", not
    "exactly one is non-null": dumping ``payloadRef: null`` alongside ``payload``
    produces an envelope that fails its own validator on both sides of the wire.
    Every other field is passed explicitly to the constructor — ``causationId``
    included, precisely so an explicit ``null`` survives this filter.
    """
    return envelope.model_dump_json(by_alias=True, exclude_unset=True)


# ---------------------------------------------------------------------------
# The producer
# ---------------------------------------------------------------------------


class RunEventProducer:
    """Writes run events onto a run's Redis Stream. Best-effort, by contract.

    Holds a Redis client rather than building one, so the two callers that matter —
    the emit ACTIVITY and a node activity streaming tokens — share one connection per
    worker process and the unit suite can hand in a fake without a server.
    """

    def __init__(self, redis: Any | None, *, max_len: int = RUN_EVENT_STREAM_MAX_LEN) -> None:
        self._redis = redis
        self._max_len = max_len

    async def emit(self, envelope: AsyncEnvelope) -> str | None:
        """Append one envelope; return the Redis message id, or ``None`` on any failure.

        ``None`` is a supported outcome and never an exception: this stream is a mirror
        (see the module docstring). A caller that treats ``None`` as fatal has
        misunderstood which of the two lanes carries the durable record.
        """
        if self._redis is None:
            return None
        run_id = envelope.correlation_id
        try:
            message_id = await self._redis.xadd(
                run_event_stream_key(run_id),
                {"data": encode_run_event(envelope)},
                maxlen=self._max_len,
                approximate=True,
            )
        except Exception as exc:  # noqa: BLE001 — a mirror outage never fails a clinical run
            logger.warning(
                "harness.run_events.emit_failed",
                run_id=run_id,
                event_type=envelope.type,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            return None
        return message_id.decode() if isinstance(message_id, bytes) else str(message_id)

    async def emit_many(self, envelopes: list[AsyncEnvelope]) -> list[str]:
        """Append several envelopes in order. Returns the ids that were actually written."""
        written: list[str] = []
        for envelope in envelopes:
            message_id = await self.emit(envelope)
            if message_id is not None:
                written.append(message_id)
        return written

    async def emit_loop_iteration(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_id: str,
        iteration: int,
        max_iterations: int,
        tokens_used: int,
        max_total_tokens: int,
        digest: str,
        terminated: bool,
    ) -> str | None:
        """One ``agentic.loop`` iteration, settled. The CONTROL lane's per-iteration entry point.

        Called from ``interpreter.loop_state_checkpoint`` — the activity that already runs
        exactly once per iteration — so this adds NO Temporal command and needs no
        ``workflow.patched`` gate. The durable record of the iteration is that activity's own
        history event plus the ``continue_as_new`` boundary; this is the live mirror the debug
        canvas reads, exactly as the node-boundary control events are (``emit_run_events``).

        **The payload is scalars only, and that is a constraint rather than a preference.** A
        loop's carry-forward may be megabytes and may be claim-check offloaded above 256 KiB
        (``LOOP_STATE_INLINE_LIMIT_BYTES``); embedding it here would put that blob back on the
        wire once per iteration and defeat the offload entirely. What travels is identity
        (``nodeId``), the drill-down's position (``iteration`` / ``maxIterations``) and the
        STOP-RELEVANT counters — the invoice, the convergence digest, and whether the
        orchestrator declared itself done.

        ``iteration`` is ONE-BASED and names the iteration that just completed, so a client
        renders ``3/12`` rather than ``2/12`` for the third one.
        """
        return await self.emit(
            build_run_event(
                tenant_id=tenant_id,
                run_id=run_id,
                event_type=EVENT_LOOP_ITERATION,
                idempotency_key=loop_iteration_key(run_id, node_id, iteration),
                payload={
                    "nodeId": node_id,
                    "iteration": iteration,
                    "maxIterations": max_iterations,
                    "tokensUsed": tokens_used,
                    "maxTotalTokens": max_total_tokens,
                    "digest": digest,
                    "terminated": terminated,
                },
            )
        )

    async def emit_token_delta(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_id: str,
        sequence: int,
        text: str,
    ) -> str | None:
        """The DELTA lane's one entry point.

        This never touches Temporal — not a signal, not an activity result, not an
        update. That is the split, and it is why a 10 000-delta run adds no proportional
        history (``test_task849_two_lane_split.py`` measures exactly that).
        """
        return await self.emit(
            build_run_event(
                tenant_id=tenant_id,
                run_id=run_id,
                event_type=EVENT_TOKEN_DELTA,
                idempotency_key=token_delta_key(run_id, node_id, sequence),
                payload={"nodeId": node_id, "sequence": sequence, "text": text},
            )
        )
