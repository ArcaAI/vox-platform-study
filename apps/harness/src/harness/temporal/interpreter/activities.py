"""Interpreter-owned activities: the seed node activities (Task 4) and the
claim-check config-loader activity (Task 5).

Every activity here follows the same posture as ``harness.temporal.activities``: all I/O
(including the claim-check dereference) lives here, never in the workflow body.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import typing
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from harness.core.config import get_settings
from harness.core.redis_client import build_run_event_redis
from harness.services.api_client import ApiClientError, ApiServiceError
from harness.temporal.activities import (
    STATUS_ERROR,
    STATUS_OK,
    STEP_NODE,
    _api_client,
    _now,
)
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # reuse, never a second emitter (Task 7) — noqa: SLF001
)
from harness.temporal.claim_check import ClaimCheckRef, load_blob, open_store, store_blob
from harness.temporal.interpreter import data_contract, node_events, payload_refs
from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE
from harness.temporal.interpreter.compiled_config import CompiledWorkflowConfig, parse_and_verify
from harness.temporal.interpreter.data_contract import CONSULTATION_PATH_PHI
from harness.temporal.interpreter.models import (
    ConsultationReadRequest,
    ConsultationReadResult,
    ContextPathRequest,
    ContextPathResult,
    EvaluateExpressionInput,
    EvaluateExpressionResult,
    LiveAudioStateRequest,
    LiveAudioStateResult,
    LiveOutputsRequest,
    LiveOutputsResult,
    NodeActivityInput,
    NodeActivityResult,
    RunEventBatch,
    RunEventSpec,
)
from harness.temporal.interpreter.nodes._shared import MISSING, resolve_dotted_path
from harness.temporal.interpreter.nodes.core import CORE_ACTIVITIES
from harness.temporal.interpreter.run_events import (
    EVENT_GUARDRAIL_NOTICE,
    EVENT_NODE_COMPLETED,
    EVENT_NODE_FAILED,
    EVENT_NODE_STARTED,
    EVENT_RUN_COMPLETED,
    EVENT_RUN_PAUSED,
    EVENT_RUN_STARTED,
    RunEventProducer,
    v2_node_key,
    v2_run_key,
)
from harness.temporal.interpreter.run_protocol import (
    guardrail_notice_problems,
    run_error,
    run_error_message,
)

# ---------------------------------------------------------------------------
# Seed node activities (Task 4/6's tests dispatch against these; adds
# the real summarization-palette activities alongside these, never in place of
# them — noop/passthrough stay as harness-owned smoke-test node types).
# ---------------------------------------------------------------------------


async def _record_and_flush(
    payload: NodeActivityInput, *, status: str, started: Any, error_code: str | None = None
) -> None:
    """One NODE trajectory step per node activity — reuses `_TrajectoryBatch` (Task 7).

    Best-effort by construction (`_TrajectoryBatch.flush()` swallows its own exceptions) —
    a trajectory/gateway outage never fails the node, matching the same posture every other
    harness activity already has for `report_progress`/`report_trajectory`.
    """
    batch = TrajectoryBatch(get_settings(), payload.trajectory)
    batch.record(
        step_type=STEP_NODE,
        name=payload.node_type,
        status=status,
        started=started,
        error_code=error_code,
    )
    await batch.flush()


@activity.defn(name="interpreter.noop")
async def interpreter_noop(payload: NodeActivityInput) -> NodeActivityResult:
    """Always succeeds; does nothing. The registry's simplest sanctioned node type.

    Accepts an optional ``config["raise_error"]`` flag so hermetic tests can exercise the
    DEGRADED path without a real multi-second Temporal timeout (an ActivityError from an
    application-raised exception is handled identically to one from a timeout by the
    workflow's per-node wrapper — see contracts/ example). An
    optional ``config["sleep_seconds"]`` (small, real wall-clock — activities are NOT
    time-skipped) lets a test hold this node in flight long enough to land a signal before the
    next stage starts, without inventing a second test-only activity.
    """
    started = _now()
    sleep_seconds = payload.config.get("sleep_seconds")
    if sleep_seconds:
        await asyncio.sleep(float(sleep_seconds))
    if payload.config.get("raise_error"):
        await _record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="simulated_failure"
        )
        raise RuntimeError(f"interpreter.noop: simulated failure for node {payload.node_id}")
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED")


@activity.defn(name="interpreter.passthrough")
async def interpreter_passthrough(payload: NodeActivityInput) -> NodeActivityResult:
    """Echoes its own config back as output. Used to prove fan-out nodes run independently."""
    started = _now()
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=dict(payload.config))


# ---------------------------------------------------------------------------
# Graph boundary markers (palette-agnostic). `core.start`/`core.end` are the two
# node types the palette-independent structural rules WF-S-002/003/004/007 are
# written against; before they were registered, NO graph in ANY palette could
# satisfy them. They execute NOTHING — the whole point is that a marker is not
# work — but they must be dispatchable, because compile() refuses any graph
# containing an unimplemented node type, which would leave every graph
# unpublishable for a different reason. Same shape as noop, deliberately.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.core_start")
async def interpreter_core_start(payload: NodeActivityInput) -> NodeActivityResult:
    """The graph's entry marker. Executes nothing; records one NODE trajectory step so a run
    trace shows where the walk began."""
    started = _now()
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED")


@activity.defn(name="interpreter.core_end")
async def interpreter_core_end(payload: NodeActivityInput) -> NodeActivityResult:
    """The graph's terminal marker. Executes nothing — in particular it is NOT a delivery or
    persistence step; whatever the graph produced was already written by its own
    `external_write` node before the walk reached here."""
    started = _now()
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED")


NodeActivityFn = Callable[[NodeActivityInput], Awaitable[NodeActivityResult]]


#: Node types whose output is never offloaded: the workflow body reads it STRUCTURALLY
#: (`core.variable`'s `vars` map is merged into the run context in memory), and its content is
#: the graph's own config, already in history.
_OFFLOAD_EXEMPT_NODE_TYPES = frozenset({"core.variable"})
#: Output keys the workflow body reads by value and that must therefore stay inline.
_OFFLOAD_PROTECTED_KEYS = frozenset({"contextItemId", "_degraded"})
#: A value smaller than this is never worth a store round trip, whatever the total.
_OFFLOAD_MIN_VALUE_BYTES = 1024

#: Dereferenced blobs, keyed by their sha256 (content-addressed, so immutable): a run whose
#: context carries N offloaded outputs would otherwise re-read all N in every later activity.
#: Bounded by total bytes and by age — PHI held in worker memory stays short-lived.
_BLOB_CACHE_MAX_BYTES = 32 * 1024 * 1024
_BLOB_CACHE_TTL_SECONDS = 300.0
_BLOB_CACHE: OrderedDict[str, tuple[float, str]] = OrderedDict()


def _json_size(value: Any) -> int:
    return len(_dumps(value).encode("utf-8"))


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def _cached_blob(sha256: str) -> str | None:
    entry = _BLOB_CACHE.get(sha256)
    if entry is None:
        return None
    stored_at, text = entry
    if time.monotonic() - stored_at > _BLOB_CACHE_TTL_SECONDS:
        _BLOB_CACHE.pop(sha256, None)
        return None
    _BLOB_CACHE.move_to_end(sha256)
    return text


def _cache_blob(sha256: str, text: str) -> None:
    _BLOB_CACHE[sha256] = (time.monotonic(), text)
    _BLOB_CACHE.move_to_end(sha256)
    total = sum(len(t) for _, t in _BLOB_CACHE.values())
    while _BLOB_CACHE and total > _BLOB_CACHE_MAX_BYTES:
        _, (_, evicted) = _BLOB_CACHE.popitem(last=False)
        total -= len(evicted)


async def _load_marker(marker: dict[str, Any]) -> Any:
    """The value a claim-check marker stands for (integrity-verified by ``load_blob``)."""
    ref = ClaimCheckRef.model_validate(marker[payload_refs.MARKER_KEY])
    text = _cached_blob(ref.sha256)
    if text is None:
        store, _ = await open_store(get_settings().claim_check, ref)
        text = await load_blob(ref, store=store)
        _cache_blob(ref.sha256, text)
    return json.loads(text)


async def _resolve_references(value: Any, run_payload: Any) -> Any:
    """``value`` with every reference replaced by what it stands for (see ``payload_refs``)."""
    if payload_refs.is_marker(value):
        return await _load_marker(value)
    if payload_refs.is_run_payload_sentinel(value):
        return run_payload
    if payload_refs.is_deferred_trigger(value):
        spec = value[payload_refs.RUN_TRIGGER_KEY]
        base = await _resolve_references(spec.get("base"), run_payload)
        live = spec.get("live") if isinstance(spec.get("live"), dict) else {}
        return payload_refs.publish_trigger(base if isinstance(base, dict) else {}, live)
    if isinstance(value, dict):
        return {k: await _resolve_references(v, run_payload) for k, v in value.items()}
    if isinstance(value, list):
        return [await _resolve_references(v, run_payload) for v in value]
    return value


def _has_reference(value: Any) -> bool:
    if payload_refs.is_reference(value):
        return True
    if isinstance(value, dict):
        return any(_has_reference(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_reference(v) for v in value)
    return False


async def hydrate_node_input(payload: NodeActivityInput) -> NodeActivityInput:
    """TASK-1038 R-3 — the node input with every reference dereferenced (I/O; activity only)."""
    if not (
        _has_reference(payload.run_payload)
        or _has_reference(payload.run_context)
        or _has_reference(payload.bound_inputs)
    ):
        return payload
    run_payload = payload.run_payload
    if payload_refs.is_marker(run_payload):
        loaded = await _load_marker(run_payload)
        run_payload = loaded if isinstance(loaded, dict) else {}
    return payload.model_copy(
        update={
            "run_payload": run_payload,
            "run_context": await _resolve_references(payload.run_context, run_payload),
            "bound_inputs": await _resolve_references(payload.bound_inputs, run_payload),
        }
    )


async def offload_node_output(
    payload: NodeActivityInput, result: NodeActivityResult
) -> NodeActivityResult:
    """TASK-1038 R-3 — a large output's biggest values stored out of band (I/O; activity only).

    Values are offloaded largest-first until the output is under
    ``HARNESS_CLAIM_CHECK_NODE_OUTPUT_MIN_BYTES``; each becomes a claim-check marker the next
    consuming activity dereferences. The output's KEYS never change, so the workflow's binding
    (one named key per edge) works on the reference exactly as it did on the value.
    """
    output = result.output
    settings = get_settings().claim_check
    # TASK-1038 — the run's own threshold when the gateway injected one (`RunLimits`); the
    # `HARNESS_CLAIM_CHECK_NODE_OUTPUT_MIN_BYTES` setting otherwise (one-release transition).
    min_bytes = payload.output_offload_min_bytes or settings.node_output_min_bytes
    if (
        not output
        or not settings.enabled
        or payload.node_type in _OFFLOAD_EXEMPT_NODE_TYPES
        or _json_size(output) < min_bytes
    ):
        return result
    shaped = dict(output)
    sizes = {
        key: _json_size(value)
        for key, value in shaped.items()
        if key not in _OFFLOAD_PROTECTED_KEYS and not payload_refs.is_marker(value)
    }
    store = None
    bucket = ""
    for key in sorted(sizes, key=lambda k: sizes[k], reverse=True):
        if _json_size(shaped) < min_bytes:
            break
        if sizes[key] < _OFFLOAD_MIN_VALUE_BYTES:
            break
        if store is None:
            store, location = await open_store(settings)
            bucket = location.bucket
        ref = await store_blob(_dumps(shaped[key]), store=store, bucket=bucket)
        shaped[key] = payload_refs.make_marker(ref.model_dump(mode="json"))
    return result.model_copy(update={"output": shaped})


def _refuse_oversized_result(payload: NodeActivityInput, result: NodeActivityResult) -> None:
    """A result Temporal would refuse is refused HERE, by name and non-retryably."""
    ceiling = get_settings().claim_check.activity_input_max_bytes
    size = len(result.model_dump_json().encode("utf-8"))
    if size > ceiling:
        raise ApplicationError(
            f"PAYLOAD_TOO_LARGE: node {payload.node_id!r} ({payload.node_type}) produced a "
            f"{size}-byte result > {ceiling}",
            type="PAYLOAD_TOO_LARGE",
            non_retryable=True,
        )


#: TASK-1038 R-4 — how often a running node activity heartbeats. A cancellation the workflow
#: requests reaches an activity ONLY on a heartbeat response, so without these a cancelled run's
#: LLM call ran to completion on the worker. The SDK throttles the actual RPCs (to its
#: `default_heartbeat_throttle_interval`, 30 s, when no heartbeat timeout is set), which bounds
#: how late the cancellation lands; no `heartbeat_timeout` is scheduled, so a slow beat can
#: never fail a node.
_HEARTBEAT_INTERVAL_SECONDS = 5.0


async def _heartbeat_forever() -> None:
    while True:
        activity.heartbeat()
        await asyncio.sleep(_HEARTBEAT_INTERVAL_SECONDS)


def _finish_bindings(payload: NodeActivityInput) -> NodeActivityInput:
    """TASK-1036 §9.2 — finish every DEFERRED binding (its references are dereferenced by now);
    one that resolves to nothing is dropped, so the node sees the input as unbound."""
    if not any(data_contract.is_deferred(v) for v in payload.bound_inputs.values()):
        return payload
    finished: dict[str, Any] = {}
    for name, value in payload.bound_inputs.items():
        done = data_contract.finish_deferred(value, lambda v: v)
        if not data_contract.is_missing(done):
            finished[name] = done
    return payload.model_copy(update={"bound_inputs": finished})


def _with_io(
    payload: NodeActivityInput, result: NodeActivityResult, started_at: Any, started: float
) -> NodeActivityResult:
    """TASK-1036 §9.1 — the NodeIO envelope's metadata on the result (usage, timing, artifacts).

    The envelope's ``outputs`` are a projection of ``output`` and are not copied here.
    """
    io = dict(result.io or {})
    usage = node_events.usage_of(result.output)
    if usage is not None:
        io.setdefault("usage", {**usage, "tokens": usage["in"] + usage["out"], "costUnits": 0})
    io.setdefault(
        "timing",
        {
            "startedAt": started_at.isoformat() if hasattr(started_at, "isoformat") else None,
            "durationMs": int((time.monotonic() - started) * 1000),
        },
    )
    artifacts = []
    audio = (result.output or {}).get("audio")
    if isinstance(audio, dict) and isinstance(audio.get("key"), str):
        artifacts.append(
            {
                "kind": "audio",
                "ref": audio["key"],
                "mime": str(audio.get("content_type") or audio.get("contentType") or ""),
                "size": int(audio.get("size") or 0),
            }
        )
    io.setdefault("artifacts", artifacts)
    return result.model_copy(update={"io": io})


def node_activity_envelope(fn: NodeActivityFn) -> NodeActivityFn:
    """TASK-1038 — the envelope every interpreter NODE activity runs inside.

    On the way in, every claim-check reference in the input is dereferenced (R-3), so the node's
    own code never sees one; on the way out, a large output is offloaded and an output Temporal
    would refuse fails by name. Throughout, it heartbeats (R-4), which is how a cancellation the
    workflow requests reaches the node's own task. Returns a plain async function (no ``@activity.defn``) with the
    node activity's own signature, so the caller registers it under the name it chooses.
    """

    async def _enveloped(payload: NodeActivityInput) -> NodeActivityResult:
        heartbeat = asyncio.ensure_future(_heartbeat_forever()) if activity.in_activity() else None
        try:
            started_at = _now()
            started = time.monotonic()
            hydrated = _finish_bindings(await hydrate_node_input(payload))
            v2 = node_events.is_v2(hydrated)
            attempt = node_events.attempt_of()
            if v2:
                await node_events.emit_prelude(
                    run_event_producer(), hydrated, hydrated.bound_inputs, attempt
                )
            result = await fn(hydrated)
            if v2:
                result = _with_io(hydrated, result, started_at, started)
                streamed = set((result.io or {}).get("streamed") or [])
                await node_events.emit_outputs(
                    run_event_producer(), hydrated, result, attempt, streamed
                )
            result = await offload_node_output(hydrated, result)
            _refuse_oversized_result(hydrated, result)
            return result
        finally:
            if heartbeat is not None:
                heartbeat.cancel()

    _enveloped.__name__ = getattr(fn, "__name__", "node_activity")
    _enveloped.__qualname__ = getattr(fn, "__qualname__", _enveloped.__name__)
    return _enveloped


def _first_param_type(fn: Callable[..., Any]) -> Any:
    try:
        hints = typing.get_type_hints(fn)
    except Exception:  # noqa: BLE001 — an unresolvable hint is simply not ours to wrap
        return None
    params = list(inspect.signature(fn).parameters)
    return hints.get(params[0]) if params else None


def _evaluate_envelope(
    fn: Callable[[EvaluateExpressionInput], Awaitable[EvaluateExpressionResult]],
) -> Callable[[EvaluateExpressionInput], Awaitable[EvaluateExpressionResult]]:
    """``core.loop``'s ``until`` evaluation sees VALUES too: a body output it reads may have
    been offloaded (R-3), and CEL over a claim-check marker would silently read nothing."""

    async def _enveloped(payload: EvaluateExpressionInput) -> EvaluateExpressionResult:
        if _has_reference(payload.context):
            payload = payload.model_copy(
                update={"context": await _resolve_references(payload.context, {})}
            )
        return await fn(payload)

    _enveloped.__name__ = getattr(fn, "__name__", "evaluate")
    _enveloped.__qualname__ = getattr(fn, "__qualname__", _enveloped.__name__)
    return _enveloped


def _enveloped_activity(fn: Callable[..., Any]) -> Callable[..., Any]:
    """The registered form of one node activity: the envelope, under the activity's own name."""
    first = _first_param_type(fn)
    name = getattr(fn, "__temporal_activity_definition").name
    if first is NodeActivityInput:
        return activity.defn(name=name)(node_activity_envelope(fn))
    if first is EvaluateExpressionInput:
        return activity.defn(name=name)(_evaluate_envelope(fn))
    return fn


#: The activity callables the seventeen catalogue actions run, derived FROM the catalogue rather
#: than listed by hand — the list and the catalogue cannot disagree if one is computed from the
#: other. Order is the catalogue's, de-duplicated (`guard.phi` and `consultation.phiHop` share an
#: activity), so the served set stays stable across runs.
ACTION_ACTIVITIES: list[Callable[..., Any]] = list(
    dict.fromkeys(spec.activity for spec in ACTION_CATALOGUE.values())
)

NODE_ACTIVITIES: list[Callable[..., Any]] = [
    # TASK-893 Phase 4 — the served set is now exactly what the interpreter DISPATCHES:
    #   * the eleven `core.*` node types (`registry.py`'s NODE_REGISTRY), plus
    #   * the seventeen ACTIONS behind `core.action` (`action_catalogue.py`), which
    #     `interpreter_core_action` calls through `spec.activity`.
    # `CORE_ACTIVITIES` also carries `interpreter.core_evaluate`, the CEL activity `LoopWorkflow`
    # schedules for `until` — dispatched by a WORKFLOW rather than by a node spec, which is why
    # it is served even though no NodeSpec names it.
    #
    # The two-list discipline this comment used to spell out is unchanged and is now MACHINE
    # CHECKED in both directions by `test_realtime_capability_nodes.py`'s
    # `test_every_registered_node_activity_is_served_by_the_worker`: `NODE_REGISTRY` +
    # `ACTION_CATALOGUE` decide what is dispatched, this list decides what the worker serves, and
    # an entry in the first but not the second passes every static check and then fails at
    # runtime with an unregistered-activity error.
    #
    # Everything else that used to be served here went with its node type. The activities the
    # SEVENTEEN actions run are spread from `ACTION_ACTIVITIES` below rather than re-typed, for
    # the reason a hand-typed catalogue of that size always gives: a re-typed name goes missing.
    *ACTION_ACTIVITIES,
    *CORE_ACTIVITIES,
]

#: TASK-1038 R-3 — what the worker SERVES: every node activity above, each wrapped in
#: :func:`node_activity_envelope` under its own registered name (claim-check references in, large
#: outputs offloaded out). `NODE_ACTIVITIES` keeps the bare callables, which is what
#: `registry.py` / `ACTION_CATALOGUE` name and what `core.action` delegates to in-process.
SERVED_NODE_ACTIVITIES: list[Callable[..., Any]] = [
    _enveloped_activity(fn) for fn in NODE_ACTIVITIES
]

# ---------------------------------------------------------------------------
# Claim-check config loader (Task 5, S-2) — the ONLY place compiledConfig is
# dereferenced. The workflow body never calls claim_check directly.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.load_config")
async def load_config(ref: ClaimCheckRef) -> CompiledWorkflowConfig:
    """Dereference + admit a compiledConfig blob. Fails LOUD on any admission violation.

    See contracts/ for the six-step admission sequence this performs
    (dereference, parse, formatVersion check, checksum verify, gates-empty check, structural
    bounds). A corrupt/invalid config must fail the run — never execute a partial graph.
    """
    settings = get_settings()
    store, _ = await open_store(settings.claim_check, ref)
    # ClaimCheckNotFound / ClaimCheckIntegrityError propagate unmodified — fail loud
    # (S-2's contract), never substitute an empty config.
    raw = await load_blob(ref, store=store)
    return parse_and_verify(raw)


# ---------------------------------------------------------------------------
# TASK-1038 R-3 — resolve a run-context path that crosses a reference.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.resolve_context_path")
async def resolve_context_path(request: ContextPathRequest) -> ContextPathResult:
    """Dereference the references a dotted path walks through, then resolve the path.

    The workflow-side caller is ``core.loop``'s ``over``: the walk resolves it in memory when it
    can, and asks here only when the path crosses a claim-check reference it cannot read.
    ``found: False`` is the same "unresolvable" the in-memory resolution reports.
    """
    run_payload: Any = request.run_payload
    if payload_refs.is_marker(run_payload):
        run_payload = await _load_marker(run_payload)
    context = await _resolve_references(request.run_context, run_payload)
    value = resolve_dotted_path(context, request.path)
    if value is MISSING:
        return ContextPathResult(found=False)
    return ContextPathResult(found=True, value=value)


# ---------------------------------------------------------------------------
# TASK-932 R-16a — the LIVE HANDOFF loader.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.load_live_outputs")
async def load_live_outputs(request: LiveOutputsRequest) -> LiveOutputsResult:
    """Read the LIVE lane's final per-node outputs for a consultation-bound run.

    The counterpart of ``load_config``: the ONLY place the live handoff is dereferenced, and
    like it, all I/O lives here rather than in the workflow body.

    Failure posture is deliberately the opposite of ``load_config``'s. A config that will not
    load must fail the run — executing a partial graph is worse than not executing it. A live
    handoff that will not load is a TRANSIENT condition of a session that is still in progress
    or of a gateway that is briefly unreachable, and the workflow polls: so a gateway error is
    reported as ``ended=False`` (ask again later) rather than raised, and only the workflow's own
    bound ends the wait. Nothing is ever fabricated — an empty ``outputs`` with ``ended=True`` is
    the gateway saying "the live lane produced nothing", which keeps the pre-existing
    ``no_bound_text`` degrade for a consultation that never recorded.
    """
    settings = get_settings()
    try:
        raw = await _api_client(settings).live_handoff(
            request.consultation_id,
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            node_ids=list(request.node_ids),
        )
    except ApiServiceError as exc:
        # PHI-safe: the run/consultation ids and the status only — never the note.
        activity.logger.warning(
            "harness.interpreter.live_handoff_unavailable "
            f"run_id={request.run_id} consultation_id={request.consultation_id} error={exc}"
        )
        return LiveOutputsResult(ended=False)
    try:
        return LiveOutputsResult.model_validate(raw)
    except ValueError as exc:
        activity.logger.warning(
            "harness.interpreter.live_handoff_malformed "
            f"run_id={request.run_id} consultation_id={request.consultation_id} error={exc}"
        )
        return LiveOutputsResult(ended=False)


# ---------------------------------------------------------------------------
# TASK-1042 OD-4a — the LIVE AUDIO state (C5, state only).
# ---------------------------------------------------------------------------

#: C5 states the wait understands; anything else is read as "still live".
_LIVE_AUDIO_STATES = frozenset({"live", "ended", "truncated", "timeout"})


@activity.defn(name="interpreter.load_live_audio_state")
async def load_live_audio_state(request: LiveAudioStateRequest) -> LiveAudioStateResult:
    """Ask the gateway whether the run's bound STT session is still live (C5).

    The poll behind the walk's durable live-audio wait (``workflow.py``). It returns the STATE
    and nothing else: this result is recorded in the run's history on every poll, and the
    transcript C5 also answers with is PHI that the ASR node reads once, itself.

    Failure posture, like ``load_live_outputs``: an unreachable gateway or an answer this module
    cannot read is ``live`` (ask again in 5 s), never mistaken for an ended session. A 4xx is
    terminal for the call and is reported as ``unbound`` (C5 answers 404 for a session that is not
    this tenant's or not bound to this run): the wait ends and the node fails by name.
    """
    try:
        raw = await _api_client(get_settings()).get_stt_session_transcript(
            request.stt_session_id, tenant_id=request.tenant_id, run_id=request.run_id
        )
    except ApiClientError as exc:
        activity.logger.warning(
            "harness.interpreter.live_audio_state_refused",
            extra={"run_id": request.run_id, "status_code": exc.status_code},
        )
        return LiveAudioStateResult(state="unbound")
    except ApiServiceError as exc:
        activity.logger.warning(
            "harness.interpreter.live_audio_state_unavailable",
            extra={"run_id": request.run_id, "error": str(exc)},
        )
        return LiveAudioStateResult(state="live")
    state = raw.get("state") if isinstance(raw, dict) else None
    if state not in _LIVE_AUDIO_STATES:
        return LiveAudioStateResult(state="live")
    return LiveAudioStateResult(state=state)


# ---------------------------------------------------------------------------
# TASK-1036 §9.3 — declared consultation reads (OD-30)
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.read_consultation")
async def read_consultation(request: ConsultationReadRequest) -> ConsultationReadResult:
    """Read ONE node's declared ``consultation.*`` paths through the gateway's internal route.

    Least privilege by construction: only the paths the compiled workflow declared for this node
    are asked for, tenant-checked by the gateway. The values are this activity's RESULT, so they
    are recorded in history and a replay binds exactly what the first execution read (snapshot
    semantics — the transcript grows during a live consultation).

    A REFUSAL (a 4xx: undeclared path, another tenant's consultation) is a result, ``ok: false``,
    never retried; a transport failure raises and Temporal retries it. On success the admin
    ``consultation.read`` event is appended (best-effort).
    """
    try:
        raw = await _api_client(get_settings()).read_consultation(
            request.consultation_id,
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            node_id=request.node_id,
            paths=list(request.paths),
        )
    except ApiClientError as exc:
        # PHI-safe: ids and the status only.
        return ConsultationReadResult(ok=False, error=f"refused ({exc.status_code})")
    raw_values = raw.get("values") if isinstance(raw, dict) else None
    values = {
        path: raw_values.get(path)
        for path in request.paths
        if isinstance(raw_values, dict) and path in raw_values
    }
    result = ConsultationReadResult(
        ok=True,
        values=values,
        read_at=raw.get("readAt") if isinstance(raw.get("readAt"), str) else None,
        schema_version=(
            raw.get("schemaVersion") if isinstance(raw.get("schemaVersion"), int) else None
        ),
    )
    await run_event_producer().append(
        run_id=request.run_id,
        type="consultation.read",
        node_id=request.node_id,
        data={
            "consultationId": request.consultation_id,
            "snapshot": request.snapshot,
            "fields": [
                {
                    "path": path,
                    "phiClass": CONSULTATION_PATH_PHI.get(path, "PHI"),
                    "value": values.get(path),
                }
                for path in request.paths
            ],
        },
        dedupe_key=v2_node_key(
            request.run_id, request.node_id, activity.info().attempt, f"read:{request.snapshot}"
        ),
    )
    return result


# ---------------------------------------------------------------------------
# Run-event mirror — the CONTROL lane's one activity.
# ---------------------------------------------------------------------------

_RUN_EVENT_REDIS: Any | None = None
_RUN_EVENT_REDIS_BUILT = False


def run_event_producer() -> RunEventProducer:
    """One producer per worker process. Built lazily; a failure yields a no-op producer.

    Lazy because a worker must boot with Redis down (`redis_client.py`'s whole posture), and
    because `Redis.from_url` binds to the running event loop.

    PUBLIC on purpose: this is the DELTA lane's entry point for any node activity that
    streams — a token stream, and (lane B) STT/TTS audio. Call
    ``run_event_producer().text_delta(...)`` / ``.audio_delta(...)`` from inside the activity, never from the
    workflow body, and never route a delta through a signal or an activity-per-chunk. Signals
    land in Temporal history, whose ceiling is 51,200 events / 50 MB per run, so a long
    deliberation streamed through Temporal dies mid-flight. ``test_task849_two_lane_split.py``
    MEASURES that this stays true.
    """
    global _RUN_EVENT_REDIS, _RUN_EVENT_REDIS_BUILT  # noqa: PLW0603 — process-wide singleton
    if not _RUN_EVENT_REDIS_BUILT:
        _RUN_EVENT_REDIS = build_run_event_redis(get_settings().redis_url)
        _RUN_EVENT_REDIS_BUILT = True
    return RunEventProducer(_RUN_EVENT_REDIS)


#: The settled node status → `node.completed.status` (v2 spells success `COMPLETED`).
_V2_NODE_STATUS = {"SUCCEEDED": "COMPLETED", "DEGRADED": "DEGRADED", "SKIPPED": "SKIPPED"}


def run_error_code_of(reason: str | None) -> str:
    """The fixed run-error code a free-text node/run reason maps to (pure).

    The code is what a business caller sees (with its fixed label); the reason itself rides only
    in the admin-trace ``error.detail``.
    """
    text = reason or ""
    if text.startswith("GUARDRAIL_BLOCKED"):
        return "GUARDRAIL_BLOCKED"
    if text.startswith("PAYLOAD_TOO_LARGE"):
        return "PAYLOAD_TOO_LARGE"
    if text.startswith("CONSULTATION_READ_FAILED"):
        return "CONSULTATION_READ_FAILED"
    if text == "run_timed_out":
        return "RUN_TIMED_OUT"
    if "TimeoutError" in text or "timed_out" in text:
        return "NODE_TIMED_OUT"
    if "unresolved_input_binding" in text or "binding_unresolved" in text:
        return "BINDING_UNRESOLVED"
    if "prompt_variable_unresolved" in text:
        return "PROMPT_VARIABLE_UNRESOLVED"
    if "agent_version" in text:
        return "AGENT_VERSION_UNAVAILABLE"
    if "TextServiceError" in text or "text generate failed" in text:
        return "MODEL_ERROR"
    if "ApiServiceError" in text or "unavailable" in text:
        return "DOWNSTREAM_UNAVAILABLE"
    if "SchemaViolation" in text or "schema" in text:
        return "OUTPUT_INVALID"
    return "INTERNAL_ERROR"


def _tokens(spec: RunEventSpec) -> dict[str, int] | None:
    if spec.tokens_in is None and spec.tokens_out is None:
        return None
    return {"in": max(0, spec.tokens_in or 0), "out": max(0, spec.tokens_out or 0)}


async def _append_spec(
    producer: RunEventProducer, batch: RunEventBatch, spec: RunEventSpec
) -> None:
    """Map ONE workflow-described fact onto its run-protocol v2 event(s) and append them."""
    run_id = batch.run_id
    node_id = spec.node_id or ""
    duration = max(0, spec.duration_ms or 0)
    if spec.event_type == EVENT_RUN_STARTED:
        await producer.append(
            run_id=run_id,
            type="run.started",
            data={
                "kind": "workflow",
                "slug": spec.slug or "workflow",
                "versionNumber": max(1, spec.version_number or 1),
            },
            dedupe_key=v2_run_key(run_id, "started"),
        )
        return
    if spec.event_type == EVENT_NODE_STARTED:
        # TASK-1050 W2f — a node RE-RUN after a guardrail hold is a later attempt, so a client
        # drops the refused attempt's partial outputs (protocol-v2.md §3).
        attempt = max(1, spec.attempt or 1)
        data: dict[str, Any] = {"kind": spec.node_type or "node", "attempt": attempt}
        if spec.label:
            data["label"] = spec.label
        await producer.append(
            run_id=run_id,
            type="node.started",
            node_id=node_id,
            data=data,
            dedupe_key=v2_node_key(run_id, node_id, attempt, "started"),
        )
        return
    if spec.event_type in (EVENT_GUARDRAIL_NOTICE, EVENT_RUN_PAUSED):
        await _append_hold(producer, run_id, spec)
        return
    if spec.event_type in (EVENT_NODE_COMPLETED, EVENT_NODE_FAILED):
        for field_name, value in (spec.outputs or {}).items():
            await producer.append(
                run_id=run_id,
                type="output.data",
                node_id=node_id,
                data={"field": field_name, "value": value, "visibility": "admin"},
                dedupe_key=v2_node_key(run_id, node_id, 1, f"output:{field_name}"),
            )
        settled = v2_node_key(run_id, node_id, 1, "settled")
        if spec.event_type == EVENT_NODE_FAILED or spec.status == "FAILED":
            await producer.append(
                run_id=run_id,
                type="node.failed",
                node_id=node_id,
                data={
                    "durationMs": duration,
                    "error": run_error(
                        spec.error_code or run_error_code_of(spec.reason),
                        node_id=node_id,
                        detail=spec.reason,
                    ),
                },
                dedupe_key=settled,
            )
            return
        completed: dict[str, Any] = {
            "status": _V2_NODE_STATUS.get(spec.status or "SUCCEEDED", "COMPLETED"),
            "durationMs": duration,
        }
        tokens = _tokens(spec)
        if tokens is not None:
            completed["tokens"] = tokens
        if completed["status"] == "DEGRADED":
            # TASK-1059 — why it degraded, PHI-free: the fixed code and its fixed label only.
            code = spec.error_code or run_error_code_of(spec.reason)
            completed["errorCode"] = code
            completed["errorMessage"] = run_error_message(code)
        await producer.append(
            run_id=run_id,
            type="node.completed",
            node_id=node_id,
            data=completed,
            dedupe_key=settled,
        )
        return
    if spec.event_type == EVENT_RUN_COMPLETED:
        await _append_terminal(producer, batch, spec, duration)
        return
    # `workflow.loop.iteration` and any other legacy-only fact have no v2 type: not stored.


async def _append_hold(producer: RunEventProducer, run_id: str, spec: RunEventSpec) -> None:
    """TASK-1050 W2f — the hold's two public facts. Deduped on the NOTICE, so a retried emit (or
    a replay that re-runs the activity) writes each once."""
    notice = spec.notice
    notice_id = notice.get("noticeId") if isinstance(notice, dict) else None
    if not isinstance(notice, dict) or not isinstance(notice_id, str):
        return
    if spec.event_type == EVENT_GUARDRAIL_NOTICE:
        await producer.append(
            run_id=run_id,
            type="guardrail.notice",
            node_id=spec.node_id or None,
            data=notice,
            dedupe_key=v2_run_key(run_id, f"notice:{notice_id}"),
        )
        return
    await producer.append(
        run_id=run_id,
        type="run.paused",
        data={"reason": "guardrail_hold", "noticeId": notice_id, "nodeId": spec.node_id or ""},
        dedupe_key=v2_run_key(run_id, f"paused:{notice_id}"),
    )


async def _append_terminal(
    producer: RunEventProducer, batch: RunEventBatch, spec: RunEventSpec, duration: int
) -> None:
    run_id = batch.run_id
    status = spec.status or "FAILED"
    terminal: dict[str, Any] = {
        "dedupe_key": v2_run_key(run_id, "completed"),
        "retention_seconds": spec.retention_seconds,
        # A run the gateway started before it injected `retentionSeconds` (one release).
        "allow_missing_retention": spec.retention_seconds is None,
    }
    tokens = _tokens(spec) or {"in": 0, "out": 0}
    if status in ("SUCCEEDED", "DEGRADED"):
        data: dict[str, Any] = {"status": "COMPLETED", "durationMs": duration, "tokens": tokens}
        if spec.result_outputs:
            try:
                result = await _run_result(
                    spec.result_outputs, spec.result_inline_max_bytes, tenant_id=batch.tenant_id
                )
            except Exception as exc:  # noqa: BLE001 — a result read never drops the event
                activity.logger.warning(
                    f"harness.run_events.result_unavailable run_id={run_id} error={exc}"
                )
                result = None
            if result is not None:
                data["result"] = result
        if status == "DEGRADED":
            data["degraded"] = True
        notices = [n for n in spec.guardrail_notices or [] if not guardrail_notice_problems(n)]
        if notices:
            # TASK-1050 — filtered again here: one non-conforming notice would make the whole
            # terminal event non-conforming, and the sequencer would refuse it.
            data["guardrailNotices"] = notices
        await producer.append(run_id=run_id, type="run.completed", data=data, **terminal)
        return
    if status == "CANCELLED":
        cancelled: dict[str, Any] = {"status": "CANCELED", "durationMs": duration}
        await producer.append(run_id=run_id, type="run.cancelled", data=cancelled, **terminal)
        return
    timed_out = status == "TIMED_OUT"
    code = "RUN_TIMED_OUT" if timed_out else (spec.error_code or run_error_code_of(spec.reason))
    failed: dict[str, Any] = {
        "status": "TIMED_OUT" if timed_out else "FAILED",
        "durationMs": duration,
        "error": run_error(code, detail=spec.reason),
        "tokens": tokens,
    }
    await producer.append(run_id=run_id, type="run.failed", data=failed, **terminal)


async def _run_result(
    outputs: dict[str, dict[str, Any]],
    inline_max_bytes: int | None = None,
    *,
    tenant_id: str,
) -> dict[str, Any] | None:
    """TASK-1038 D-I — the completed event's ``result``: inline, or a claim-check reference.

    The value is the ``core.output`` node's published ``payload`` (or its own ``resultRef``);
    with several output nodes, a map keyed by node id. At most
    ``HARNESS_CLAIM_CHECK_RESULT_INLINE_MAX_BYTES`` serialized travels inline; anything larger
    travels as ``{kind: "ref", bucket, key, sizeBytes, sha256, tenantPrefixed: true}``.

    TASK-1038 lane E3 (security) — the result object is a CALLER-facing object: the gateway signs
    a URL for it and deletes it on purge, so it is always written under ``<tenantId>/`` (still
    content-addressed within the prefix) and the ref says so with ``tenantPrefixed``. When the
    result is exactly one value already in the store (a node-output claim-check, un-prefixed and
    internal), its bytes are COPIED under the tenant prefix — the internal object is never handed
    out. Content-addressed, so a retry of this activity re-writes the identical object.
    """
    values: dict[str, Any] = {}
    for node_id, output in outputs.items():
        if "payload" in output:
            values[node_id] = output["payload"]
        elif isinstance(output.get("resultRef"), dict):
            values[node_id] = payload_refs.make_marker(output["resultRef"])
    if not values:
        return None
    value: Any = next(iter(values.values())) if len(values) == 1 else values
    settings = get_settings().claim_check
    # TASK-1038 — the run's own ceiling when the gateway injected one; the setting otherwise.
    limit = inline_max_bytes or settings.result_inline_max_bytes
    if payload_refs.is_marker(value):
        ref = ClaimCheckRef.model_validate(value[payload_refs.MARKER_KEY])
        if ref.size > limit:
            # Integrity-verified read of the internal object, re-written byte-for-byte (same
            # size and sha256) under the tenant's prefix.
            read_store, _ = await open_store(settings, ref)
            text = await load_blob(ref, store=read_store)
            return await _store_result(text, settings, tenant_id)
    resolved = await _resolve_references(value, {})
    serialized = _dumps(resolved)
    if len(serialized.encode("utf-8")) <= limit:
        return {"kind": "inline", "value": resolved}
    return await _store_result(serialized, settings, tenant_id)


async def _store_result(text: str, settings: Any, tenant_id: str) -> dict[str, Any]:
    """Write a run result under ``<tenantId>/`` and describe it for ``run.completed``."""
    store, location = await open_store(settings)
    ref = await store_blob(text, store=store, bucket=location.bucket, key_prefix=tenant_id)
    return {
        "kind": "ref",
        "bucket": ref.bucket,
        "key": ref.key,
        "sizeBytes": ref.size,
        "sha256": ref.sha256,
        "tenantPrefixed": True,
    }


@activity.defn(name="interpreter.emit_run_events")
async def emit_run_events(batch: RunEventBatch) -> int:
    """Append one stage boundary's control facts to the run's stream as run-protocol v2 events.

    Returns the number of facts handed to the sequencer — 0 is a normal outcome. This activity
    NEVER raises: the run's durable record is Temporal history, and a mirror that could fail a
    clinical run would have inverted which of the two lanes matters. The workflow additionally
    catches ``ActivityError`` around every call. Each fact is appended with a dedupe key derived
    from its intent, so a retry of this activity writes nothing twice.
    """
    producer = run_event_producer()
    handled = 0
    for spec in batch.events:
        try:
            await _append_spec(producer, batch, spec)
            handled += 1
        except Exception as exc:  # noqa: BLE001 — see the docstring: this never raises
            activity.logger.warning(
                "harness.run_events.event_rejected "
                f"run_id={batch.run_id} event_type={spec.event_type} error={exc}"
            )
    return handled


# Registered on the worker alongside DOCUMENT_ACTIVITIES/LOOP_ACTIVITIES/
# REASONING_ACTIVITIES — the interpreter's own activity list.
INTERPRETER_ACTIVITIES: list[Callable[..., Any]] = [
    *SERVED_NODE_ACTIVITIES,
    load_config,
    load_live_outputs,
    load_live_audio_state,
    resolve_context_path,
    emit_run_events,
    read_consultation,
]
