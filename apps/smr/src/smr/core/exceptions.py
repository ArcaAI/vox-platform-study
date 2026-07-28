"""Centralized exception hierarchy for SMR."""

from __future__ import annotations


class SmrError(Exception):
    """Base exception for SMR."""

    def __init__(self, message: str, *, error_code: str = "INTERNAL_ERROR"):
        self.message = message
        self.error_code = error_code
        super().__init__(message)


class ProviderError(SmrError):
    """Error from an LLM provider."""

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="PROVIDER_ERROR")


class ProviderTimeoutError(ProviderError):
    """Provider call timed out."""

    def __init__(self, message: str = "Request timed out", *, provider: str = "unknown"):
        super().__init__(message, provider=provider)
        self.error_code = "PROVIDER_TIMEOUT"


class RateLimitError(SmrError):
    """Rate limit exceeded."""

    def __init__(self, message: str = "Rate limit exceeded", *, retry_after: float | None = None):
        self.retry_after = retry_after
        super().__init__(message, error_code="RATE_LIMITED")


class InputValidationError(SmrError):
    """Input validation failed."""

    def __init__(self, message: str):
        super().__init__(message, error_code="VALIDATION_ERROR")


class ModelNotSelectedError(InputValidationError):
    """No model resolved for a cloud-provider generation request.

    SMR is a stateless gateway (see ``core/config.py``): the gateway resolves
    the tenant/task model (``AiTaskDefault``) and injects it on every request.
    Provider/model SELECTION is ``failMode=closed`` (Configuration Tiers,
    ``09-infrastructure-devops.md``) — a cloud provider adapter must never
    substitute an env-configured vendor model when the caller omits one, so a
    missing model raises here instead of silently picking e.g. ``gpt-4o-mini``.
    """

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message)
        self.error_code = "MODEL_NOT_SELECTED"


class CircuitOpenError(SmrError):
    """Circuit breaker is open for the requested provider."""

    def __init__(self, message: str = "Service temporarily unavailable", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="CIRCUIT_OPEN")


class QueueFullError(SmrError):
    """Provider queue is at capacity."""

    def __init__(self, message: str = "Queue is full", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="QUEUE_FULL")


class QueueTimeoutError(SmrError):
    """Timed out waiting in provider queue."""

    def __init__(self, message: str = "Queue wait timed out", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="QUEUE_TIMEOUT")


class ShutdownError(SmrError):
    """Service is shutting down."""

    def __init__(self, message: str = "Service is shutting down"):
        super().__init__(message, error_code="SHUTTING_DOWN")


class ConcurrencyLimitError(SmrError):
    """Too many concurrent requests."""

    def __init__(self, message: str = "Too many concurrent requests", *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="CONCURRENCY_LIMIT")


class ContentBlockedError(SmrError):
    """Content blocked by guardrails."""

    def __init__(self, message: str = "Content blocked by safety filter"):
        super().__init__(message, error_code="CONTENT_BLOCKED")


class ProviderNotFoundError(SmrError):
    """Requested provider is not registered."""

    def __init__(self, message: str, *, provider: str = "unknown"):
        self.provider = provider
        super().__init__(message, error_code="PROVIDER_NOT_FOUND")
