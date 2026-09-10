"""Centralized exception hierarchy for Text."""

from __future__ import annotations


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
    """Content blocked by guardrails."""

    def __init__(self, message: str = "Content blocked by safety filter"):
        super().__init__(message, error_code="CONTENT_BLOCKED")


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
