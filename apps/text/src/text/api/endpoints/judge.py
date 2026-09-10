"""Internal judge endpoint — LLM judgement for the safety plane.

``apps/guardrail`` owns policy (thresholds, criteria, taxonomy, verdict shape,
fail-closed posture) and delegates the actual LLM call here. That delegation must
not close the cycle the public path already has:

    PUBLIC   caller -> POST /generate -> guardrail gate (fail-closed) -> provider
    INTERNAL guardrail -> POST /generate/internal/judge -> provider

The judge lane is separated from the public lane along three axes, all
structural rather than conventional:

* **Route.** A distinct path, NOT a flag on the ``/generate`` body. The bypass
  cannot be reached by shaping a public request; it is reachable only by hitting
  a different URL, which the gateway does not proxy.
* **Gate.** This module names neither the guardrail client nor its dependency
  provider, and the handler runs inside ``judge_scope()`` so the shared gate
  helper (``endpoints/generate._apply_guardrail_gate``) raises
  ``GuardrailRecursionError`` if a future edit ever routes it here.
* **Resources.** Its own semaphore and circuit breaker per provider
  (``app.state.judge_semaphores`` / ``judge_circuit_breakers``, sized by
  `AiRuntimeProfile`, floored by `JUDGE_LANE_FLOOR`). A saturated user-facing
  pool cannot starve a judgement, and a wedged judgement cannot consume the
  user-facing budget. The judge lane also
  deliberately consults NO rate limiter and NO request queue: a tenant that has
  exhausted its own generation rate limit must not be able to throttle the
  safety plane, and queueing a call that is already on a user-facing request's
  critical path only converts a fast 503 into a slow one.

What the judge lane deliberately does NOT do: no task manager (a judgement has
no streaming/polling lifecycle), no idempotency cache (guardrail's verdict cache
sits in front of it), no retry loop (guardrail's client owns the retry budget and
its fail-closed verdict), and no shutdown rejection (a judge call only ever
serves an ALREADY-ADMITTED public generation — refusing it during drain would
fail that in-flight request closed for no benefit).

Metering: a judgement's tokens are safety-plane spend, not the tenant's
generation spend, and ride back to the billing plane on guardrail's verdict
rather than on the tenant's ``/generate`` response. ``cost_basis`` is DERIVED
from the funding tier of the credential that served the call (the same
``_used_byok_credential`` derivation the public path uses) and is never stamped
here.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

import structlog.contextvars
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

# The funding derivation and the stats coercion are imported, not re-implemented:
# a second copy of `_used_byok_credential` is exactly how a call site starts
# stamping its own attribution.
from text.api.endpoints.generate import _coerce_stats, _extract_usage, _used_byok_credential
from text.core.dependencies import (
    get_app_state,
    get_judge_circuit_breakers,
    get_judge_semaphores,
    get_provider_registry,
)
from text.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    ProviderCredentialsError,
)
from text.core.exceptions import (
    ProviderNotFoundError as DomainProviderNotFoundError,
)
from text.core.exceptions import (
    ProviderTimeoutError as DomainProviderTimeoutError,
)
from text.core.logging import get_logger
from text.core.runtime_defaults import LaneBudget
from text.models.requests import GenerateRequest, ProviderOverride, ResponseFormat, RetryConfig
from text.models.responses import ErrorResponse
from text.models.stats import GenerationStats, degraded_stats
from text.models.usage import UsageDetail, build_usage_detail, raw_usage_from_stats
from text.providers.base import ProviderNotFoundError, ProviderRegistry
from text.services.circuit_breaker import CircuitBreaker
from text.services.judge_guard import judge_scope
from text.services.resizable_semaphore import ResizableSemaphore
from text.services.runtime_limits import lane_budget

logger = get_logger(__name__)

router = APIRouter(tags=["judge"])


class JudgeRequest(BaseModel):
    """One judgement call, as the safety plane issues it.

    Deliberately its own model rather than a subclass of ``GenerateRequest``: the
    public request contract must be free to grow (streaming, fallback routing,
    multimodal parts, idempotency) without any of it silently appearing on an
    internal safety-plane wire.

    ``provider`` and ``model`` are both REQUIRED — selection is fail-closed
    across this service, and the caller (guardrail) has already resolved them
    from ``AiRoutingPolicy``, tenant row first.
    """

    prompt: str = Field(..., min_length=1, max_length=200_000)
    system_prompt: str | None = Field(default=None, max_length=50_000)
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    # Structured verdicts: guardrail pins a JSON schema so it parses a shape
    # rather than prose.
    response_format: ResponseFormat | None = None
    # Tenant BYO credential, gateway-resolved and forwarded VERBATIM by guardrail
    # (which never decrypts, stores or logs it). Honoured exactly as on the
    # public path — the adapters read it off the request.
    provider_overrides: dict[str, ProviderOverride] | None = None


class JudgeResponse(BaseModel):
    """The judgement, unparsed.

    ``text`` returns the model's raw output; INTERPRETING it (verdict, labels,
    thresholds, fail-closed defaults) is guardrail's job and stays there.
    """

    content: str
    reasoning: str | None = None
    provider: str
    model: str
    latency_ms: int
    finish_reason: str
    stats: GenerationStats
    # Ride-back for the billing plane. Guardrail forwards this verbatim on its
    # verdict; `models/usage.guardrail_usage_from_verdict` lifts it back onto the
    # `/generate` response that triggered the judgement.
    usage_detail: UsageDetail


def _ensure_semaphore(
    semaphores: dict[str, ResizableSemaphore], provider: str, budget: LaneBudget
) -> ResizableSemaphore:
    """The judge lane's permit for ``provider``, created on first use.

    Created lazily rather than read with ``.get()``: a missing entry must never
    degrade to "unbounded", and it must NEVER fall back to the user-facing
    semaphore — that would silently re-couple the two budgets.
    """
    semaphore = semaphores.get(provider)
    if semaphore is None:
        semaphore = ResizableSemaphore(budget.max_concurrent)
        semaphores[provider] = semaphore
    return semaphore


def _ensure_breaker(
    breakers: dict[str, CircuitBreaker], provider: str, budget: LaneBudget
) -> CircuitBreaker:
    """The judge lane's breaker for ``provider``, created on first use."""
    breaker = breakers.get(provider)
    if breaker is None:
        breaker = CircuitBreaker(
            failure_threshold=budget.failure_threshold,
            recovery_timeout=budget.recovery_timeout_s,
        )
        breakers[provider] = breaker
    return breaker


