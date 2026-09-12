"""Per-session engine-time accounting for the `transcribe.stream` usage ledger.

A streaming session can change ASR engines mid-flight — automatically, one-way,
when the primary fails a classified outage check, or manually and bidirectionally
when a clinician asks (``EngineSwitchController``). Fallback to the platform
default is a platform HA capability that is ON by default, and it must be
METERED: ten minutes on the tenant's BYO primary followed by five on the platform
fallback is ``10 min BYOK + 5 min CLOUD``. Billing the whole session to one tier
is wrong in both directions — to the tenant if the session ends on its own
engine, to the platform's COGS if it ends on the fallback.

This module owns only the ACCOUNTING. It never decides funding: the caller
injects a ``resolve`` callable (in practice
``stt.transcription.batch_service.resolve_usage_attribution`` bound to the
session's ``provider_overrides``), which derives
``(engine, deployment, connection_id)`` from the credential row that actually
served — funding is derived, never stamped.

Two properties the rest of the system depends on:

* **Aggregation is by ``(engine, deployment, connection_id)``, not by span.** A
  session that toggles primary → fallback → primary bills TWO rows, not three; the
  interleaving stays observable through the ``provider_switched`` result frames
  and ``stt_provider_switch_total``. TASK-958 added the connection to that key
  because a tenant with two accounts of one vendor has two engines with ONE name,
  and billing them as one row is the thing this module exists to prevent.
  That bound used to be approximate and is no longer (TASK-958 G3): a span now
  RECORDS the ``(connection_key, connection_id)`` of the engine that serves it, at
  the moment it is loaded or switched in, so two CONNECTIONS of one vendor — same
  ASR format, different account — are two spans and two rows. Before, a span was
  identified by its format alone and every span took the connection the session
  manager had stamped LAST, which re-labelled a platform-funded primary leg with
  the tenant sibling a failover happened to end on: the funding flips with it,
  because the override entry is read under the declared key.

* **Segments are anchored to the session totals.** Every span but the last takes
  its measured delta (clamped into what is left); the last takes the remainder.
  So ``sum(segments.audio_seconds) == total_audio_seconds`` and
  ``sum(segments.session_seconds) == total_session_seconds`` hold exactly, and no
  arithmetic gap can open between the teardown summary's own scalars and the rows
  actually billed against them. TASK-959 puts ``processing_seconds`` on the same
  footing.

TASK-959 adds the COMPUTE and NETWORK halves of the same question. The caller
snapshots the session inference worker's cumulative counters
(``EngineUsageCounters``) at every span boundary, so:

* a fallback leg carries its own ASR seconds — the number that becomes a
  ``GPU_SECOND`` or ``CPU_SECOND`` row — instead of the whole session's compute
  landing on whichever engine finished;
* bytes land on the engine that moved them, and a self-hosted span reports
  ``None`` rather than a measured-looking zero, because it made no third-party
  call at all;
* ``device`` is resolved per SEGMENT: a cloud leg bills ``cpu`` (what it occupied
  HERE is this service waiting on the vendor) even when the self-hosted leg of
  the same session bills a real accelerator.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from stt.core.metering import DEVICE_CPU


@dataclass(frozen=True)
class EngineUsageCounters:
    """A snapshot of the session inference worker's cumulative metering counters.

    TASK-959. All four come off ``StreamingInferenceWorker``, which accumulates
    them monotonically across every utterance of the session, so the caller takes
    a snapshot at each span boundary and the accumulator bills the DIFFERENCE.
    ``byte_source`` is not a counter but a label — only the engine currently live
    writes it, so the value observed while a span was open is that span's.
    """

    processing_seconds: float = 0.0
    request_bytes: int = 0
    response_bytes: int = 0
    byte_source: str | None = None


@dataclass(frozen=True)
class UsageSegment:
    """One engine's total time in a session, ready to become one ledger row."""

    engine: str
    deployment: str
    audio_seconds: float
    session_seconds: float
    #: TASK-958 — the ``AiProviderConnection`` that served this stretch. ``None`` when
    #: the sender stamped none; never guessed from ``engine``, which a tenant's two
    #: accounts of one vendor share.
    connection_id: str | None = None
    #: TASK-959 — ASR-only seconds spent on THIS engine. Becomes a ``GPU_SECOND``
    #: or ``CPU_SECOND`` row depending on ``device``.
    processing_seconds: float = 0.0
    #: ``cuda`` | ``mps`` | ``cpu``. Resolved per segment, not per session: a cloud
    #: leg occupied this service's CPU, whatever the host's accelerator is.
    device: str = DEVICE_CPU
    #: Bytes this engine moved to/from a third party. ``None`` — never ``0`` — on a
    #: self-hosted engine, which made no such call; "measured zero" and "never
    #: applicable" are different facts and the ledger must not conflate them.
    request_bytes: int | None = None
    response_bytes: int | None = None
    #: ``wire`` (real HTTP) or ``app`` (an application-level proxy). ``None``
    #: alongside null byte counts.
    byte_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "engine": self.engine,
            "deployment": self.deployment,
            "audio_seconds": self.audio_seconds,
            "session_seconds": self.session_seconds,
            "connection_id": self.connection_id,
            "processing_seconds": self.processing_seconds,
            "device": self.device,
            "request_bytes": self.request_bytes,
            "response_bytes": self.response_bytes,
            "byte_source": self.byte_source,
        }


