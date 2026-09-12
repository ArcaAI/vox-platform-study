"""Text tool client — text generation via ``POST /api/v1/generate`` (stream:false).

The harness always generates synchronously (``stream:false``) and passes the
activated SOAP ``response_format`` through untouched. Unset optional
hyperparameters are omitted so the Text service applies its own defaults.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from harness.core.llm_concurrency import LlmCallTimeout, governed_request
from harness.core.provider_credentials import (
    CredentialUnavailable,
    ProviderCredential,
    to_provider_overrides,
)
from harness.temporal.claim_check import ClaimCheckRef


class TextServiceError(RuntimeError):
    """The Text service was unreachable or returned a non-2xx response.

    ``after_send`` is True when the request reached Text and the model MAY have generated —
    so retrying would re-invoke it. It is set for the two dispatch-then-lost
    paths this client closes: a read-side transport failure (``_POST_SEND_ERRORS``) and the
    governor's per-call ``LlmCallTimeout`` firing mid-request. ``generate`` also makes the
    Temporal retry non-retryable for these, so neither the governor nor ``_GENERATE_RETRY``
    re-issues them.

    NOT covered by ``after_send`` (still retried, pre-existing / lower risk): an Text 5xx or
    the LM-Studio ``terminated`` 400 that arrives AFTER the model ran — the governor retries
    those. A deterministic ``Idempotency-Key`` (see ``generate``) lets Text
    dedup a replayed generate — closing the worker-crash re-delivery path; the residual is a
    5xx after the model ran but before Text cached the response. A pre-send failure sets
    ``after_send=False`` (safe to retry).
    """

    def __init__(self, message: str, *, after_send: bool = False) -> None:
        super().__init__(message)
        self.after_send = after_send


# Read-side httpx failures: the request bytes were fully sent, so Text MAY have run the
# model before the response was lost. Retrying re-invokes generation. WRITE/
# connect/pool failures are PRE-send (the model never saw the prompt) and stay retryable.
_POST_SEND_ERRORS = (httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError)


class _TextResponseLost(RuntimeError):
    """Sentinel for a post-send transport failure (prompt delivered, response lost).

    Raised out of the governed ``_send`` with a deliberately MARKER-FREE message so the
    per-endpoint governor's ``is_retryable`` returns False and does NOT re-POST it (a
    re-POST is a second generation). ``generate`` converts it to
    ``TextServiceError(after_send=True)``.
    """

    def __init__(self, cause: Exception) -> None:
        super().__init__("text response lost after prompt dispatch; not re-issued")
        self.cause = cause


class TextGenerationResult(BaseModel):
    """Parsed Text ``GenerateResponse`` (the fields the loop needs)."""

    model_config = ConfigDict(extra="ignore")

    content: str
    # Claim-check: OPTIONAL out-of-band ref to the generated note. Set by the
    # ``generate`` activity when ``content`` is offloaded above the threshold — in which
    # case ``content`` is emptied so the (large) note stays OUT of Temporal history, and
    # the workflow threads ``content_ref`` to the downstream activities that resolve it.
    # Additive-optional default None ⇒ replay-safe (an old ``generate`` result deserializes
    # it to None ⇒ the inline note path).
    content_ref: ClaimCheckRef | None = None
    model: str = ""
    provider: str = ""
    usage: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int = 0
    finish_reason: str = ""
    # the normalized ``GenerationStats`` block Text now returns
    # (stop reason + raw, total/TTFT ms, tokens/second, token counts, engine-native blob).
    # Captured verbatim as a dict (the Text wire shape) — the harness does not depend on the
    # text model. Additive-optional default None ⇒ replay-safe: an old ``generate`` activity
    # result deserializes it to None, and a legacy Text cache hit that omits ``stats`` stays
    # None (never throws over missing stats). The generate activity returns this model, so the
    # field threads through to the activity result command-neutrally (no new workflow command).
    stats: dict[str, Any] | None = None
    # TASK-957 F-6 / TASK-959 §10.2 — Text's normalized billing passthrough. It sits on the
    # SAME response as `stats` and always has, but this model's `extra="ignore"` dropped it, so
    # the cache/reasoning split and the timing/byte counts never reached the trajectory step and
    # the gateway's mapper zeroed them (`cacheReadTokens: 0, reasoningTokens: 0`). Captured
    # verbatim as a dict (the Text wire shape), like `stats`: the harness does not depend on the
    # text model. Additive-optional default None ⇒ replay-safe, since the `generate` activity
    # returns this model and an older activity result deserializes it to None.
    usage_detail: dict[str, Any] | None = None


def _int_or_none(source: Any, name: str) -> int | None:
    """One integer count off a mapping, or ``None``.

    Absent is NOT zero (the same distinction ``apps/text`` makes when it builds these): "the
    provider reported no cache breakdown" and "the provider reported zero cached tokens" are
    different facts, and only the second belongs in a billing row.
    """
    if not isinstance(source, dict):
        return None
    value = source.get(name)
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def usage_detail_counters(usage_detail: dict[str, Any] | None) -> dict[str, Any]:
    """The seven `usage_detail` counts a trajectory `LLM_CALL` step carries (TASK-959 §10.2).

    Read DEFENSIVELY, and only what is actually there — an absent key stays absent rather than
    becoming a zero the rater would price. Two shapes are accepted for the token counts because
    both are real:

    * the FLAT spelling (``usage_detail.cache_read_tokens``, …) — where the P-TEXT lane is
      normalising them, and where `total_ms`/`engine_ms`/the byte counts live;
    * the provider's own ``raw`` object (``prompt_tokens_details.cached_tokens``,
      ``completion_tokens_details.reasoning_tokens``) — which is where they live TODAY, and the
      reason F-6 reported reasoning-model spend as structurally unbillable.

    The flat spelling wins wherever both appear: it is `apps/text`'s own normalization, and the
    raw object is whatever the vendor happened to send.
    """
    if not isinstance(usage_detail, dict):
        return {}

    raw = usage_detail.get("raw")
    raw = raw if isinstance(raw, dict) else {}
    prompt_details = raw.get("prompt_tokens_details")
    completion_details = raw.get("completion_tokens_details")

    counters: dict[str, Any] = {}
    for key, fallbacks in (
        ("cache_read_tokens", ((prompt_details, "cached_tokens"), (raw, "cache_read_tokens"))),
        (
            "cache_write_tokens",
            ((prompt_details, "cache_write_tokens"), (raw, "cache_write_tokens")),
        ),
        (
            "reasoning_tokens",
            ((completion_details, "reasoning_tokens"), (raw, "reasoning_tokens")),
        ),
        ("total_ms", ()),
        ("engine_ms", ()),
        ("request_bytes", ()),
        ("response_bytes", ()),
    ):
        value = _int_or_none(usage_detail, key)
        for source, name in fallbacks:
            if value is not None:
                break
            value = _int_or_none(source, name)
        if value is not None:
            counters[key] = value
    return counters


#: ``(provider, tenant_id) -> ProviderCredential``. NEVER raises — every fault is an
#: ``UNAVAILABLE`` outcome the client fails closed on (``ApiClient.resolve_provider_credential``).
CredentialResolver = Callable[[str, str], Awaitable[ProviderCredential]]


class TextClient:
    """Thin async client for the Text synchronous generate endpoint."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 120.0,
        service_token: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
        credential_resolver: CredentialResolver | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._service_token = service_token
        self._transport = transport
        # resolves the (provider, tenant_id) AiProviderConnection the
        # request must carry (see ``generate``). ``None`` keeps the bare client for
        # callers that inject the envelope themselves or run against a Text that
        # still accepts a connection-less request (unit fixtures).
        self._credential_resolver = credential_resolver

    async def generate(
        self,
        *,
        tenant_id: str,
        prompt: str,
        system_prompt: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        top_p: float | None = None,
        response_format: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        guardrail_policy: dict[str, Any] | None = None,
    ) -> TextGenerationResult:
        """Generate a completion synchronously and parse the response.

        tenant_id is MANDATORY ( owner directive, 2026-08-16). Text
        resolves the tenant's BYOK provider/credential from ``X-Tenant-Id`` and
        derives funding/cost_basis from whichever tier supplied
        that credential — so a dropped tenant mis-CONFIGURES *and* mis-BILLS the
        call, with nothing thrown or logged anywhere. It is passed positionally
        by nobody: every caller must name it.

        Genuinely tenant-less internal work declares itself with a
        ``tenantless:<reason>`` marker; a blank value is a CALLER defect and
        raises here rather than being papered over downstream.
        """
        if not tenant_id or not tenant_id.strip():
            raise ValueError(
                "text generate requires a tenant_id : pass the consultation's "
                "tenant, or an explicit 'tenantless:<reason>' marker for genuinely "
                "tenant-less work. An absent tenant is a caller defect."
            )
        url = f"{self._base_url}/api/v1/generate"
        body: dict[str, Any] = {"prompt": prompt, "stream": False}
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if provider:
            body["provider"] = provider
        if model:
            body["model"] = model
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if top_p is not None:
            body["top_p"] = top_p
        if response_format is not None:
            body["response_format"] = response_format
        if context is not None:
            body["context"] = context
        # TASK-890 §3.14 (OD-R) — the tenant's guardrail decision for THIS call, already
        # folded by the caller (`guardrail_optout.resolve_guardrail_decision`: node > workflow
        # > agent > on). Passed through verbatim and only when the caller supplies it: an
        # absent key means "no opinion", under which TEXT's platform posture governs. This
        # client neither folds the precedence nor invents an opinion — and a pushed `True`
        # cannot revive a platform kill switch, because TEXT keeps `platform.enabled` as the
        # floor (`core/guardrail_posture.resolve_posture`).
        if guardrail_policy is not None:
            body["guardrail_policy"] = guardrail_policy

        # Text holds no endpoint or credential of its own (/736):
        # every adapter, LM Studio included, reads ``provider_overrides[provider]`` and
        # answers a 503 ``PROVIDER_CREDENTIALS_MISSING`` without it. The gateway injects
        # that envelope on its own proxied calls; this client calls Text DIRECTLY, so it
        # folds the gateway-resolved connection (tenant → SYSTEM, ``funding`` derived
        # gateway-side) in itself. A DENIED/UNAVAILABLE outcome fails CLOSED here, as the
        # error type every call site already degrades on, before anything is sent.
        if provider and self._credential_resolver is not None:
            credential = await self._credential_resolver(provider, tenant_id.strip())
            try:
                credential.raise_if_unusable(service="llm", provider=provider)
            except CredentialUnavailable as exc:
                raise TextServiceError(f"text generate refused: {exc}") from exc
            overrides = to_provider_overrides(credential, provider)
            if overrides:
                body["provider_overrides"] = overrides

        # A deterministic key lets Text dedup a replayed generate (a
        # worker-crash re-delivery) without re-invoking — and re-billing — the model. Sent
        # as a header (the api_client Idempotency-Key contract), never in the LLM body.
        headers: dict[str, str] = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        # Text's ServiceAuthMiddleware requires X-Service-Token whenever TEXT_SERVICE_TOKEN
        # is configured — omitted when unset so local dev-bypass keeps working.
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        # MANDATORY tenant identity. Unconditional by construction
        # the guard above already rejected a blank value.
        headers["X-Tenant-Id"] = tenant_id.strip()

        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:

            async def _send() -> httpx.Response:
                try:
                    resp = await client.post(url, json=body, headers=headers)
                except _POST_SEND_ERRORS as exc:
                    # The prompt reached Text (bytes sent) but the response was
                    # lost. The model MAY have run — do NOT let the governor re-POST it.
                    raise _TextResponseLost(exc) from exc
                resp.raise_for_status()
                return resp

            # Per-endpoint governor (the Text/LM Studio box): bounded rate-limit-aware retry
            # on a transient generation failure before the loop's own retry. generate is
            # NON-idempotent, so ``retry_on_timeout=False`` makes a per-call governor
            # timeout terminal, and a post-send read loss is surfaced as
            # ``_TextResponseLost`` (marker-free) — the governor NEVER re-invokes the model
            # after the prompt is dispatched. Pre-send failures still retry.
            try:
                resp = await governed_request(self._base_url, _send, retry_on_timeout=False)
            except _TextResponseLost as exc:
                raise TextServiceError(
                    f"text generate failed (response lost after dispatch): {exc.cause}",
                    after_send=True,
                ) from exc.cause
            except LlmCallTimeout as exc:
                # The per-call governor timeout fired mid-request — the model may already
                # be running, so treat it as a post-send failure (never re-issued).
                raise TextServiceError(
                    f"text generate failed (per-call timeout; not re-issued): {exc}",
                    after_send=True,
                ) from exc
            except httpx.HTTPError as exc:
                raise TextServiceError(f"text generate failed: {exc}") from exc
            data = resp.json()
        return TextGenerationResult.model_validate(data)
