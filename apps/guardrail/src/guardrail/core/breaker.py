"""One circuit breaker per peer, each carrying a DECLARED fail posture.

`.claude/rules/06-python-services.md`: a peer client carries *"a bounded retry, and
a **declared** fail posture (a moderation verdict may fail closed; a generated label
must raise, never be fabricated)"*. Guardrail's two peer clients had the bounded
retry but no breaker, so a dead peer cost `attempts × timeout` on EVERY request —
retrying is load amplification precisely when the peer can least take it.

**The posture is a constructor argument with no default.** It is the one property a
reader must not have to infer:

* :attr:`FailPosture.FAIL_CLOSED` — a moderation VERDICT. It has a safe default
  ("not allowed"), and guardrail's routes already map the resulting exception to a
  fail-closed 503 / per-element `undetermined`.
* :attr:`FailPosture.FAIL_OPEN_DEGRADED` — a check whose ABSENCE is itself an
  honest answer, and only where that answer is the conservative one. The
  groundedness gate is the sole instance: it degrades to `unverified`, never to
  `grounded`.

Neither posture ever produces `safe: true`. The breaker changes what a failure
COSTS, never what a failure MEANS.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from enum import Enum
from typing import Final, TypeVar

from guardrail.core.logging import get_logger
from guardrail.core.metrics import record_peer_failure, set_circuit_breaker_state

logger = get_logger(__name__)

T = TypeVar("T")

STATE_CLOSED: Final = "closed"
STATE_OPEN: Final = "open"
STATE_HALF_OPEN: Final = "half_open"

_STATE_CODE: Final[dict[str, int]] = {STATE_CLOSED: 0, STATE_HALF_OPEN: 1, STATE_OPEN: 2}


class FailPosture(Enum):
    """What a failure of the guarded peer MEANS. Declared, never inferred."""

    FAIL_CLOSED = "fail-closed"
    FAIL_OPEN_DEGRADED = "fail-open-degraded"


class BreakerOpenError(RuntimeError):
    """The circuit is open — the call was shed without touching the peer."""

    def __init__(self, name: str, posture: FailPosture) -> None:
        self.peer = name
        self.posture = posture
        super().__init__(
            f"circuit for peer {name!r} is OPEN (posture={posture.value}); "
            "shedding the call rather than amplifying load into an outage"
        )


class CircuitBreaker:
    """A minimal closed/open/half-open breaker around one peer."""

    def __init__(
        self,
        *,
        name: str,
        posture: FailPosture,
        failure_threshold: int = 5,
        recovery_timeout_s: float = 30.0,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self.posture = posture
        self.failure_threshold = max(1, failure_threshold)
        self.recovery_timeout_s = recovery_timeout_s
        self._time = time_func
        self._failures = 0
        self._opened_at = 0.0
        self._state = STATE_CLOSED
        # True while a half-open PROBE is in flight. Half-open is a question
        # asked of ONE caller ("is the peer back?"), so the rest are shed until
        # it answers — see `call`.
        self._probing = False
        self._lock = asyncio.Lock()
        set_circuit_breaker_state(self.name, _STATE_CODE[self._state])

    @property
    def state(self) -> str:
        """Current state, resolving an elapsed recovery window to ``half_open``."""
        if self._state == STATE_OPEN and (
            self._time() - self._opened_at >= self.recovery_timeout_s
        ):
            return STATE_HALF_OPEN
        return self._state

    def _transition(self, state: str) -> None:
        if state != self._state:
            logger.info(
                "guardrail.breaker.transition",
                peer=self.name,
                to=state,
                posture=self.posture.value,
            )
        self._state = state
        set_circuit_breaker_state(self.name, _STATE_CODE[state])

    async def call(self, fn: Callable[[], Awaitable[T]]) -> T:
        """Invoke ``fn`` under the breaker. Raises rather than substituting a result.

        A breaker NEVER manufactures a verdict — that is the caller's declared
        posture to apply, one layer up, where the verdict shape is known.

        **Half-open admits ONE probe.** It is a question asked of a single
        caller, so every other caller is shed while that probe is outstanding.
        Releasing the whole queue the instant the recovery window elapses aims a
        stampede at the peer least able to absorb it — and a peer that is merely
        COLD (`apps/nlp` loading a guard model) is exactly that peer.

        **A cancellation is not a verdict about the peer.** When the caller gives
        up — its own deadline, or an upstream disconnect — we learned nothing:
        the failure run does not move, no peer failure is recorded, and nothing
        transitions. What the abandoned probe MUST do is release its slot, or
        the breaker sits in half-open forever: never re-opening (no failure was
        reported) and never closing (no success was), waving every subsequent
        request through — a permanently open floodgate under precisely the
        pattern that produced it. A peer that genuinely refuses or errors still
        opens the circuit, and every path here still fails CLOSED.
        """
        current = self.state
        if current == STATE_OPEN:
            record_peer_failure(self.name, "circuit_open")
            raise BreakerOpenError(self.name, self.posture)

        probing = False
        if current == STATE_HALF_OPEN:
            if self._probing:
                record_peer_failure(self.name, "probe_in_flight")
                raise BreakerOpenError(self.name, self.posture)
            # No `await` between the read and the write, so this is atomic for
            # every coroutine on this loop.
            self._probing = probing = True
            self._transition(STATE_HALF_OPEN)

        try:
            result = await fn()
        except asyncio.CancelledError:
            # The CALLER gave up. Release the probe slot, count nothing.
            if probing:
                self._probing = False
            raise
        except Exception:
            async with self._lock:
                if probing:
                    self._probing = False
                if self._state == STATE_HALF_OPEN:
                    # A failed probe re-opens immediately: the recovery window
                    # restarts rather than granting another free attempt.
                    self._failures = self.failure_threshold
                    self._opened_at = self._time()
                    self._transition(STATE_OPEN)
                else:
                    self._failures += 1
                    if self._failures >= self.failure_threshold:
                        self._opened_at = self._time()
                        self._transition(STATE_OPEN)
            record_peer_failure(self.name, "error")
            raise

        async with self._lock:
            if probing:
                self._probing = False
            # A success resets the RUN, not a decayed count: an intermittent blip
            # must not accumulate into an open circuit over hours of healthy traffic.
            self._failures = 0
            self._transition(STATE_CLOSED)
        return result