@dataclass
class _Span:
    """One continuous stretch of a session served by a single ASR engine."""

    asr_format: Any
    audio_start: float
    wall_start: float
    audio_end: float | None = None
    wall_end: float | None = None
    #: TASK-959 — the worker's cumulative counters when this span opened, and when
    #: it closed (``None`` while it is still the live span). The span's own usage
    #: is the difference.
    counters_start: EngineUsageCounters = EngineUsageCounters()
    counters_end: EngineUsageCounters | None = None
    #: TASK-958 G3 — the ``(connection_key, connection_id)`` of the engine serving
    #: this span, anchored exactly like the counters above: recorded when the span
    #: opens, never re-read afterwards. ``None`` means this span recorded none (a
    #: caller that predates the field); the resolver is handed that ``None`` and
    #: applies the session-level stamp instead. That is a FALLBACK, not a default —
    #: a recorded ``(None, None)`` is a real answer (an engine that authenticates as
    #: no connection at all) and must not be overwritten by the session's.
    connection: tuple[str | None, str | None] | None = None


def _anchor(raw: list[float], total: float) -> list[float]:
    """Distribute ``total`` over ``raw``'s shape so the result sums to it exactly.

    Every entry but the last takes its measured value, clamped to what remains
    (so a measurement that overruns the total can never push a later span
    negative); the last takes whatever is left. The clamp matters because the two
    clocks disagree by construction: spans are measured on a monotonic clock
    while ``session_seconds`` is a ``created_at``/``closed_at`` ISO diff that
    degrades to ``0.0`` when it cannot be parsed.
    """
    if not raw:
        return []
    out: list[float] = []
    remaining = max(0.0, total)
    for value in raw[:-1]:
        take = min(max(value, 0.0), remaining)
        out.append(take)
        remaining -= take
    out.append(max(0.0, remaining))
    return out


def segment_device(deployment: str, local_device: str | None) -> str:
    """The device a segment OCCUPIED — which decides its compute unit.

    A self-hosted engine ran on this process's own accelerator. A ``CLOUD`` or
    ``BYOK`` engine ran on the vendor's, and what the request occupied HERE is
    this service's CPU while it awaited the response — so it bills ``CPU_SECOND``
    even on a GPU host. Billing a cloud fallback leg a GPU second would charge
    our own card for someone else's inference.
    """
    if deployment == "SELF_HOSTED":
        return local_device or DEVICE_CPU
    return DEVICE_CPU


@dataclass
class _Totals:
    """One aggregation bucket while ``close`` folds spans into segments."""

    audio: float = 0.0
    wall: float = 0.0
    processing: float = 0.0
    request_bytes: int | None = None
    response_bytes: int | None = None
    byte_source: str | None = None

    def add_bytes(self, *, request: int, response: int, byte_source: str | None) -> None:
        """Fold one span's byte deltas in, keeping ``None`` distinct from ``0``.

        A span that reported no ``byte_source`` moved nothing over a third-party
        link — a self-hosted engine — and must leave the counters ``None``: the
        gateway reads a null as "no such call", and a zero as "a call that moved
        no bytes", which is a different (and, for a REST engine, impossible) fact.

        A span with no byte MOVEMENT is treated the same way, and that is the
        belt to the worker's braces: an HTTP request that transferred literally
        zero bytes does not exist, so a zero delta means this span made no call
        and any label reaching it is a leftover from an earlier engine.
        """
        if byte_source is None or (request <= 0 and response <= 0):
            return
        self.request_bytes = (self.request_bytes or 0) + max(0, request)
        self.response_bytes = (self.response_bytes or 0) + max(0, response)
        self.byte_source = byte_source


