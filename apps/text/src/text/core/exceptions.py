"""Centralized exception hierarchy for Text."""

from __future__ import annotations

from typing import Any

# A stdlib-only leaf module: the frozen notice vocabulary (TASK-1050).
from text.services.guardrail_notices import (
    EGRESS_REDACTION_UNAVAILABLE,
    GUARDRAIL_BLOCKED_PROBLEM_TYPE,
    GUARDRAIL_BLOCKED_TITLE,
)


class TextError(Exception):
    """Base exception for Text."""

    def __init__(self, message: str, *, error_code: str = "INTERNAL_ERROR"):
        self.message = message
        self.error_code = error_code
        super().__init__(message)


class ProviderError(TextError):
    """Error from an LLM provider."""

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="PROVIDER_ERROR")


class ProviderUnavailableError(ProviderError):
    """The provider's backing engine could not be made ready (e.g. a model load failed).

    Mapped to 503, unlike the plain ``ProviderError`` (502: the engine WAS reached and
    answered badly) — here the request was never sent to it.
    """


class ProviderTimeoutError(ProviderError):
    """Provider call timed out."""

    def __init__(self, message: str = "Request timed out", *, provider: str = "unknown"):
        super().__init__(message, provider=provider)
        self.error_code = "PROVIDER_TIMEOUT"


class RateLimitError(TextError):
    """Rate limit exceeded.

    ``remaining`` is the RFC 9239-style budget left in the current window, surfaced
    as RateLimit-Remaining ( It is None when the limiter
    cannot say — and ``None`` must NOT be reported as ``0``: a confident zero tells
    a client to stop sending, which is a different instruction from "unknown".
    """

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        *,
        retry_after: float | None = None,
        remaining: int | None = None,
    ):
        self.retry_after = retry_after
        self.remaining = remaining
        super().__init__(message, error_code="RATE_LIMITED")


class InputValidationError(TextError):
    """Input validation failed."""

    def __init__(self, message: str):
        super().__init__(message, error_code="VALIDATION_ERROR")


class ModelNotSelectedError(InputValidationError):
    """No model resolved for a cloud-provider generation request.

    Text is a stateless gateway (see ``core/config.py``): the gateway resolves
    the tenant/task model (the task's ``Agent``, or ``AiRoutingPolicy`` for the
    non-agent tasks) and injects it on every request.
    Provider/model SELECTION is ``failMode=closed`` (Configuration Tiers,
    ``09-infrastructure-devops.md``) — a cloud provider adapter must never
    substitute an env-configured vendor model when the caller omits one, so a
    missing model raises here instead of silently picking e.g. ``gpt-4o-mini``.
    """

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message)
        self.error_code = "MODEL_NOT_SELECTED"


class VisionNotSupportedError(InputValidationError):
    """An image content part was supplied but the provider has no multimodal
    wire capability (today: llama.cpp's raw ``/completion``
    endpoint has no chat/image concept).

    Fails closed rather than silently dropping the image and degrading to a
    text-only call: a caller that picked a text-only engine for a vision
    request must find out, not get a quietly wrong answer.
    """

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message)
        self.error_code = "VISION_NOT_SUPPORTED"


class ProviderCredentialsError(TextError):
    """No usable credential for a cloud provider generation request.

    cloud providers (Azure OpenAI / OpenAI / Anthropic) are BYOK — the
    credential arrives per request as a gateway-injected ``ProviderOverride``
    (tenant → SYSTEM cascade), never from an env fallback. When neither a request
    override nor a configured platform key is present, the adapter raises this
    rather than building a client with an empty key (which would 401 downstream).

    Distinct from ``ProviderError`` (the provider WAS reached and failed) — here no
    client is ever built. Mapped to 503 (a platform-config gap, retryable once an
    admin configures the connection), NOT 422 like ``ModelNotSelectedError`` (a
    caller-input problem).
    """

    def __init__(
        self,
        message: str = "Provider credentials not configured",
        *,
        provider: str = "unknown",
    ):
        self.provider = provider
        super().__init__(message, error_code="PROVIDER_CREDENTIALS_MISSING")