@router.post(
    "/generate/internal/judge",
    response_model=JudgeResponse,
    responses={
        404: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
async def judge(
    request_body: JudgeRequest,
    registry: ProviderRegistry = Depends(get_provider_registry),
    judge_semaphores: dict[str, ResizableSemaphore] = Depends(get_judge_semaphores),
    judge_breakers: dict[str, CircuitBreaker] = Depends(get_judge_circuit_breakers),
    # Live control-plane state — the judge lane's budget is one `(provider,
    # lane="judge")` AiRuntimeProfile row now, not the `TEXT_JUDGE_*` block.
    app_state: Any = Depends(get_app_state),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JudgeResponse:
    """Run one safety-plane judgement on the isolated judge pool.

    Auth is the standard ``X-Service-Token`` middleware posture (this path is not
    in ``EXEMPT_PATHS``; an empty configured token keeps the documented dev
    bypass). There is no public exposure: the gateway proxies ``/generate``, not
    this path.
    """
    with judge_scope():
        return await _run_judge(
            request_body,
            registry=registry,
            judge_semaphores=judge_semaphores,
            judge_breakers=judge_breakers,
            app_state=app_state,
            tenant_id=x_tenant_id,
        )


async def _run_judge(
    request_body: JudgeRequest,
    *,
    registry: ProviderRegistry,
    judge_semaphores: dict[str, ResizableSemaphore],
    judge_breakers: dict[str, CircuitBreaker],
    app_state: Any,
    tenant_id: str | None,
) -> JudgeResponse:
    provider_name = request_body.provider
    model = request_body.model
    ctx = structlog.contextvars.get_contextvars()
    request_id = ctx.get("request_id")

    # Rebuilt as a GenerateRequest because that is the provider-adapter contract
    # (`LLMProvider.generate`). `retry_config` is pinned to zero retries: the
    # caller's client owns the retry budget and the fail-closed verdict, and a
    # second retry layer here would multiply the worst-case latency a public
    # generation waits behind.
    generate_request = GenerateRequest(
        prompt=request_body.prompt,
        system_prompt=request_body.system_prompt,
        provider=provider_name,
        model=model,
        temperature=request_body.temperature,
        max_tokens=request_body.max_tokens,
        top_p=request_body.top_p,
        stream=False,
        response_format=request_body.response_format,
        retry_config=RetryConfig(max_retries=0, retry_on=[]),
        provider_overrides=request_body.provider_overrides,
    )

    # ONE budget for this `(provider, judge)` pair — concurrency, acquire
    # timeout, call timeout and breaker thresholds together. `TEXT_JUDGE_*`
    # expressed the same four concepts as `TEXT_CB_*` and `TEXT_QUEUE_*` with
    # different numbers; the judge lane's SMALLER budget is the real distinction
    # and it survives as the lane's floor (`core/runtime_defaults.py`).
    budget = lane_budget(app_state, provider_name, "judge")

    breaker = _ensure_breaker(judge_breakers, provider_name, budget)
    if not breaker.allow_request():
        raise CircuitOpenError(
            "Judge lane temporarily unavailable (circuit open)",
            provider=provider_name,
        )

    try:
        provider = registry.get(provider_name)
    except ProviderNotFoundError:
        raise DomainProviderNotFoundError(
            f"Provider '{provider_name}' not found",
            provider=provider_name,
        ) from None

    semaphore = _ensure_semaphore(judge_semaphores, provider_name, budget)
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=budget.acquire_timeout_s)
    except TimeoutError:
        # Fail fast rather than queue: guardrail's own bounded retry decides what
        # a saturated judge lane means for the verdict.
        raise ConcurrencyLimitError(
            "Judge lane is at capacity — try again later",
            provider=provider_name,
        ) from None

    start = time.monotonic()
    try:
        content, reasoning, gen_result = await asyncio.wait_for(
            provider.generate(generate_request),
            timeout=float(budget.timeout_s),
        )
        breaker.record_success()
        latency_ms = int((time.monotonic() - start) * 1000)

        # Best-effort, exactly as on the public path: a stats-mapping failure must
        # never fail a judgement whose tokens were already burned.
        stats: GenerationStats
        try:
            stats = _coerce_stats(
                gen_result, provider=provider_name, model=model, latency_ms=latency_ms
            )
        except Exception as exc:
            logger.warning("judge.stats_degraded", provider=provider_name, error=str(exc))
            stats = degraded_stats(provider=provider_name, model=model, total_ms=latency_ms)

        prompt_tokens, completion_tokens, total_tokens = _extract_usage(gen_result)
        usage_detail = build_usage_detail(
            # A judgement has no task lifecycle, but the billing plane keys its
            # ledger idempotency on `task_id`, so it must still be unique per call.
            task_id=f"judge-{uuid.uuid4().hex}",
            request_id=request_id,
            provider=provider_name,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            raw=raw_usage_from_stats(stats),
            # DERIVED, never stamped: `cost_basis` follows from the funding tier
            # of the credential that actually served the call.
            byok=_used_byok_credential(generate_request),
        )

        logger.info(
            "judge.completed",
            provider=provider_name,
            model=model,
            tenant_id=tenant_id,
            latency_ms=latency_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cost_basis=usage_detail.cost_basis,
        )

        return JudgeResponse(
            content=content,
            reasoning=reasoning or None,
            provider=provider_name,
            model=model,
            latency_ms=latency_ms,
            finish_reason=stats.stop_reason_raw or stats.stop_reason or "stop",
            stats=stats,
            usage_detail=usage_detail,
        )
    except TimeoutError:
        breaker.record_failure()
        logger.error(
            "judge.timeout",
            provider=provider_name,
            model=model,
            timeout_s=budget.timeout_s,
        )
        raise DomainProviderTimeoutError(
            f"Judge call timed out after {budget.timeout_s}s " f"for provider '{provider_name}'.",
            provider=provider_name,
        ) from None
    except ProviderCredentialsError:
        # A config gap, not a provider-health failure — no breaker failure (it
        # would open a circuit for an engine that never handled a request). The
        # shared handler maps it to 503.
        raise
    except Exception as exc:
        breaker.record_failure()
        logger.error(
            "judge.failed",
            provider=provider_name,
            model=model,
            error=str(exc),
            exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail="Judge call failed due to an internal error. Check server logs for details.",
        ) from exc
    finally:
        semaphore.release()