class EngineUsageAccumulator:
    """Records which engine served which stretch of a streaming session."""

    def __init__(
        self,
        asr_format: Any,
        *,
        audio_seconds: float = 0.0,
        counters: EngineUsageCounters = EngineUsageCounters(),
        connection: tuple[str | None, str | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self._spans: list[_Span] = [
            _Span(
                asr_format, audio_seconds, clock(), counters_start=counters, connection=connection
            )
        ]

    @property
    def active_format(self) -> Any:
        return self._spans[-1].asr_format

    def switch_to(
        self,
        asr_format: Any,
        *,
        audio_seconds: float,
        counters: EngineUsageCounters = EngineUsageCounters(),
        connection: tuple[str | None, str | None] | None = None,
    ) -> None:
        """Close the live span and open one on ``asr_format``.

        Called from the synchronous callable-swap body in
        ``SessionManager._make_switch_controller`` — the instant the live engine
        actually changes, and deliberately NOT when a fallback build merely
        starts: selection is fail-closed, so a build that raises leaves the
        session on the engine it already had and must not close its span.

        ``counters`` is the worker's cumulative snapshot AT the swap: it closes
        the outgoing span's compute/byte window and opens the incoming one's, so
        the fallback leg cannot inherit the primary's GPU seconds (TASK-959).

        ``connection`` is the same idea for MONEY (TASK-958 G3): the incoming
        engine's ``(connection_key, connection_id)``, taken at the swap, so the
        outgoing leg keeps the account it actually spent. It is why a switch
        between two connections of ONE vendor is a real boundary here even though
        ``asr_format`` does not change.
        """
        live = self._spans[-1]
        live.audio_end = audio_seconds
        live.wall_end = self._clock()
        live.counters_end = counters
        self._spans.append(
            _Span(
                asr_format,
                audio_seconds,
                live.wall_end,
                counters_start=counters,
                connection=connection,
            )
        )

    def close(
        self,
        *,
        audio_seconds: float,
        total_audio_seconds: float,
        total_session_seconds: float,
        resolve: Callable[
            [Any, tuple[str | None, str | None] | None], tuple[str, str, str | None] | None
        ],
        total_processing_seconds: float = 0.0,
        counters: EngineUsageCounters = EngineUsageCounters(),
        device: str | None = None,
    ) -> list[UsageSegment]:
        """The session's engine time, aggregated by ``(engine, deployment)``.

        Pure: the spans are not mutated, so a teardown summary built twice (a
        reaper push-back racing a late DELETE) yields identical segments and the
        idempotency keys derived from them line up.

        ``resolve`` is called once per span with that span's OWN
        ``(asr_format, connection)`` — the second argument being the
        ``(connection_key, connection_id)`` recorded when the span opened, or
        ``None`` when it recorded none. Attribution is therefore a property of the
        span, not of the session: the funding tier follows from the override entry
        under the span's own key, so a platform-funded leg stays ``CLOUD`` however
        the session ends (TASK-958 G3).

        A span whose format ``resolve`` cannot attribute is LEFT OUT rather than
        guessed, and a span with neither audio nor wall-clock time is dropped —
        a create-time fallback (the primary failed to LOAD) must not bill the
        primary for an engine that never ran.

        TASK-959 arguments:

        ``counters``
            The worker's cumulative snapshot at teardown, which closes the live
            span's compute/byte window.
        ``total_processing_seconds``
            The session's authoritative ASR-only total (the same number the
            teardown RTF metric reports). Span deltas are ANCHORED to it exactly
            as audio/session seconds are, so the rows can never sum to something
            other than the figure the summary itself declares.
        ``device``
            The session's own ASR device, already normalised. It is the device of
            the SELF-HOSTED segments; a cloud segment gets ``cpu``, because what
            it occupied here is this service waiting on the vendor. ``None``
            degrades to ``cpu`` — the cheaper unit, never nothing.

        Bytes are NOT anchored: unlike the two clocks, there is no independent
        total to reconcile against, so the per-span deltas of one monotonic
        counter are the whole truth and sum to the session's own by construction.
        """
        now = self._clock()
        raw_audio = [
            (span.audio_end if span.audio_end is not None else audio_seconds) - span.audio_start
            for span in self._spans
        ]
        raw_wall = [
            (span.wall_end if span.wall_end is not None else now) - span.wall_start
            for span in self._spans
        ]
        span_counters = [span.counters_end or counters for span in self._spans]
        raw_processing = [
            ended.processing_seconds - span.counters_start.processing_seconds
            for span, ended in zip(self._spans, span_counters, strict=True)
        ]
        audio = _anchor(raw_audio, total_audio_seconds)
        wall = _anchor(raw_wall, total_session_seconds)
        processing = _anchor(raw_processing, total_processing_seconds)

        # Insertion-ordered, so the FIRST engine to serve is the first segment —
        # which is what keeps the unchanged session idempotency key on it.
        totals: dict[tuple[str, str, str | None], _Totals] = {}
        for span, ended, span_audio, span_wall, span_processing in zip(
            self._spans, span_counters, audio, wall, processing, strict=True
        ):
            attribution = resolve(span.asr_format, span.connection)
            if attribution is None:
                continue
            bucket = totals.setdefault(attribution, _Totals())
            bucket.audio += span_audio
            bucket.wall += span_wall
            bucket.processing += span_processing
            bucket.add_bytes(
                request=ended.request_bytes - span.counters_start.request_bytes,
                response=ended.response_bytes - span.counters_start.response_bytes,
                byte_source=ended.byte_source,
            )

        return [
            UsageSegment(
                engine=engine,
                deployment=deployment,
                audio_seconds=bucket.audio,
                session_seconds=bucket.wall,
                connection_id=connection_id,
                processing_seconds=bucket.processing,
                device=segment_device(deployment, device),
                request_bytes=bucket.request_bytes,
                response_bytes=bucket.response_bytes,
                byte_source=bucket.byte_source,
            )
            for (engine, deployment, connection_id), bucket in totals.items()
            if bucket.audio > 0.0 or bucket.wall > 0.0
        ]
