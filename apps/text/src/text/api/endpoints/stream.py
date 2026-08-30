"""SSE subscription endpoints — the reader half of the producer/subscriber split.

TASK-818 Lane B (§3C.3(5)). Every response here is a *subscriber*: it attaches to
a producer that is already running, replays whatever the caller has not seen, then
tails. Closing one changes nothing about the generation (§3C.4).

Two routes, one handler:

* ``GET /generations/{generation_id}/stream`` — the resume endpoint. Unknown id
  → **204**, per the spec: there is nothing to stream and nothing was lost.
* ``GET /tasks/{task_id}/stream`` — the same stream under its pre-split name,
  kept while the gateway still issues the two-call flow, and keeping that flow's
  **404** for an unknown id so the caller's error handling is unchanged.

The cursor is a **sequence number**, not a Redis message id. That is what lets a
client resume across a router restart, when the Redis ids it saw are meaningless
but its own ``last_seq`` is not.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from hope_otel.trace_propagation import inject_trace_carrier
from pydantic import AliasChoices
from sse_starlette.sse import EventSourceResponse

from text.core.dependencies import get_task_manager
from text.routing.hub import GenerationEvent, GenerationHub, dedupe_by_seq, get_generation_hub
from text.services.task_manager import TaskManager

router = APIRouter(tags=["stream"])

#: sse-starlette emits a comment frame on this interval. Mandatory, not optional
#: (§3C.4): a silent LLM plus an idle-timeout proxy — Cloudflare 100 s, AWS ALB
#: 60 s — kills a long clinical generation's connection without it. It is also
#: the ONLY reliable disconnect signal: the write that fails is what tells us the
#: peer is gone, which is where the §3C.5 grace timer starts.
_PING_SECONDS = 15

#: SSE hop headers. ``X-Accel-Buffering: no`` stops nginx buffering the stream
#: into uselessness; the ingress half of this is Lane G's.
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def parse_cursor(generation_id: str, last_event_id: str | None, from_seq: int | None) -> int:
    """Resolve the resume cursor: ``Last-Event-ID`` is canonical, ``?from=`` the fallback.

    **Both spellings of the query fallback are accepted** — ``?from=`` and
    ``?from_seq=``. They were not always: this docstring advertised ``?from=``
    while FastAPI bound only ``from_seq`` (``from`` is a Python keyword, and no
    alias was declared). A client following the documentation was silently
    ignored and resumed from **0** — which looks like success until a clinician
    sees a duplicated prefix. Found by TASK-818 Lane E-stream.

    ``?from=`` exists because header-stripping proxies are real and
    ``Last-Event-ID`` does not survive a page reload — the SSE spec gives each new
    ``EventSource`` an empty buffer, so a client that persisted its cursor needs a
    way to hand it back.

    An id this function cannot parse resolves to **0**, replaying the generation
    from the beginning. That direction is deliberate: replaying costs the client a
    duplicate it can discard by sequence, whereas guessing "start from now" would
    silently lose the very tokens this design exists to protect.
    """
    if last_event_id:
        candidate = last_event_id
        prefix = f"{generation_id}:"
        if candidate.startswith(prefix):
            candidate = candidate[len(prefix) :]
        elif ":" in candidate:
            candidate = candidate.rsplit(":", 1)[1]
        try:
            return max(0, int(candidate))
        except ValueError:
            return 0
    if from_seq is not None:
        return max(0, from_seq)
    return 0


def _frame(generation_id: str, event: GenerationEvent) -> dict[str, str]:
    """One SSE frame. ``id: {generation_id}:{seq}`` per §3C.3(4)."""
    return {
        "event": event.event,
        "data": event.payload,
        "id": f"{generation_id}:{event.seq}",
    }


async def stream_generation(
    hub: GenerationHub,
    task_manager: TaskManager,
    generation_id: str,
    after_seq: int,
) -> AsyncIterator[dict[str, str]]:
    """Replay from ``after_seq``, then tail. No gap, no duplicate (AC-15).

    Ordering is what makes it gapless:

    1. **Attach first.** Anything published from now on is queued for us.
    2. **Then read the backlog** — the durable prefix from Redis, plus whatever
       the producer's ring still holds (which covers deltas delivered but not yet
       flushed, the dual-write race §3C.3(5) calls out).
    3. **Then drain the queue**, discarding anything at or below the high-water
       mark the backlog already reached.

    Backlog and ring overlap by construction; :func:`dedupe_by_seq` makes the
    overlap harmless. Doing step 2 before step 1 would lose whatever arrived
    between them.
    """
    producer = hub.get(generation_id)

    # The client must be able to persist the id BEFORE any token arrives (§3C.3(4)),
    # so it can reconnect to a generation it has not yet seen output from.
    yield {
        "event": "meta",
        "data": f'{{"generation_id":"{generation_id}"}}',
        "id": f"{generation_id}:{after_seq}",
    }

    if producer is None:
        # Nothing live here — a finished generation, or one whose producer is on
        # another pod. Either way the durable buffer is the whole story.
        backlog, _ = dedupe_by_seq(await task_manager.read_events(generation_id), after_seq)
        for event in backlog:
            yield _frame(generation_id, event)
            if event.is_terminal:
                # The reader's contract is "stops at the first done/error", and
                # it has to hold on the replay path too — otherwise a stream
                # that errored and then wrote more would deliver, on reconnect,
                # content the live subscriber never saw.
                return
        return

    subscriber, ring_replay = producer.attach(after_seq)
    try:
        backlog = await task_manager.read_events(generation_id, after_seq)
        replay, cursor = dedupe_by_seq([*backlog, *ring_replay], after_seq)
        for event in replay:
            yield _frame(generation_id, event)
            if event.is_terminal:
                return

        while True:
            live = await subscriber.queue.get()
            if live is None:
                # The producer finished while we were attached and had nothing
                # further to send us — it already emitted its terminal frame, or
                # it died without one.
                return
            if live.seq <= cursor:
                continue
            cursor = live.seq
            yield _frame(generation_id, live)
            if live.is_terminal:
                return
    finally:
        producer.detach(subscriber)


async def _subscribe(
    request: Request,
    generation_id: str,
    last_event_id: str | None,
    from_seq: int | None,
    task_manager: TaskManager,
    *,
    unknown_status: int,
) -> Response:
    hub = get_generation_hub(request.app)
    after_seq = parse_cursor(
        generation_id,
        last_event_id or request.headers.get("last-event-id"),
        from_seq,
    )

    if generation_id not in hub and not await _known(task_manager, generation_id):
        if unknown_status == 404:
            raise HTTPException(status_code=404, detail=f"Task '{generation_id}' not found")
        return Response(status_code=unknown_status)

    # W3C Trace Context Level 2 `traceresponse`. SSE is one-way once open, so
    # this header is the ONLY point at which the server can tell the caller which
    # trace served the stream. It carries the SERVER's ids, which the caller
    # already sent us or can already see — no new information crosses the
    # boundary, and nothing here is PHI.
    headers = dict(_SSE_HEADERS)
    carrier = inject_trace_carrier()
    if carrier.get("traceparent"):
        headers["traceresponse"] = carrier["traceparent"]
        headers["Access-Control-Expose-Headers"] = "traceresponse"

    return EventSourceResponse(
        stream_generation(hub, task_manager, generation_id, after_seq),
        headers=headers,
        ping=_PING_SECONDS,
    )


async def _known(task_manager: TaskManager, generation_id: str) -> bool:
    """Whether anything at all is known about this id.

    Task state OR a replay buffer counts: a generation whose task record has
    aged out but whose buffer survives is still replayable, and vice versa.
    """
    if await task_manager.get_task(generation_id) is not None:
        return True
    return await task_manager.stream_exists(generation_id)


@router.get("/generations/{generation_id}/stream")
async def stream_generation_events(
    generation_id: str,
    request: Request,
    last_event_id: str | None = None,
    from_seq: int | None = Query(
        None,
        validation_alias=AliasChoices("from", "from_seq"),
        description="Resume cursor as a sequence number. Accepts `from` or `from_seq`.",
    ),
    task_manager: TaskManager = Depends(get_task_manager),
) -> Response:
    """Resume an in-flight or finished generation from a sequence cursor.

    Unknown id → **204**: there is genuinely nothing to stream, and a 404 would
    invite a client to treat a completed-and-expired generation as an error.
    """
    return await _subscribe(
        request,
        generation_id,
        last_event_id,
        from_seq,
        task_manager,
        unknown_status=204,
    )


@router.get("/tasks/{task_id}/stream")
async def stream_task(
    task_id: str,
    request: Request,
    last_event_id: str | None = None,
    from_seq: int | None = Query(
        None,
        validation_alias=AliasChoices("from", "from_seq"),
        description="Resume cursor as a sequence number. Accepts `from` or `from_seq`.",
    ),
    task_manager: TaskManager = Depends(get_task_manager),
) -> Response:
    """The same stream under its pre-split name.

    Retained because the gateway still issues the two-call flow (``POST
    /generate`` → ``GET /tasks/{id}/stream``); migrating it is Lane E's. It keeps
    that flow's **404** for an unknown id rather than adopting the resume
    endpoint's 204, so no existing caller's error handling changes.
    """
    return await _subscribe(
        request,
        task_id,
        last_event_id,
        from_seq,
        task_manager,
        unknown_status=404,
    )
