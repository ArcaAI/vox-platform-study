"""Per-session STT engine-switch controller (TASK-567 §3.4).

Owns the one-way ``primary → fallback`` transition for a single streaming
session: classification of per-utterance inference failures, the
consecutive-failure threshold, the auto/manual triggers, and the observable
``provider_switched`` publication + Prometheus counter.

The class carries NO Redis/model-cache imports: the manager injects three
callables (build the fallback ASR callable, swap the reference the inference
loop reads, publish the switch status), so the transition logic is unit-testable
in isolation with fakes. Selection is FAIL-CLOSED — a fallback that cannot be
built raises rather than silently substituting an engine the tenant did not
configure; the session stays on the primary.
"""

from __future__ import annotations

import asyncio
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


class EngineSwitchController:
    """One-way ``primary → fallback`` engine switch for a single session."""

    def __init__(
        self,
        *,
        session_id: str,
        tenant_id: str | None,
        primary_pipeline_id: str,
        fallback_pipeline_id: str | None,
        build_fallback: Callable[[], Awaitable[Any]],
        apply_callable: Callable[[Any], None],
        publish_switch: Callable[[str, str, str, int | None], Awaitable[None]],
        auto_switch_enabled: bool = True,
        consecutive_failure_threshold: int = 2,
    ) -> None:
        self._session_id = session_id
        self._tenant_id = tenant_id
        self._primary_pipeline_id = primary_pipeline_id
        self._fallback_pipeline_id = fallback_pipeline_id
        self._build_fallback = build_fallback
        self._apply_callable = apply_callable
        self._publish_switch = publish_switch
        self._auto_switch_enabled = auto_switch_enabled
        self._threshold = max(1, int(consecutive_failure_threshold))
        self._consecutive_failures = 0
        self._active = "primary"
        # Serializes the transition so a manual switch racing an auto switch
        # cannot both run the swap.
        self._lock = asyncio.Lock()

    @property
    def active_engine(self) -> str:
        """``'primary'`` or ``'fallback'``."""
        return self._active

    @property
    def switched(self) -> bool:
        return self._active == "fallback"

    @property
    def has_fallback(self) -> bool:
        return bool(self._fallback_pipeline_id)

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

        No-ops (returns False) when auto-switch is disabled, no fallback is
        configured, or the session already switched.
        """
        if not self._auto_switch_enabled or self.switched or not self.has_fallback:
            return False
        kind = self._classify(exc)
        if kind == "immediate":
            return await self._switch(REASON_AUTO, utterance_index)
        if kind == "threshold":
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._threshold:
                return await self._switch(REASON_AUTO, utterance_index)
        return False

    async def switch_manual(self, *, utterance_index: int | None = None) -> bool:
        """User-initiated switch (R4). Honors one-way + fallback-required; ignores
        the auto-switch toggle (a manual request is an explicit user choice)."""
        return await self._switch(REASON_USER, utterance_index)

    async def note_switched_at_create(self, *, utterance_index: int | None = None) -> None:
        """Record a create-time switch: the session opened directly on the
        fallback because the primary ASR load failed at ``create_session``. The
        fallback callable is already installed by the manager, so this only flips
        state and emits the observable event + metric (reason ``auto``)."""
        async with self._lock:
            if self.switched:
                return
            self._finalize_switch_state()
            await self._emit_switch(REASON_AUTO, utterance_index)

    async def _switch(self, reason: str, utterance_index: int | None) -> bool:
        async with self._lock:
            if self.switched:
                return False  # one-way per session — no flapping
            if not self.has_fallback:
                return False
            # Selection is fail-closed: propagate a build failure rather than
            # pretend a switch happened. The session stays alive on the primary.
            new_callable = await self._build_fallback()
            self._apply_callable(new_callable)
            self._finalize_switch_state()
            await self._emit_switch(reason, utterance_index)
            return True

    def _finalize_switch_state(self) -> None:
        self._active = "fallback"
        self._consecutive_failures = 0

    async def _emit_switch(self, reason: str, utterance_index: int | None) -> None:
        try:
            STT_PROVIDER_SWITCH_TOTAL.labels(
                **{
                    "tenant": self._tenant_id or "unknown",
                    "from": self._primary_pipeline_id,
                    "to": self._fallback_pipeline_id or "",
                    "reason": reason,
                }
            ).inc()
        except Exception:  # noqa: BLE001 — metrics must never break the swap
            pass
        await self._publish_switch(
            self._primary_pipeline_id,
            self._fallback_pipeline_id or "",
            reason,
            utterance_index,
        )
        logger.info(
            "stt.provider_switched",
            session_id=self._session_id,
            from_pipeline=self._primary_pipeline_id,
            to_pipeline=self._fallback_pipeline_id,
            reason=reason,
            utterance_index=utterance_index,
        )