class ProviderConnectionMissingError(ProviderCredentialsError):
    """No ``AiProviderConnection`` resolved for this request's provider.

    The sibling of a missing CREDENTIAL: here nothing at all was injected, so the
    adapter does not even know where to connect. A subclass rather than a peer
    because both are the same operational fact from the caller's side — a
    platform-configuration gap, retryable the moment an admin seeds the row — and
    both must map to the same 503 ``PROVIDER_CREDENTIALS_MISSING`` contract that
    `apps/api` and the SDK already handle.

    Raised by `core/connection.py`. Since lane B this is also the posture
    for SELF-HOSTED engines: `apps/text` no longer carries a
    ``TEXT_<PROVIDER>_BASE_URL`` to fall back to, because a process-wide endpoint
    is one no tenant can override.
    """

    def __init__(
        self,
        message: str = "Provider connection not configured",
        *,
        provider: str = "unknown",
    ):
        super().__init__(message, provider=provider)


class CircuitOpenError(TextError):
    """Circuit breaker is open for the requested provider."""

    def __init__(
        self, message: str = "Service temporarily unavailable", *, provider: str = "unknown"
    ):
        self.provider = provider
        super().__init__(message, error_code="CIRCUIT_OPEN")


class QueueFullError(TextError):
    """Provider queue is at capacity."""

    def __init__(self, message: str = "Queue is full", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="QUEUE_FULL")


class QueueTimeoutError(TextError):
    """Timed out waiting in provider queue."""

    def __init__(self, message: str = "Queue wait timed out", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="QUEUE_TIMEOUT")


class ShutdownError(TextError):
    """Service is shutting down."""

    def __init__(self, message: str = "Service is shutting down"):
        super().__init__(message, error_code="SHUTTING_DOWN")


class ConcurrencyLimitError(TextError):
    """Too many concurrent requests."""

    def __init__(self, message: str = "Too many concurrent requests", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="CONCURRENCY_LIMIT")


class ContentBlockedError(TextError):
    """Content blocked by guardrails.

    ``error_code`` defaults to the generic ``CONTENT_BLOCKED`` token. The input
    gate's medical-relevance check (``services/egress.run_inbound_gate``)
    raises this with ``error_code="CONTENT_BLOCKED_NOT_MEDICAL"`` when the
    verdict says so explicitly (``is_medical: False``) — TASK-969 WS-3's closed,
    non-PHI vocabulary. ``message`` must always be a FIXED sentence: guardrail's
    own free-text ``reason``/``reasoning`` can quote the prompt and must never be
    interpolated into it.

    TASK-1050: a block guardrail decided carries its ``GuardrailNotice`` and the
    evaluation ids; the 422 body then adds them under the frozen names
    (``guardrailNotice`` / ``guardrailEvaluationIds``) with
    ``type: urn:hope:problem:guardrail-blocked`` — inside the house envelope, which
    keeps ``detail`` and ``error_code`` for old clients (the gateway's envelope
    refuses RFC 9457, so this is deliberately not ``application/problem+json``).
    """

    def __init__(
        self,
        message: str = "Content blocked by safety filter",
        *,
        error_code: str = "CONTENT_BLOCKED",
        guardrail_notice: dict[str, Any] | None = None,
        guardrail_evaluation_ids: list[str] | None = None,
    ):
        super().__init__(message, error_code=error_code)
        self.guardrail_notice = guardrail_notice
        self.guardrail_evaluation_ids = list(guardrail_evaluation_ids or [])

    @property
    def extra_body(self) -> dict[str, Any] | None:
        """What the 422 body adds to ``{detail, error_code}``; ``None`` without a notice."""
        if self.guardrail_notice is None:
            return None
        return {
            "type": GUARDRAIL_BLOCKED_PROBLEM_TYPE,
            "title": GUARDRAIL_BLOCKED_TITLE,
            "status": 422,
            "guardrailNotice": self.guardrail_notice,
            "guardrailEvaluationIds": self.guardrail_evaluation_ids,
        }


