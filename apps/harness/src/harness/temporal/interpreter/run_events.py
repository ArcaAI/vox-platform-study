"""lane A step 1 — the **Phase C** producer for workflow runs.

**TASK-1038 R6 — run protocol v2.** Since this change the producer writes run-protocol v2 entries
ONLY, every one through the single sequencer script (``run_protocol.RUN_APPEND_LUA``): a
contiguous ``seq``, a ``body`` field (never the legacy ``data``), dedupe keys derived from intent
and the run's retention on its terminal event. The ``EVENT_*`` names below are now the WORKFLOW's
internal vocabulary for the facts it hands ``interpreter.emit_run_events`` (``RunEventSpec``);
the activity maps them onto the v2 types. The text below describes the two-lane split, which
is unchanged.

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

import base64
from datetime import UTC, datetime
from typing import Any

import structlog

from harness.temporal.interpreter.run_protocol import (
    RUN_APPEND_LUA,
    RUN_STREAM_MAX_LEN,
    RunProtocolError,
    build_run_append,
)

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


def run_event_stream_key(run_id: str) -> str:
    """The Redis Stream key carrying one run's events (pure)."""
    return f"{RUN_EVENT_STREAM_KEY_PREFIX}{run_id}:events"


# ---------------------------------------------------------------------------
# Event types — the lane each one belongs to is stated, not implied
# ---------------------------------------------------------------------------

#: The facts the WORKFLOW names for ``interpreter.emit_run_events`` (``RunEventSpec.event_type``).
#: Internal vocabulary: the activity maps each onto its run-protocol v2 type(s). Deltas never
#: come through here — they are appended by the producing activity (``text_delta`` /
#: ``audio_delta``), and ``test_task849_two_lane_split.py`` MEASURES that they never touch
#: Temporal.
EVENT_RUN_STARTED = "workflow.run.started"
EVENT_NODE_STARTED = "workflow.node.started"
EVENT_NODE_COMPLETED = "workflow.node.completed"
EVENT_NODE_FAILED = "workflow.node.failed"
EVENT_RUN_COMPLETED = "workflow.run.completed"
#: TASK-1050 W2f — a node's generation was refused by guardrail (`guardrail.notice`, public), and
#: the run now waits at it for a resolution (`run.paused`, public; README §9.8.1).
EVENT_GUARDRAIL_NOTICE = "workflow.guardrail.notice"
EVENT_RUN_PAUSED = "workflow.run.paused"


# ---------------------------------------------------------------------------
# TASK-1038 R6 — run protocol v2 dedupe keys (derived from INTENT, never a clock or a UUID)
# ---------------------------------------------------------------------------


def v2_node_key(run_id: str, node_id: str, attempt: int, intent: str, scope: str = "") -> str:
    """``wf:run:<runId>:node:<nodeId>[:<scope>]:<attempt>:<intent>`` — ``scope`` separates the
    iterations of a loop body (the same node runs once per iteration)."""
    middle = f"{node_id}:{scope}" if scope else node_id
    return f"wf:run:{run_id}:node:{middle}:{attempt}:{intent}"


def v2_run_key(run_id: str, intent: str) -> str:
    """``wf:run:<runId>:<intent>`` (``started``; ``completed`` for ANY terminal event — a run ends
    once)."""
    return f"wf:run:{run_id}:{intent}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# The producer — v2 only, through the ONE sequencer
# ---------------------------------------------------------------------------


class RunEventProducer:
    """Appends run-protocol v2 events through ``RUN_APPEND_LUA``. Best-effort, by contract.

    Every stored event of a run — the walk's control events, the activities' debug events, the
    deltas — goes through the same script, so one run has one contiguous ``seq`` whichever process
    writes it (``protocol-v2.md`` §6.1). The harness writes v2 entries ONLY; the gateway derives
    the legacy frames for legacy-selecting clients.

    Holds a Redis client rather than building one, so the emit activity and a streaming node
    activity share one connection per worker and the unit suite can hand in a fake.
    """

    def __init__(self, redis: Any | None, *, max_len: int = RUN_STREAM_MAX_LEN) -> None:
        self._redis = redis
        self._max_len = max_len
        self._script: Any | None = None

    async def append(
        self,
        *,
        run_id: str,
        type: str,  # noqa: A002 — the envelope's own field name
        data: dict[str, Any],
        node_id: str | None = None,
        dedupe_key: str | None = None,
        retention_seconds: int | None = None,
        allow_missing_retention: bool = False,
    ) -> int | None:
        """Append one event; return its ``seq``, or ``None`` on any failure (never raises).

        ``None`` is a supported outcome: the stream is a mirror of Temporal, never the record, and
        a refused append (``RUN_STREAM_CLOSED``, a non-conforming event) is logged and swallowed.
        """
        if self._redis is None or not run_id:
            return None
        try:
            command = build_run_append(
                run_id=run_id,
                type=type,
                ts=_now_iso(),
                data=data,
                node_id=node_id,
                dedupe_key=dedupe_key,
                retention_seconds=retention_seconds,
                max_len=self._max_len,
                allow_missing_retention=allow_missing_retention,
            )
        except RunProtocolError as exc:
            logger.warning(
                "harness.run_events.event_refused",
                run_id=run_id,
                event_type=type,
                problems=exc.problems,
            )
            return None
        try:
            if self._script is None:
                self._script = self._redis.register_script(RUN_APPEND_LUA)
            reply = await self._script(keys=command.keys, args=command.args)
        except Exception as exc:  # noqa: BLE001 — a mirror outage never fails a clinical run
            logger.warning(
                "harness.run_events.append_failed",
                run_id=run_id,
                event_type=type,
                error=str(exc),
                error_type=type_name(exc),
            )
            return None
        try:
            return int(reply[0])
        except (TypeError, ValueError, IndexError):
            return None

    async def text_delta(self, *, run_id: str, node_id: str, field: str, text: str) -> int | None:
        """``output.text.delta`` — no dedupe key: a retried model call produces different text,
        and the retry's ``node.started`` (attempt + 1) tells clients to discard the earlier
        partial text."""
        return await self.append(
            run_id=run_id,
            type="output.text.delta",
            node_id=node_id,
            data={"field": field, "text": text},
        )

    async def audio_delta(
        self,
        *,
        run_id: str,
        node_id: str,
        field: str,
        chunk: bytes,
        audio_format: str,
        sample_rate: int | None = None,
    ) -> int | None:
        """``output.audio.delta`` — the chunk base64-encoded, the format one of the protocol's."""
        data: dict[str, Any] = {
            "field": field,
            "chunk": base64.b64encode(chunk).decode("ascii"),
            "format": audio_format,
        }
        if sample_rate is not None:
            data["sampleRate"] = sample_rate
        return await self.append(
            run_id=run_id, type="output.audio.delta", node_id=node_id, data=data
        )


def type_name(exc: BaseException) -> str:
    return type(exc).__name__
