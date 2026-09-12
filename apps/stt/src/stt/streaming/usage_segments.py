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
  Known bound on that key (TASK-958): a span is identified by its ASR FORMAT, so a
  session that switched between two CONNECTIONS of one engine — same format, different
  account — is one span and is attributed to the connection the session manager last
  stamped. Making it exact means giving a span its own connection identity, which is a
  change to ``switch_to`` and the engine-switch controller, not to this aggregation.

* **Segments are anchored to the session totals.** Every span but the last takes
  its measured delta (clamped into what is left); the last takes the remainder.
  So ``sum(segments.audio_seconds) == total_audio_seconds`` and
  ``sum(segments.session_seconds) == total_session_seconds`` hold exactly, and no
  arithmetic gap can open between the teardown summary's own scalars and the rows
  actually billed against them.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


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

    def to_dict(self) -> dict[str, Any]:
        return {
            "engine": self.engine,
            "deployment": self.deployment,
            "audio_seconds": self.audio_seconds,
            "session_seconds": self.session_seconds,
            "connection_id": self.connection_id,
        }


@dataclass
class _Span:
    """One continuous stretch of a session served by a single ASR engine."""

    asr_format: Any
    audio_start: float
    wall_start: float
    audio_end: float | None = None
    wall_end: float | None = None


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


class EngineUsageAccumulator:
    """Records which engine served which stretch of a streaming session."""

    def __init__(
        self,
        asr_format: Any,
        *,
        audio_seconds: float = 0.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self._spans: list[_Span] = [_Span(asr_format, audio_seconds, clock())]

    @property
    def active_format(self) -> Any:
        return self._spans[-1].asr_format

    def switch_to(self, asr_format: Any, *, audio_seconds: float) -> None:
        """Close the live span and open one on ``asr_format``.

        Called from the synchronous callable-swap body in
        ``SessionManager._make_switch_controller`` — the instant the live engine
        actually changes, and deliberately NOT when a fallback build merely
        starts: selection is fail-closed, so a build that raises leaves the
        session on the engine it already had and must not close its span.
        """
        live = self._spans[-1]
        live.audio_end = audio_seconds
        live.wall_end = self._clock()
        self._spans.append(_Span(asr_format, audio_seconds, live.wall_end))

    def close(
        self,
        *,
        audio_seconds: float,
        total_audio_seconds: float,
        total_session_seconds: float,
        resolve: Callable[[Any], tuple[str, str, str | None] | None],
    ) -> list[UsageSegment]:
        """The session's engine time, aggregated by ``(engine, deployment)``.

        Pure: the spans are not mutated, so a teardown summary built twice (a
        reaper push-back racing a late DELETE) yields identical segments and the
        idempotency keys derived from them line up.

        A span whose format ``resolve`` cannot attribute is LEFT OUT rather than
        guessed, and a span with neither audio nor wall-clock time is dropped —
        a create-time fallback (the primary failed to LOAD) must not bill the
        primary for an engine that never ran.
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
        audio = _anchor(raw_audio, total_audio_seconds)
        wall = _anchor(raw_wall, total_session_seconds)

        # Insertion-ordered, so the FIRST engine to serve is the first segment —
        # which is what keeps the unchanged session idempotency key on it.
        totals: dict[tuple[str, str, str | None], list[float]] = {}
        for span, span_audio, span_wall in zip(self._spans, audio, wall, strict=True):
            attribution = resolve(span.asr_format)
            if attribution is None:
                continue
            bucket = totals.setdefault(attribution, [0.0, 0.0])
            bucket[0] += span_audio
            bucket[1] += span_wall

        return [
            UsageSegment(
                engine=engine,
                deployment=deployment,
                audio_seconds=segment_audio,
                session_seconds=segment_wall,
                connection_id=connection_id,
            )
            for (engine, deployment, connection_id), (
                segment_audio,
                segment_wall,
            ) in totals.items()
            if segment_audio > 0.0 or segment_wall > 0.0
        ]
