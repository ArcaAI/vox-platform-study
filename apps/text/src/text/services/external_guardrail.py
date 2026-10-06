"""External Guardrail client for Text."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
from hope_obs import outbound_context_headers
from prometheus_client import Counter

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


# The verdict's ``error`` when guardrail answered a regions call without echoing every
# region it was sent (TASK-1047 FC-5). The REASON stays ``GUARDRAIL_UNAVAILABLE_REASON``
# so every gate maps it to the same retryable 503 as an outage: nothing was judged.
GUARDRAIL_COVERAGE_MISSING_ERROR = "external_guardrail_screen_coverage_missing"

SCREEN_COVERAGE_MISSING = Counter(
    "text_egress_screen_coverage_missing_total",
    "Regions verdicts failed closed because guardrail did not echo every region sent",
    ["call"],
)


def _coverage_missing(payload: dict[str, Any], regions: list[dict[str, str]]) -> int | None:
    """``None`` when every region key sent is in ``screened_regions``; else the gap.

    A guardrail that predates the regions API ignores ``regions`` and screens an
    empty ``text``; its "allow" inspected nothing. So the echo is the proof of
    coverage: an ABSENT or malformed ``screened_regions`` covers nothing, even for
    an empty ``regions`` list (the gap is then 0, and still a failure). An empty
    list sent with ``screened_regions: []`` echoed is covered.
    """
    sent = {region["key"] for region in regions}
    screened = payload.get("screened_regions")
    if not isinstance(screened, list):
        return len(sent)
    missing = sent - {str(key) for key in screened}
    return len(missing) if missing else None


def _undetermined(call: str, missing: int) -> None:
    """Log (the COUNT, never text) and count a coverage failure."""
    SCREEN_COVERAGE_MISSING.labels(call=call).inc()
    logger.error("text.egress.screen_coverage_missing", call=call, missing=missing)


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


class ExternalGuardrailClient:
    """Calls the Guardrail service: the inbound screen, the medical judge, the outbound screen.

    Fail posture (degrade-safe → fail-CLOSED): a failure that started no work in
    guardrail (connect failure, 502/503/504) is absorbed by a bounded retry
    (``max_retries`` / ``retry_backoff_ms``); a timeout is not retried; a circuit
    breaker sheds calls while guardrail is slow or unreachable. Every exhausted or
    shed call returns a deterministic NOT-allowed verdict — an errored guardrail can
    NEVER return ``allowed: True``. There is no allow-without-check path any more
    (TASK-1035): the platform switch, the tenant opt-out and the `require_medical`
    skip are gone, and the medical judge is skipped only by the CALLER for a
    request that declared ``medical_exempt: "internal"``.
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
        time rather than snapshotted here, so a served tuning change takes effect on
        the next request rather than the next restart.
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
        prompt: str = "",
        system_prompt: str | None = None,
        tenant_id: str | None = None,
        tenant_policy: Any = None,
        provider_overrides: dict[str, Any] | None = None,
        *,
        regions: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Moderate ``prompt`` — or, from the egress gate, ``regions`` — under the posture.

        ``regions`` (TASK-1047 FC-5, OD-5) are the data regions ``[{key, text}]``;
        a verdict that does not echo every key in ``screened_regions`` is an outage
        (fail closed, ``GUARDRAIL_COVERAGE_MISSING_ERROR``);
        guardrail judges them window by window and caches each window's verdict
        (FC-7), so this client keeps NO verdict cache of its own: a whole-text key
        missed on every live flush anyway (the transcript grows), was a bare sha256
        of PHI in Redis, and carried no policy version. With ``regions`` the legacy
        ``text`` is sent empty.

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

        text = prompt if not system_prompt else f"{system_prompt}\n\n{prompt}"
        if regions is not None:
            text = ""

        def _parse(payload: dict[str, Any]) -> dict[str, Any]:
            if regions is not None:
                missing = _coverage_missing(payload, regions)
                if missing is not None:
                    _undetermined("medical", missing)
                    return {
                        "allowed": False,
                        "is_medical": False,
                        "confidence": 0.0,
                        "reason": GUARDRAIL_UNAVAILABLE_REASON,
                        "error": GUARDRAIL_COVERAGE_MISSING_ERROR,
                    }
            is_medical = bool(payload.get("is_medical", False))
            return {
                "allowed": is_medical,
                "is_medical": is_medical,
                "confidence": float(payload.get("confidence", 0.0)),
                "reason": payload.get("reasoning")
                or payload.get("error")
                or "medical_validation_completed",
                "raw": payload,
            }

        body: dict[str, Any] = {"text": text, "include_reasoning": posture.include_reasoning}
        if regions is not None:
            body["regions"] = regions
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
        source_regions: list[dict[str, str]] | None = None,
        tenant_id: str | None = None,
        tenant_policy: Any = None,
    ) -> dict[str, Any]:
        """Screen a model RESPONSE under the resolved posture (TASK-871).

        The post-receive half of the moderation gate. Posts the assembled
        completion to guardrail's outbound screen
        (``POST /api/v1/guardrail/screen/outbound``), which runs the
        response-safety / toxicity / refusal classifiers, a PII-leak check against
        ``source_regions`` (TASK-1047 FC-5: the untrusted regions the response was
        generated FROM — without them that check is reported ``skipped``, never
        ``pass``) and containment-echo detection. Guardrail windows the response
        itself (OD-9). With ``source_regions``, a verdict whose ``screened_regions``
        does not echo every key sent is an outage, never an "allow" (TASK-1047). Guardrail's own decision is fail-CLOSED: a check that could not
        run yields ``decision: "block"``.

        The verdict shape mirrors :meth:`validate` so both halves of the gate read
        the same keys: ``allowed`` (``decision == "allow"``), ``reason`` (the first
        of guardrail's ``reasons[]`` — check names and labels only, never text) and
        ``raw``. A payload with no recognisable ``decision`` is
        ``allowed: False, reason: "malformed_verdict"`` — guardrail answered, so
        this is a rejection rather than an outage. Transport and HTTP failures ride
        the same retry rules and breaker as the input gate and exhaust to the same
        ``GUARDRAIL_UNAVAILABLE_REASON``. ``tenant_policy`` is accepted for symmetry
        with the input side; only the platform transport tuning applies here.
        """
        posture = resolve_posture(self._platform_posture(), tenant_policy)

        def _parse(payload: dict[str, Any]) -> dict[str, Any]:
            if source_regions is not None:
                missing = _coverage_missing(payload, source_regions)
                if missing is not None:
                    _undetermined("outbound", missing)
                    return {
                        "allowed": False,
                        "reason": GUARDRAIL_UNAVAILABLE_REASON,
                        "error": GUARDRAIL_COVERAGE_MISSING_ERROR,
                    }
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
            {"response": response, "source_regions": source_regions},
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

    async def screen_inbound(
        self, *, regions: list[dict[str, str]], tenant_id: str | None = None
    ) -> dict[str, Any]:
        """Screen inbound REGIONS AND return their PII spans (TASK-1035 §5.0, TASK-1047 FC-5).

        One call to guardrail's ``/screen/inbound`` with ``regions`` (``text`` empty)
        and ``include_pii_spans``: guardrail windows each region independently, and
        the prompt-safety / toxicity / jailbreak classification and the GLiNER2 span
        extraction run concurrently guardrail-side. The verdict shape mirrors
        :meth:`screen_output` — ``allowed``, ``reason`` (a check NAME, never text),
        ``raw`` — plus ``pii_spans`` (``[{label, start, end, text, score, region}]``,
        offsets relative to the named region's text). A verdict whose
        ``screened_regions`` does not echo every key sent is an outage, never an
        "allow" (TASK-1047). The span values are PHI: they
        exist only so the caller can replace them, and are never logged here. No
        containment envelope is requested (``wrap: false``): the caller sends its own
        prompt.
        """
        posture = self._platform_posture()

        def _parse(payload: dict[str, Any]) -> dict[str, Any]:
            missing = _coverage_missing(payload, regions)
            if missing is not None:
                _undetermined("inbound", missing)
                return {
                    "allowed": False,
                    "reason": GUARDRAIL_UNAVAILABLE_REASON,
                    "pii_spans": [],
                    "error": GUARDRAIL_COVERAGE_MISSING_ERROR,
                }
            decision = payload.get("decision")
            spans = payload.get("pii_spans")
            if decision not in ("allow", "block") or not isinstance(spans, list):
                return {"allowed": False, "reason": "malformed_verdict", "pii_spans": []}
            reasons = payload.get("reasons")
            first = reasons[0] if isinstance(reasons, list) and reasons else None
            allowed = decision == "allow"
            return {
                "allowed": allowed,
                "reason": (
                    str(first) if first else ("input_screened" if allowed else "input_blocked")
                ),
                "pii_spans": spans,
                "raw": {k: v for k, v in payload.items() if k != "pii_spans"},
            }

        verdict, last_error = await self._post_verdict(
            "/api/v1/guardrail/screen/inbound",
            {
                "text": "",
                "regions": regions,
                "kind": "prompt",
                "wrap": False,
                "include_pii_spans": True,
            },
            headers=self._headers(tenant_id),
            posture=posture,
            parse=_parse,
        )
        if verdict is not None:
            return verdict
        return {
            "allowed": False,
            "reason": GUARDRAIL_UNAVAILABLE_REASON,
            "pii_spans": [],
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
        headers.update(outbound_context_headers())
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