class GuardrailUnavailableError(TextError):
    """Guardrail is unreachable, or its retry budget is exhausted (TASK-969 WS-3).

    Distinct from ``ContentBlockedError``: no verdict was ever reached, so this
    is a retryable platform-availability gap (503), never a content judgement.
    Both gate halves — the input gate's ``services/egress.run_inbound_gate`` and the output
    gate's ``services/output_gate.OutputRejectedError.as_text_error`` — raise
    this identically; generation never runs while it is in flight.
    """

    def __init__(self, message: str = "The safety guardrail is temporarily unavailable."):
        super().__init__(message, error_code="GUARDRAIL_UNAVAILABLE")


class EgressRedactionUnavailableError(GuardrailUnavailableError):
    """A CLOUD call could not get its PII spans, so it is refused (TASK-1050 §9.8.1).

    The one guardrail failure that stays fail-CLOSED, because it is privacy, not a
    safety verdict: without the inbound screen's spans the cloud pseudonymiser would
    send identifiers it never saw, so the text is never sent. A distinct, retryable
    503 whose ``error_code`` is also the consultation's processing reason (a
    resumable hold, never a lost run); the body carries the
    ``guardrail.blocked.redaction_unavailable`` notice. A ``GuardrailUnavailableError``
    (the screen WAS unavailable) with its own code, so every existing handler of an
    unavailable guardrail still catches it.
    """

    def __init__(
        self,
        *,
        guardrail_notice: dict[str, Any],
        guardrail_evaluation_ids: list[str] | None = None,
    ) -> None:
        TextError.__init__(
            self,
            "Patient details could not be protected before sending to an external model.",
            error_code=EGRESS_REDACTION_UNAVAILABLE,
        )
        self.guardrail_notice = guardrail_notice
        self.guardrail_evaluation_ids = list(guardrail_evaluation_ids or [])

    @property
    def extra_body(self) -> dict[str, Any]:
        return {
            "processing_reason": EGRESS_REDACTION_UNAVAILABLE,
            "retryable": True,
            "guardrailNotice": self.guardrail_notice,
            "guardrailEvaluationIds": self.guardrail_evaluation_ids,
        }


class JudgeProviderNotLocalError(TextError):
    """The internal judge lane was asked to run on a CLOUD provider (TASK-1035).

    The medical judge sees the UNREDACTED prompt — it sits outside the egress
    pipeline to avoid the ``text -> guardrail -> text`` cycle — so it may only run
    on a local model. A 503: the fix is a routing-policy change, not a retry.
    """

    def __init__(self, provider: str) -> None:
        super().__init__(
            f"The judge lane runs on local providers only; '{provider}' resolves to cloud.",
            error_code="JUDGE_PROVIDER_NOT_LOCAL",
        )
        self.provider = provider


class ProviderNotFoundError(TextError):
    """Requested provider is not registered."""

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="PROVIDER_NOT_FOUND")


class PoolUnhealthyError(TextError):
    """Requested provider pool is known-unhealthy and no usable fallback was supplied.

    Raised by services/pool_router.resolve_pool_route when the
    last recorded ``health_check()`` result (``services/pool_health.PoolHealthTracker``)
    for the requested provider is ``False`` and the caller declared no fallback (or the
    declared fallback is not actually registered). Distinct from
    ``ProviderNotFoundError`` (the name isn't registered at all) and from
    ``ProviderCredentialsError`` (a config gap) — here the provider IS registered but a
    prior health check marked it down, and design.md's worker-pool standard requires
    degrading routing away from it rather than queueing into a dead engine.
    """

    def __init__(
        self,
        message: str = "Provider pool is unhealthy",
        *,
        provider: str = "unknown",
    ):
        self.provider = provider
        super().__init__(message, error_code="POOL_UNHEALTHY")
