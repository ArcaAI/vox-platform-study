"""External Guardrail client for Text."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx

from text.core.guardrail_posture import GuardrailPosture, resolve_posture
from text.core.logging import get_logger

logger = get_logger(__name__)

# Deterministic verdict reason emitted when the guardrail is unreachable after the
# bounded retry budget is exhausted. The /generate gate maps this to a retryable 503
# (distinct from a 422 content rejection). This path NEVER yields ``allowed: True``.
GUARDRAIL_UNAVAILABLE_REASON = "external_guardrail_unavailable"

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

    Fail posture (degrade-safe → fail-CLOSED): a transient error is
    absorbed by a bounded retry (``max_retries`` / ``retry_backoff_ms``); once the
    budget is exhausted the client returns a deterministic NOT-allowed verdict — an
    errored guardrail can NEVER return ``allowed: True`` (there is no fail-open
    branch). The only allow-without-check paths are the two DECLARED ones, and both
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
        the same bounded retry as the input gate and exhaust to the same
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
        """POST under the bounded retry; ``(verdict, "")`` or ``(None, last_error)``.

        The ONE retry/fail-closed loop both gate halves share. ``parse`` runs
        INSIDE the attempt so a payload the mapper cannot read is retried as a
        transient error, exactly as it always was for :meth:`validate`.

        Bounded retry: total tries = max_retries + 1. A transient blip is
        absorbed (a clean re-check proceeds); only a sustained outage exhausts the
        budget and fails CLOSED in the caller.

        Latency ceiling: under a HANG-style outage (each attempt burns the full
        timeout_s) worst-case added latency is bounded but non-trivial —
        ~= (max_retries + 1) * timeout_s + sum(backoff) ~= 30s at the defaults
        (3 * 10s + 0.3s) before the 503. The degrade-safe path therefore relies on
        the CALLER's own request timeout as the outer bound; do not raise the
        defaults without accounting for this ceiling.

        The budget is CONFIG, not a literal: `timeout_s` / `max_retries` /
        `retry_backoff_ms` ride on the resolved posture, served by the control
        plane's `externalGuardrail` group, with `GUARDRAIL_TIMEOUT_FLOOR_S` as
        the floor a checkout starts on. Deliberately unchanged by TASK-930 D-7:
        the observed screen was ~7.6 s WARM against a 10 s budget, which looks
        tight — but that sample had guardrail's nlp delegation shed by an open
        circuit, so it is a lower bound rather than a healthy round-trip, and a
        raise multiplies by attempts. The failure it was blamed for is a COLD
        model load measured in MINUTES; no per-attempt budget can cover that and
        one that tried would hold a clinician's request for the duration. The
        cold-start answers are `apps/nlp` retaining a cancelled load and warming
        at boot, and guardrail's breaker admitting one probe. If a clean warm
        measurement later shows the p99 near 10 s, raise the SERVED value first —
        it needs no redeploy — and move the floor only if every deployment agrees.
        """
        attempts = posture.max_retries + 1
        last_error = ""
        for attempt in range(attempts):
            try:
                response = await self.http_client.post(
                    f"{self.base_url}{path}",
                    json=body,
                    headers=headers,
                    timeout=posture.timeout_s,
                )
                response.raise_for_status()
                return parse(response.json()), ""
            except Exception as exc:
                last_error = _describe(exc)
                is_last = attempt + 1 >= attempts
                logger.warning(
                    "external_guardrail.attempt_failed",
                    attempt=attempt + 1,
                    attempts=attempts,
                    error=last_error,
                    base_url=self.base_url,
                    will_retry=not is_last,
                )
                if is_last:
                    break
                backoff_s = (posture.retry_backoff_ms / 1000.0) * (attempt + 1)
                if backoff_s > 0:
                    await asyncio.sleep(backoff_s)

        # Bounded retry exhausted → fail CLOSED with a deterministic not-allowed
        # verdict. There is deliberately no fail-open branch: an errored guardrail can
        # never ship an unmoderated PHI prompt, or an unscreened response. The gate
        # maps this reason to a retryable 503.
        logger.error(
            "external_guardrail.exhausted_fail_closed",
            attempts=attempts,
            error=last_error,
            base_url=self.base_url,
        )
        return None, last_error
