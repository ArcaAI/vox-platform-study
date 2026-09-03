"""Per-session stateful aggregation — the actual defence against split payloads.

**Why overlap is not the answer (** An earlier draft recommended a
trailing overlap window. Prompt Overflow tested overlapping sliding-window
inspection directly and found only marginal improvement: overlap addresses
*contiguous* evidence straddling a boundary, and does nothing about *dispersed*
evidence — which is the actual attack. Keep a modest overlap for contiguity, but
the defence is here.

**What the aggregator tracks, and why it is three signals rather than one.**

``excess_risk``
    ``sum(max(0, score - noise_floor))``. Catches evidence that is CONCENTRATED
    but spread across non-adjacent windows. The floor is what stops a 60-minute
    benign encounter accumulating a score purely by being long.

``consecutive``
    Adjacent windows above the floor. The cheapest, fastest signal for a payload
    that simply spans two utterances.

``mean_score``
    **A deliberate addition to the formula, and the reason the
    dispersed-payload criterion is satisfiable at all.** specifies only the
    excess sum and the consecutive count, but 's own measurement is that
    detector confidence collapses 0.99 -> 0.03 as malicious density per window
    falls. When every window scores BELOW the floor, ``max(0, score - floor)`` is
    exactly zero for each of them and the excess sum is blind to the attack it
    was introduced to catch. The evidence cites is a length-invariant
    aggregate — "0.32 benign -> 0.628 flagged" is a mean, not a sum — so the mean
    is tracked as its own signal, gated behind a minimum window count so a single
    mildly-suspicious utterance is not an alert.

All four numbers are configuration resolved tenant -> SYSTEM, never literals: a
threshold calibrated on a general corpus is precisely what forbids, because
clinical text is not general text.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SessionRiskPolicy:
    """The four calibrated numbers. Resolved per tenant; none has a code default.

    Defaults are supplied by the declared policy table in `core/policy.py`, whose
    tuning keys are bounded and open-to-default — not by this dataclass, which
    exists only to carry already-resolved values.
    """

    #: theta — the per-window suspicion floor. Below it, a window is noise.
    noise_floor: float
    #: Theta_session — accumulated excess above the floor that trips the session.
    excess_risk_threshold: float
    #: Adjacent above-floor windows that trip the session.
    consecutive_limit: int
    #: The length-invariant session aggregate (see the module docstring).
    mean_score_threshold: float
    #: Windows required before the mean may fire — anti-alert-fatigue.
    min_windows_for_mean: int


class SessionRiskState:
    """Mutable per-session aggregation. Cheap enough to update on every window."""

    __slots__ = (
        "_policy",
        "excess_risk",
        "consecutive",
        "max_consecutive",
        "windows",
        "graded_windows",
        "_score_total",
    )

    def __init__(self, policy: SessionRiskPolicy) -> None:
        self._policy = policy
        self.excess_risk = 0.0
        self.consecutive = 0
        self.max_consecutive = 0
        self.windows = 0
        #: How many of `windows` carried a real per-label CONFIDENCE rather than
        # a 1/0 flag. The caller reports the calibration from this;
        #: the state only counts, because "which statistic is this" is a claim
        #: about the whole aggregate and belongs with the verdict.
        self.graded_windows = 0
        self._score_total = 0.0

    # -- observation --------------------------------------------------------

    def observe(self, window_score: float, *, graded: bool = False) -> None:
        """Fold one window's score into the session.

        `graded=False` (the default) means the score is CATEGORICAL — 1.0 or 0.0
        from a flagged/not-flagged decision. It is the default because a caller
        that has not thought about calibration must not accidentally claim its
        aggregate is a confidence mean.
        """
        score = float(window_score)
        self.windows += 1
        if graded:
            self.graded_windows += 1
        self._score_total += score
        if score > self._policy.noise_floor:
            self.excess_risk += score - self._policy.noise_floor
            self.consecutive += 1
            self.max_consecutive = max(self.max_consecutive, self.consecutive)
        else:
            self.consecutive = 0

    # -- verdict ------------------------------------------------------------

    @property
    def mean_score(self) -> float:
        return self._score_total / self.windows if self.windows else 0.0

    @property
    def fire_reasons(self) -> tuple[str, ...]:
        reasons: list[str] = []
        if self.excess_risk > self._policy.excess_risk_threshold:
            reasons.append("excess_risk")
        if self.max_consecutive >= self._policy.consecutive_limit:
            reasons.append("consecutive")
        if (
            self.windows >= self._policy.min_windows_for_mean
            and self.mean_score > self._policy.mean_score_threshold
        ):
            reasons.append("mean_score")
        return tuple(reasons)

    @property
    def fired(self) -> bool:
        return bool(self.fire_reasons)

    # -- audit --------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """PHI-free: the counters and the reasons. Never a window's content."""
        return {
            "excessRisk": round(self.excess_risk, 6),
            "meanScore": round(self.mean_score, 6),
            "windows": self.windows,
            "gradedWindows": self.graded_windows,
            "maxConsecutive": self.max_consecutive,
            "fired": self.fired,
            "fireReasons": list(self.fire_reasons),
        }

    # -- persistence (Redis round-trip) -------------------------------------

    def snapshot(self) -> dict[str, float]:
        return {
            "excess": self.excess_risk,
            "consecutive": float(self.consecutive),
            "maxConsecutive": float(self.max_consecutive),
            "windows": float(self.windows),
            "gradedWindows": float(self.graded_windows),
            "total": self._score_total,
        }

    @classmethod
    def restore(
        cls, policy: SessionRiskPolicy, snapshot: dict[str, Any] | None
    ) -> SessionRiskState:
        state = cls(policy)
        if snapshot:
            state.excess_risk = float(snapshot.get("excess", 0.0))
            state.consecutive = int(float(snapshot.get("consecutive", 0)))
            state.max_consecutive = int(float(snapshot.get("maxConsecutive", 0)))
            state.windows = int(float(snapshot.get("windows", 0)))
            state.graded_windows = int(float(snapshot.get("gradedWindows", 0)))
            state._score_total = float(snapshot.get("total", 0.0))
        return state
