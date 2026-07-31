"""Per-session STT engine-switch controller (TASK-567 §3.4, TASK-586).

Owns the engine transitions for a single streaming session: classification of
per-utterance inference failures, the consecutive-failure threshold, the auto/
manual triggers, and the observable ``provider_switched`` publication +
Prometheus counter.

Two transition policies live here and are deliberately asymmetric (TASK-586):

* **Automatic, failure-driven** (``record_failure``) is ONE-WAY
  ``primary → fallback``. A failing engine is never auto-selected again for the
  life of the session.
* **Manual, user-initiated** (``switch_manual``) is BIDIRECTIONAL — a clinician
  may switch to the fallback AND back to the primary — subject to a short
  cooldown that debounces rapid double-taps. It ignores the auto-switch toggle
  (an explicit user choice).

The class carries NO Redis/model-cache imports: the manager injects callables
(build the primary ASR callable, build the fallback ASR callable, swap the
reference the inference loop reads, publish the switch status), so the
transition logic is unit-testable in isolation with fakes. Selection is
FAIL-CLOSED — an engine that cannot be built raises rather than silently
substituting an engine the tenant did not configure; the session stays on the
currently-active engine.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

import structlog

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
    ModelError,
)
from stt.core.metrics import STT_PROVIDER_SWITCH_TOTAL

logger = structlog.get_logger(__name__)

# Failures that mandate an IMMEDIATE switch — retrying the same engine is
# pointless (a bad/absent key or an exhausted quota will not fix itself within
# the session).
_IMMEDIATE_SWITCH_ERRORS = (CloudASRAuthError, CloudASRQuotaError)
# Failures that switch only after a RUN of consecutive failures — a single
# transient blip should not abandon the primary engine.
_THRESHOLD_SWITCH_ERRORS = (CloudASRTranscriptionError, ModelError)

# Trigger reasons, published on the ``provider_switched`` status result.
REASON_AUTO = "auto"
REASON_USER = "user"

# Engine identifiers.
_PRIMARY = "primary"
_FALLBACK = "fallback"

# Default debounce between two consecutive user-initiated switches (seconds).
_DEFAULT_MANUAL_SWITCH_COOLDOWN_S = 1.5


class EngineSwitchController:
    """Per-session engine switch: one-way auto, bidirectional manual (TASK-586)."""

    def __init__(
        self,
        *,
        session_id: str,
        tenant_id: str | None,
        primary_pipeline_id: str,
        fallback_pipeline_id: str | None,
        build_fallback: Callable[[], Awaitable[Any]],
        apply_callable: Callable[[Any], None],
        publish_switch: Callable[[str, str, str, str, int | None], Awaitable[None]],
        build_primary: Callable[[], Awaitable[Any]] | None = None,
        auto_switch_enabled: bool = True,
        consecutive_failure_threshold: int = 2,
        manual_switch_cooldown_s: float = _DEFAULT_MANUAL_SWITCH_COOLDOWN_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session_id = session_id
        self._tenant_id = tenant_id
        self._primary_pipeline_id = primary_pipeline_id
        self._fallback_pipeline_id = fallback_pipeline_id
        self._build_fallback = build_fallback
        self._build_primary = build_primary
        self._apply_callable = apply_callable
        self._publish_switch = publish_switch
        self._auto_switch_enabled = auto_switch_enabled
        self._threshold = max(1, int(consecutive_failure_threshold))
        self._manual_cooldown_s = max(0.0, float(manual_switch_cooldown_s))
        self._clock = clock
        self._consecutive_failures = 0
        self._active = _PRIMARY
        # False once the session opened directly on the fallback because the
        # primary ASR never loaded at create — a switch BACK to primary is then
        # impossible (there is no primary engine to build).
        self._primary_available = True
        self._last_manual_switch_at: float | None = None
        # Serializes the transition so a manual switch racing an auto switch
        # cannot both run the swap.
        self._lock = asyncio.Lock()

    @property
    def active_engine(self) -> str:
        """``'primary'`` or ``'fallback'``."""
        return self._active

    @property
    def switched(self) -> bool:
        """True while the fallback engine is the live one."""
        return self._active == _FALLBACK

    @property
    def has_fallback(self) -> bool:
        return bool(self._fallback_pipeline_id)

    @property
    def can_switch_to_primary(self) -> bool:
        """True when a user switch back to the primary engine is possible: the
        primary loaded at create AND a primary builder is wired."""
        return self._primary_available and self._build_primary is not None

    @staticmethod
    def _classify(exc: BaseException) -> str:
        """Bucket a per-utterance failure: ``immediate``/``threshold``/``ignore``."""
        if isinstance(exc, _IMMEDIATE_SWITCH_ERRORS):
            return "immediate"
        if isinstance(exc, _THRESHOLD_SWITCH_ERRORS):
            return "threshold"
        return "ignore"

    def record_success(self) -> None:
        """A clean utterance resets the consecutive-failure run."""
        self._consecutive_failures = 0

    async def record_failure(
        self, exc: BaseException, *, utterance_index: int | None = None
    ) -> bool:
        """Register a failed utterance; return True if it triggered a switch.

        AUTO path — strictly one-way ``primary → fallback``. No-ops (returns
        False) when auto-switch is disabled, no fallback is configured, or the
        session is already on the fallback (a failing engine is never
        auto-selected again).
        """
        if not self._auto_switch_enabled or self.switched or not self.has_fallback:
            return False
        kind = self._classify(exc)
        if kind == "immediate":
            return await self._switch_to(_FALLBACK, REASON_AUTO, utterance_index)
        if kind == "threshold":
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._threshold:
                return await self._switch_to(_FALLBACK, REASON_AUTO, utterance_index)
        return False

    async def switch_manual(
        self, target: str = _FALLBACK, *, utterance_index: int | None = None
    ) -> bool:
        """User-initiated switch (R4, TASK-586). Bidirectional; ignores the
        auto-switch toggle (a manual request is an explicit user choice).

        ``target`` defaults to ``'fallback'`` for native-path back-compat.

        A manual switch arriving within ``manual_switch_cooldown_s`` of the
        previous SUCCESSFUL manual switch is rejected (returns False, does not
        raise) to debounce rapid double-taps. Returns False (no raise) when the
        target is unreachable — already active, no fallback configured, or the
        primary never loaded.
        """
        now = self._clock()
        if (
            self._last_manual_switch_at is not None
            and (now - self._last_manual_switch_at) < self._manual_cooldown_s
        ):
            logger.info(
                "stt.provider_switch_cooldown",
                session_id=self._session_id,
                target=target,
                since_last_s=round(now - self._last_manual_switch_at, 3),
            )
            return False
        switched = await self._switch_to(target, REASON_USER, utterance_index)
        if switched:
            self._last_manual_switch_at = now
        return switched

    async def note_switched_at_create(self, *, utterance_index: int | None = None) -> None:
        """Record a create-time switch: the session opened directly on the
        fallback because the primary ASR load failed at ``create_session``. The
        fallback callable is already installed by the manager, so this only flips
        state and emits the observable event + metric (reason ``auto``). The
        primary is marked unavailable — there is nothing to switch back to."""
        async with self._lock:
            if self.switched:
                return
            self._primary_available = False
            self._active = _FALLBACK
            self._consecutive_failures = 0
            await self._emit_switch(_FALLBACK, REASON_AUTO, utterance_index)

    async def _switch_to(
        self, target: str, reason: str, utterance_index: int | None
    ) -> bool:
        """Directional swap. Returns True iff the live engine changed."""
        async with self._lock:
            if target == self._active:
                return False  # already on the requested engine
            if target == _FALLBACK:
                if not self.has_fallback:
                    return False
                # Selection is fail-closed: propagate a build failure rather than
                # pretend a switch happened. The session stays on the primary.
                new_callable = await self._build_fallback()
            elif target == _PRIMARY:
                if not self.can_switch_to_primary:
                    return False
                assert self._build_primary is not None  # narrowed by can_switch_to_primary
                new_callable = await self._build_primary()
            else:
                return False
            self._apply_callable(new_callable)
            self._active = target
            self._consecutive_failures = 0
            await self._emit_switch(target, reason, utterance_index)
            return True

    async def _emit_switch(
        self, active: str, reason: str, utterance_index: int | None
    ) -> None:
        # from/to follow the direction of travel: to the fallback we go
        # primary→fallback; back to the primary we go fallback→primary.
        if active == _FALLBACK:
            from_pipeline = self._primary_pipeline_id
            to_pipeline = self._fallback_pipeline_id or ""
        else:
            from_pipeline = self._fallback_pipeline_id or ""
            to_pipeline = self._primary_pipeline_id
        try:
            STT_PROVIDER_SWITCH_TOTAL.labels(
                **{
                    "tenant": self._tenant_id or "unknown",
                    "from": from_pipeline,
                    "to": to_pipeline,
                    "reason": reason,
                }
            ).inc()
        except Exception:  # noqa: BLE001 — metrics must never break the swap
            pass
        await self._publish_switch(
            from_pipeline,
            to_pipeline,
            reason,
            active,
            utterance_index,
        )
        logger.info(
            "stt.provider_switched",
            session_id=self._session_id,
            from_pipeline=from_pipeline,
            to_pipeline=to_pipeline,
            reason=reason,
            active=active,
            utterance_index=utterance_index,
        )
