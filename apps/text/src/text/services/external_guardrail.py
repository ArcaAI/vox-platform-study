"""External Guardrail client for Text."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx

from text.core.guardrail_posture import GuardrailPosture, resolve_posture
from text.core.logging import get_logger
from text.core.runtime_defaults import (
    GUARDRAIL_BREAKER_FAILURE_THRESHOLD,
    GUARDRAIL_BREAKER_RECOVERY_S,
    GUARDRAIL_CONNECT_TIMEOUT_S,
)
from text.services.circuit_breaker import CircuitBreaker, CircuitState

logger = get_logger(__name__)

# Deterministic verdict reason emitted when the guardrail is unreachable after the
# bounded retry budget is exhausted. The /generate gate maps this to a retryable 503
# (distinct from a 422 content rejection). This path NEVER yields ``allowed: True``.
GUARDRAIL_UNAVAILABLE_REASON = "external_guardrail_unavailable"

# The verdict's ``error`` when the call was shed by the open circuit without being
# sent. The REASON stays ``GUARDRAIL_UNAVAILABLE_REASON`` so the gates map it to the
# same retryable 503; only the cause differs.
GUARDRAIL_CIRCUIT_OPEN_ERROR = "external_guardrail_circuit_open"

# Upstream statuses worth a retry: guardrail (or something in front of it) could
# not take the request. Everything else it answered is final for this call.
_RETRYABLE_STATUSES = frozenset({502, 503, 504})

# Guardrail's 503 detail when its delegated judge TIMED OUT
# (`GuardrailUndeterminedError(REASON_TIMEOUT).as_detail()`). Same timeout,
# propagated: guardrail already waited its full judge budget and does not retry
# a judgement, so this client does not either.
_JUDGE_TIMED_OUT_MARKER = "undetermined (timeout)"


def _judge_timed_out(response: httpx.Response) -> bool:
    return response.status_code == 503 and _JUDGE_TIMED_OUT_MARKER in response.text


def _retry_decision(exc: BaseException) -> tuple[bool, str]:
    """``(retryable, why)`` for one failed attempt.

    Retry only when the request provably started no work in guardrail: a
    connection that was never established, one dropped before any response (the
    stale keep-alive case), or an upstream 502/503/504. A read or write timeout is
    NOT retried — guardrail's judgement is still running and nothing cancels across
    the hop, so a second request stacks a second LLM call on the same GPU.
    """
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        return True, "connect_failed"
    if isinstance(exc, httpx.RemoteProtocolError):
        return True, "dropped_before_response"
    if isinstance(exc, (httpx.ReadTimeout, httpx.WriteTimeout)):
        return False, "timed_out_in_flight"
    if isinstance(exc, httpx.PoolTimeout):
        return False, "local_pool_exhausted"
    if isinstance(exc, httpx.TransportError):
        return False, "failed_after_send"
    if isinstance(exc, httpx.HTTPStatusError):
        if _judge_timed_out(exc.response):
            return False, "guardrail_judge_timed_out"
        if exc.response.status_code in _RETRYABLE_STATUSES:
            return True, "upstream_5xx"
        return False, "final_status"
    return False, "unreadable_verdict"


def _peer_unhealthy(exc: BaseException) -> bool:
    """Does this failure say guardrail itself is slow, saturated or unreachable?

    Only those count toward the breaker. A 4xx, a 500, or a 503 about ONE request
    (a low-confidence judgement, a tenant's own configuration) is guardrail
    answering correctly — counting it would let one tenant's traffic shed every
    tenant's moderation.
    """
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        if response.status_code in (502, 504):
            return True
        if response.status_code == 503:
            return _judge_timed_out(response) or "retry-after" in response.headers
    return False


# The two ways a gate can be skipped, kept as DISTINCT strings on purpose
# (TASK-890 OD-R). `external_guardrail_disabled` is the PLATFORM kill switch
# (`text.externalGuardrail.enabled`) — a platform state in which no tenant's
# opt-out was even consulted. `tenant_opted_out` is a TENANT decision for this
# call, folded gateway-side (node > workflow > agent) and pushed as
# `guardrail_policy.enabled: false`. The usage ledger records them as
# `platform_off` and `opted_out` respectively, and collapsing them here would
# make "this tenant chose to run unscreened" indistinguishable from "nobody has
# turned the platform gate on yet".
GUARDRAIL_DISABLED_REASON = "external_guardrail_disabled"
GUARDRAIL_TENANT_OPTED_OUT_REASON = "tenant_opted_out"


def _describe(exc: BaseException) -> str:
    """A NEVER-EMPTY description of a failed attempt: class, plus any message.

    httpx's timeout exceptions carry no message — `str(httpx.ReadTimeout(...))`
    raised by the transport is `""` — so logging `str(exc)` produced
    `attempt_failed … error=` three times, then `exhausted_fail_closed … error=`,
    and the whole 502 chain named no cause at all (TASK-930 D-7). The class IS
    the diagnosis: connect-refused, read-timeout and a malformed payload need
    three different responses.

    PHI-safe: an exception raised by the transport carries the request's shape,
    never its body.
    """
    detail = str(exc).strip()
    name = type(exc).__name__
    return f"{name}: {detail}" if detail else name


def _skip_reason(posture: GuardrailPosture) -> str:
    """Which of the two skip reasons this resolved posture represents."""
    return GUARDRAIL_TENANT_OPTED_OUT_REASON if posture.opted_out else GUARDRAIL_DISABLED_REASON


class ExternalGuardrailClient:
    """Calls the Guardrail service for medical-content validation.

    Fail posture (degrade-safe → fail-CLOSED): a failure that started no work in
    guardrail (connect failure, 502/503/504) is absorbed by a bounded retry
    (``max_retries`` / ``retry_backoff_ms``); a timeout is not retried; a circuit
    breaker sheds calls while guardrail is slow or unreachable. Every exhausted or
    shed call returns a deterministic NOT-allowed verdict — an errored guardrail can
    NEVER return ``allowed: True`` (there is no fail-open branch). The only
    allow-without-check paths are the two DECLARED ones, and both
    say which they are: the platform switch being off
    (``external_guardrail_disabled`` — the dev/CI bypass, preserved exactly, and it
    mirrors the empty-token bypass) and a tenant opting this call out
    (``tenant_opted_out``, TASK-890 OD-R). Neither is an error path, and neither can
    be reached by a guardrail that answered.
    """

    def __init__(
        self,
        *,
        base_url: str,
        http_client: httpx.AsyncClient,
        service_token: str = "",
        app_state: Any = None,
    ) -> None:
        """Only the ADDRESS is construction-time; the posture is per call.

        ``app_state`` carries the platform posture the control plane last served
        (`services/runtime_limits.apply_platform_posture`). It is read at call
        time rather than snapshotted here, so a platform admin turning moderation
        on takes effect on the next request rather than the next restart.
        """
        self.http_client = http_client
        self.base_url = base_url.rstrip("/")
        # Owner decision D-D (2026-08-17): the caller resolves the ONE shared
        # `INTERNAL_ACCESS_TOKEN` and passes it here.
        self._service_token = service_token
        self._app_state = app_state
        # One breaker for the one peer, shared by both gate halves. Half-open
        # admits a single probe, as guardrail's own peer breakers do.
        self._breaker = CircuitBreaker(
            failure_threshold=GUARDRAIL_BREAKER_FAILURE_THRESHOLD,
            recovery_timeout=GUARDRAIL_BREAKER_RECOVERY_S,
            half_open_max_calls=1,
        )

    def _platform_posture(self) -> GuardrailPosture:
        """The last posture the control plane served, or the in-code floors."""
        posture = getattr(self._app_state, "guardrail_posture", None)
        return posture if isinstance(posture, GuardrailPosture) else GuardrailPosture()

    async def validate(
        self,
        prompt: str,
        system_prompt: str | None = None,
        tenant_id: str | None = None,
        tenant_policy: Any = None,
        provider_overrides: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Moderate ``prompt`` under the resolved posture.

        ``tenant_policy`` is the request's PUSHED ``guardrail_policy`` block; it
        folds over the platform default tenant-first, widening only on absence
        (`core/guardrail_posture.resolve_posture`).

        ``provider_overrides`` is the connection blob the gateway injected on
        THIS generation, forwarded so guardrail's judge — which posts back to
        this service's judge lane, and where the whole chain used to end in a 503
        `PROVIDER_CREDENTIALS_MISSING` (TASK-890) — has a connection to use. It is
        an opaque pass-through in both directions: never inspected, never logged.
        ABSENT stays absent, because absence is what makes guardrail resolve the
        engine connection itself.
        """
        posture = resolve_posture(self._platform_posture(), tenant_policy)
        if not posture.enabled:
            return {
                "allowed": True,
                "is_medical": True,
                "confidence": 1.0,
                "reason": _skip_reason(posture),
            }

        text = prompt if not system_prompt else f"{system_prompt}\n\n{prompt}"

        def _parse(payload: dict[str, Any]) -> dict[str, Any]:
            is_medical = bool(payload.get("is_medical", False))
            return {
                "allowed": is_medical if posture.require_medical else True,
                "is_medical": is_medical,
                "confidence": float(payload.get("confidence", 0.0)),
                "reason": payload.get("reasoning")
                or payload.get("error")
                or "medical_validation_completed",
                "raw": payload,
            }

        body: dict[str, Any] = {"text": text, "include_reasoning": posture.include_reasoning}
        if provider_overrides:
            body["provider_overrides"] = provider_overrides

        verdict, last_error = await self._post_verdict(
            "/api/medical/validate",
            body,
            headers=self._headers(tenant_id),
            posture=posture,
            parse=_parse,
        )
        if verdict is not None:
            return verdict
        return {
            "allowed": False,
            "is_medical": False,
            "confidence": 0.0,
            "reason": GUARDRAIL_UNAVAILABLE_REASON,
            "error": last_error,
        }

    async def screen_output(
        self,
        response: str,
        *,
        source_context: str | None = None,
        tenant_id: str | None = None,
        tenant_policy: Any = None,
    ) -> dict[str, Any]:
        """Screen a model RESPONSE under the resolved posture (TASK-871).

        The post-receive half of the moderation gate. Posts the assembled
        completion to guardrail's outbound screen
        (``POST /api/v1/guardrail/screen/outbound``), which runs the
        response-safety / toxicity / refusal classifiers, a PII-leak check against
        ``source_context`` (the prompt the response was generated FROM — without
        it that check is reported ``skipped``, never ``pass``) and containment-echo
        detection. Guardrail's own decision is fail-CLOSED: a check that could not
        run yields ``decision: "block"``.

        The verdict shape mirrors :meth:`validate` so both halves of the gate read
        the same keys: ``allowed`` (``decision == "allow"``), ``reason`` (the first
        of guardrail's ``reasons[]`` — check names and labels only, never text) and
        ``raw``. A payload with no recognisable ``decision`` is
        ``allowed: False, reason: "malformed_verdict"`` — guardrail answered, so
        this is a rejection rather than an outage. Transport and HTTP failures ride
        the same retry rules and breaker as the input gate and exhaust to the same
        ``GUARDRAIL_UNAVAILABLE_REASON``. ``tenant_policy`` folds over the
        platform posture exactly as on the input side; only its transport fields
        (switch, timeout, retry budget) apply here — ``require_medical`` is an
        input-direction question.
        """
        posture = resolve_posture(self._platform_posture(), tenant_policy)
        if not posture.enabled:
            return {"allowed": True, "reason": _skip_reason(posture)}

        def _parse(payload: dict[str, Any]) -> dict[str, Any]:
            decision = payload.get("decision")
            if decision not in ("allow", "block"):
                return {"allowed": False, "reason": "malformed_verdict", "raw": payload}
            reasons = payload.get("reasons")
            first = reasons[0] if isinstance(reasons, list) and reasons else None
            allowed = decision == "allow"
            return {
                "allowed": allowed,
                "reason": (
                    str(first) if first else ("output_screened" if allowed else "output_blocked")
                ),
                "raw": payload,
            }

        verdict, last_error = await self._post_verdict(
            "/api/v1/guardrail/screen/outbound",
            {"response": response, "source_context": source_context},
            headers=self._headers(tenant_id),
            posture=posture,
            parse=_parse,
        )
        if verdict is not None:
            return verdict
        return {
            "allowed": False,
            "reason": GUARDRAIL_UNAVAILABLE_REASON,
            "error": last_error,
        }

    def _headers(self, tenant_id: str | None) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        # Forward the consultation tenant so guardrail can resolve per-tenant
        # provider/model from the DB.
        if tenant_id:
            headers["X-Tenant-Id"] = tenant_id
        return headers

    async def _post_verdict(
        self,
        path: str,
        body: dict[str, Any],
        *,
        headers: dict[str, str],
        posture: GuardrailPosture,
        parse: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> tuple[dict[str, Any] | None, str]:
        """POST under the retry rules and the breaker; ``(verdict, "")`` or ``(None, error)``.

        The ONE retry/fail-closed loop both gate halves share.

        **Timeouts nest.** ``timeout_s`` is how long TEXT waits for guardrail's
        answer, and it is sized to outlast ONE guardrail validation (admission wait
        + one judge attempt at ``guardrail.judge.timeoutSeconds``). Guardrail
        therefore answers — a verdict, or its own fail-closed 503 — before TEXT
        gives up. The connect phase has its own short bound
        (``GUARDRAIL_CONNECT_TIMEOUT_S``): establishing a connection has nothing to
        do with judge latency.

        **Only failures that started no work are retried** (``_retry_decision``):
        total tries = max_retries + 1 for a connect failure, a connection dropped
        before any response, or a 502/503/504. A read/write timeout, a 503 in which
        guardrail says its judge timed out, a 4xx/500 and an unreadable verdict are
        final — the judgement either already ran or is still running, and nothing
        cancels across the hop.

        **The breaker sheds.** Consecutive peer-health failures (``_peer_unhealthy``)
        open it; while open, a call is answered fail-closed without being sent
        (``error = GUARDRAIL_CIRCUIT_OPEN_ERROR``); after the cool-down one probe is
        admitted.

        Latency ceiling: a hang costs one ``timeout_s`` (not retried). Connect
        failures cost ~``max_retries x GUARDRAIL_CONNECT_TIMEOUT_S`` + backoff
        before the answer wait. The theoretical ceiling, every attempt ending in a
        late retryable 5xx, is ``(max_retries + 1) x timeout_s`` + backoff. The
        CALLER's own request timeout stays the outer bound.

        The budget is CONFIG, not a literal: `timeout_s` / `max_retries` /
        `retry_backoff_ms` ride on the resolved posture, served by the control
        plane's `externalGuardrail` group, with the `runtime_defaults` floors as the
        values a checkout starts on.
        """
        attempts = posture.max_retries + 1
        timeout = httpx.Timeout(
            posture.timeout_s, connect=min(posture.timeout_s, GUARDRAIL_CONNECT_TIMEOUT_S)
        )
        last_error = ""
        for attempt in range(attempts):
            probing = self._breaker.state == CircuitState.HALF_OPEN
            if not self._breaker.allow_request():
                logger.warning(
                    "external_guardrail.shed_circuit_open",
                    attempt=attempt + 1,
                    attempts=attempts,
                    base_url=self.base_url,
                    last_error=last_error,
                )
                return None, GUARDRAIL_CIRCUIT_OPEN_ERROR
            try:
                response = await self.http_client.post(
                    f"{self.base_url}{path}",
                    json=body,
                    headers=headers,
                    timeout=timeout,
                )
                response.raise_for_status()
                verdict = parse(response.json())
            except asyncio.CancelledError:
                # The caller gave up: nothing learned about the peer. A cancelled
                # probe must still free the single half-open slot, or every later
                # call is shed forever; re-opening restarts the cool-down.
                if probing:
                    self._breaker.record_failure()
                raise
            except Exception as exc:
                if _peer_unhealthy(exc):
                    self._breaker.record_failure()
                else:
                    self._breaker.record_success()
                last_error = _describe(exc)
                retryable, why = _retry_decision(exc)
                will_retry = retryable and attempt + 1 < attempts
                logger.warning(
                    "external_guardrail.attempt_failed",
                    attempt=attempt + 1,
                    attempts=attempts,
                    error=last_error,
                    base_url=self.base_url,
                    will_retry=will_retry,
                    retry_reason=why if will_retry or not retryable else "budget_exhausted",
                )
                if not will_retry:
                    break
                backoff_s = (posture.retry_backoff_ms / 1000.0) * (attempt + 1)
                if backoff_s > 0:
                    await asyncio.sleep(backoff_s)
            else:
                self._breaker.record_success()
                return verdict, ""

        # Fail CLOSED with a deterministic not-allowed verdict. There is
        # deliberately no fail-open branch: an errored guardrail can never ship an
        # unmoderated PHI prompt, or an unscreened response. The gate maps this
        # reason to a retryable 503.
        logger.error(
            "external_guardrail.exhausted_fail_closed",
            attempts=attempts,
            error=last_error,
            base_url=self.base_url,
        )
        return None, last_error
