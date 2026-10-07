"""Text tool client — text generation via ``POST /api/v1/generate`` (stream:false).

The harness always generates synchronously (``stream:false``) and passes the
activated SOAP ``response_format`` through untouched. Unset optional
hyperparameters are omitted so the Text service applies its own defaults.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import httpx
from hope_obs import outbound_context_headers
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from harness.core.llm_concurrency import LlmCallTimeout, governed_request
from harness.core.provider_credentials import (
    CredentialUnavailable,
    ProviderCredential,
    to_provider_overrides,
)
from harness.temporal import http_pool
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


#: TASK-1050 — the RFC 9457 `type` of a text-service guardrail block, and the distinct code of a
#: cloud-egress pseudonymiser outage (a privacy hold, never a safety verdict). Both from the frozen
#: contract (`@arcaai/types` `GUARDRAIL_BLOCKED_PROBLEM_TYPE`, processing reason
#: `EGRESS_REDACTION_UNAVAILABLE`); restated here because this module may not import the
#: interpreter package.
GUARDRAIL_BLOCKED_PROBLEM_TYPE = "urn:hope:problem:guardrail-blocked"
EGRESS_REDACTION_UNAVAILABLE = "EGRESS_REDACTION_UNAVAILABLE"
#: `@arcaai/types` `GUARDRAIL_CORRELATION_HEADERS` (pinned against the vocabulary fixture by
#: `test_task1050_run_protocol_guardrail.py` through `run_protocol.GUARDRAIL_CORRELATION_HEADERS`).
GUARDRAIL_CORRELATION_HEADERS: dict[str, str] = {
    "consultationId": "X-Hope-Consultation-Id",
    "runId": "X-Hope-Run-Id",
    "itemId": "X-Hope-Item-Id",
    "runKey": "X-Hope-Run-Key",
    "nodeId": "X-Hope-Node-Id",
}
#: The header a node re-run after an `acknowledged` hold resolution carries: proceed ONCE, at
#: warn weight, for exactly this notice. Proposed by TASK-1050 W2f (README §9.7.5 / §9.8.1).
GUARDRAIL_OVERRIDE_HEADER = "X-Hope-Guardrail-Override"


class TextGuardrailBlocked(TextServiceError):
    """The text service refused this generation for a guardrail reason (TASK-1050, lane W2c).

    ``kind`` says which: ``"blocked"`` — a ``block`` verdict (the 422
    ``urn:hope:problem:guardrail-blocked`` body), or ``"redaction_unavailable"`` — the cloud
    pseudonymiser was down, so unredacted PHI was not sent (TASK-1035 posture: fail closed). Both
    are HOLDS inside a workflow run, never an outage to fall back from: another candidate would be
    screened against the same policy. ``notice`` is the ``GuardrailNotice`` v1 the body carried
    (``None`` when it carried none); ``evaluation_ids`` the gap-detection keys (README §9.8.2).

    ``status_code`` is the HTTP status, so the per-endpoint governor classifies it like any other
    response: a 422 is terminal (never re-POSTed), a 503 redaction outage is retried within its
    bounded budget before it surfaces here.
    """

    def __init__(
        self,
        *,
        kind: str,
        status_code: int,
        notice: dict[str, Any] | None,
        evaluation_ids: list[str],
        error_code: str | None,
    ) -> None:
        super().__init__(f"text generate refused by guardrail ({kind}, http {status_code})")
        self.kind = kind
        self.status_code = status_code
        self.notice = notice
        self.evaluation_ids = evaluation_ids
        self.error_code = error_code


def _string_list(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str) and v] if isinstance(value, list) else []


def _problem_body(body: Any) -> dict[str, Any] | None:
    """The problem object of an error body — top level, or FastAPI's ``{"detail": {...}}``."""
    if not isinstance(body, dict):
        return None
    detail = body.get("detail")
    if isinstance(detail, dict) and (
        "guardrailNotice" in detail or "error_code" in detail or "type" in detail
    ):
        return detail
    return body


def guardrail_refusal(status_code: int, body: Any) -> TextGuardrailBlocked | None:
    """The :class:`TextGuardrailBlocked` an error response stands for, or ``None`` (pure).

    A block is recognised by its problem ``type`` or by the notice it carries; a redaction outage
    by its ``error_code``. Anything else is an ordinary text error and stays one.
    """
    problem = _problem_body(body)
    if problem is None:
        return None
    error_code = problem.get("error_code") or problem.get("code")
    error_code = error_code if isinstance(error_code, str) else None
    raw_notice = problem.get("guardrailNotice") or problem.get("guardrail_notice")
    notice = raw_notice if isinstance(raw_notice, dict) else None
    ids = _string_list(
        problem.get("guardrailEvaluationIds") or problem.get("guardrail_evaluation_ids")
    )
    if error_code == EGRESS_REDACTION_UNAVAILABLE:
        kind = "redaction_unavailable"
    elif problem.get("type") == GUARDRAIL_BLOCKED_PROBLEM_TYPE or notice is not None:
        kind = "blocked"
    else:
        return None
    return TextGuardrailBlocked(
        kind=kind,
        status_code=status_code,
        notice=notice,
        evaluation_ids=ids,
        error_code=error_code,
    )


def _json_or_none(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


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


#: The efforts a reasoning posture may name (``GenerateRequest.reasoning``, apps/text).
_REASONING_EFFORTS = ("minimal", "low", "medium", "high")


def reasoning_wire(reasoning: Any) -> dict[str, Any] | None:
    """``GenerateRequest.reasoning`` for an agent's ``parameters.generation.reasoning`` block.

    The Python half of ``agent-reasoning.ts::reasoningWire`` (the gateway rule every other agent
    call goes through): anything that is not ``{enabled: bool}`` is no opinion (``None`` — nothing
    is sent and the engine decides); ``enabled: false`` drops any effort, because a budget for
    reasoning that will not happen is a second, contradictory instruction; an unknown effort is
    dropped rather than sent.
    """
    if not isinstance(reasoning, Mapping) or not isinstance(reasoning.get("enabled"), bool):
        return None
    if not reasoning["enabled"]:
        return {"enabled": False}
    effort = reasoning.get("effort")
    return (
        {"enabled": True, "effort": effort} if effort in _REASONING_EFFORTS else {"enabled": True}
    )


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
    # TASK-1035 §5.0 — Text's egress report for THIS call: `{locality, detected: {label: count},
    # redacted, restored, images_unredacted, pii_leak_blocked}`. Counts only, never values.
    # Additive-optional default None ⇒ replay-safe, exactly like `stats` / `usage_detail`.
    egress: dict[str, Any] | None = None
    # TASK-1036 OD-1 (lane B4 → B1) — explicit inbound/outbound screening VERDICTS, when the text
    # service reports them (`{"inbound": {action, detected, …}, "outbound": {…}}`). Additive-
    # optional; absent ⇒ the harness derives the inbound verdict from `egress` alone.
    guardrail: dict[str, Any] | None = None
    # TASK-1050 (lane W2c) — the warn / unverified `GuardrailNotice`s this call raised (a block is
    # a `TextGuardrailBlocked` instead) and the guardrail evaluation ids, one per request x
    # direction (README §9.8.2 gap detection). Either spelling is read; absent ⇒ empty, which is
    # what an older text service reports. Additive with defaults ⇒ replay-safe like `stats`.
    guardrail_notices: list[dict[str, Any]] = Field(
        default_factory=list,
        validation_alias=AliasChoices("guardrail_notices", "guardrailNotices"),
    )
    guardrail_evaluation_ids: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("guardrail_evaluation_ids", "guardrailEvaluationIds"),
    )

    @field_validator("guardrail_notices", mode="before")
    @classmethod
    def _only_notice_objects(cls, value: Any) -> list[dict[str, Any]]:
        return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []

    @field_validator("guardrail_evaluation_ids", mode="before")
    @classmethod
    def _only_ids(cls, value: Any) -> list[str]:
        return _string_list(value)


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
        provider_override: dict[str, Any] | None = None,
        provider_locality: Mapping[str, str] | None = None,
        known_phi: list[dict[str, str]] | None = None,
        reasoning: Mapping[str, Any] | None = None,
        system_governance: Mapping[str, Any] | None = None,
        correlation: Mapping[str, str] | None = None,
        guardrail_override: str | None = None,
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

        ``provider_override`` is a gateway-RESOLVED connection entry
        (``ResolvedAgent.providerOverride``) for the row the caller is bound to. When
        present it is authoritative and the by-name credential resolver is skipped
        entirely — see the fold below.

        TASK-1035 §5.0 — ``apps/text`` owns LLM egress safety and fails CLOSED (no stamp ⇒
        cloud). ``provider_locality`` is sent only when the caller KNOWS the deployment kind
        (``harness.core.llm_egress.provider_locality``); ``known_phi`` carries the identity
        values the caller holds, for deterministic replacement on cloud, and is never logged.
        The retired guardrail opt-out (``guardrail_policy``) and ``require_medical=false`` are
        never sent (OD-1, OD-5): every call is screened.
        """
        url, body, headers = await self._prepare(
            tenant_id=tenant_id,
            prompt=prompt,
            system_prompt=system_prompt,
            provider=provider,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            response_format=response_format,
            context=context,
            idempotency_key=idempotency_key,
            provider_override=provider_override,
            provider_locality=provider_locality,
            known_phi=known_phi,
            reasoning=reasoning,
            system_governance=system_governance,
            correlation=correlation,
            guardrail_override=guardrail_override,
            stream=False,
        )

        async with http_pool.borrow(self._transport, self._timeout) as client:

            async def _send() -> httpx.Response:
                try:
                    resp = await client.post(url, json=body, headers=headers, timeout=self._timeout)
                except _POST_SEND_ERRORS as exc:
                    # The prompt reached Text (bytes sent) but the response was
                    # lost. The model MAY have run — do NOT let the governor re-POST it.
                    raise _TextResponseLost(exc) from exc
                if resp.status_code >= 400:
                    # TASK-1050 — a guardrail refusal is typed, never flattened into an outage
                    # the fallback chain would walk past.
                    refusal = guardrail_refusal(resp.status_code, _json_or_none(resp))
                    if refusal is not None:
                        raise refusal
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

    async def generate_stream(
        self,
        *,
        tenant_id: str,
        prompt: str,
        on_delta: Callable[[str], Awaitable[None]],
        system_prompt: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        top_p: float | None = None,
        response_format: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        provider_override: dict[str, Any] | None = None,
        provider_locality: Mapping[str, str] | None = None,
        known_phi: list[dict[str, str]] | None = None,
        reasoning: Mapping[str, Any] | None = None,
        system_governance: Mapping[str, Any] | None = None,
        correlation: Mapping[str, str] | None = None,
        guardrail_override: str | None = None,
    ) -> TextGenerationResult:
        """TASK-1038 R8 — the same generation as :meth:`generate`, with ``stream: true``.

        The text service answers ``200`` + SSE: ``meta``, one ``chunk`` per delta (``content``),
        then exactly one terminal frame — ``done`` (``data``: ``finish_reason``, ``usage``,
        ``egress``) or ``error``. Each chunk's text is handed to ``on_delta`` as it arrives; the
        assembled result is the blocking call's ``TextGenerationResult``, so every caller after
        this one is unchanged. Same tenant, credential, locality and PHI rules as
        :meth:`generate` (one preparation path). After the first byte of the stream a transport
        failure is ``after_send`` and is never re-issued by the governor.
        """
        url, body, headers = await self._prepare(
            tenant_id=tenant_id,
            prompt=prompt,
            system_prompt=system_prompt,
            provider=provider,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            response_format=response_format,
            context=context,
            idempotency_key=idempotency_key,
            provider_override=provider_override,
            provider_locality=provider_locality,
            known_phi=known_phi,
            reasoning=reasoning,
            system_governance=system_governance,
            correlation=correlation,
            guardrail_override=guardrail_override,
            stream=True,
        )
        headers["Accept"] = "text/event-stream"

        async with http_pool.borrow(self._transport, self._timeout) as client:

            async def _consume() -> TextGenerationResult:
                try:
                    async with client.stream(
                        "POST", url, json=body, headers=headers, timeout=self._timeout
                    ) as resp:
                        if resp.status_code >= 400:
                            await resp.aread()
                            refusal = guardrail_refusal(resp.status_code, _json_or_none(resp))
                            if refusal is not None:
                                raise refusal
                        resp.raise_for_status()
                        return await _read_generation_stream(resp, on_delta, provider, model)
                except _POST_SEND_ERRORS as exc:
                    raise _TextResponseLost(exc) from exc

            try:
                return await governed_request(self._base_url, _consume, retry_on_timeout=False)
            except _TextResponseLost as exc:
                raise TextServiceError(
                    f"text stream failed (response lost after dispatch): {exc.cause}",
                    after_send=True,
                ) from exc.cause
            except LlmCallTimeout as exc:
                raise TextServiceError(
                    f"text stream failed (per-call timeout; not re-issued): {exc}",
                    after_send=True,
                ) from exc
            except httpx.HTTPError as exc:
                raise TextServiceError(f"text stream failed: {exc}") from exc

    async def _prepare(
        self,
        *,
        tenant_id: str,
        prompt: str,
        system_prompt: str | None,
        provider: str | None,
        model: str | None,
        temperature: float | None,
        max_tokens: int | None,
        top_p: float | None,
        response_format: dict[str, Any] | None,
        context: dict[str, Any] | None,
        idempotency_key: str | None,
        provider_override: dict[str, Any] | None,
        provider_locality: Mapping[str, str] | None,
        known_phi: list[dict[str, str]] | None,
        stream: bool,
        reasoning: Mapping[str, Any] | None = None,
        system_governance: Mapping[str, Any] | None = None,
        correlation: Mapping[str, str] | None = None,
        guardrail_override: str | None = None,
    ) -> tuple[str, dict[str, Any], dict[str, str]]:
        """``(url, body, headers)`` of one generate call — the ONE preparation both the blocking
        and the streaming calls use (tenant guard, credential fold, locality, PHI, headers)."""
        if not tenant_id or not tenant_id.strip():
            raise ValueError(
                "text generate requires a tenant_id : pass the consultation's "
                "tenant, or an explicit 'tenantless:<reason>' marker for genuinely "
                "tenant-less work. An absent tenant is a caller defect."
            )
        url = f"{self._base_url}/api/v1/generate"
        body: dict[str, Any] = {"prompt": prompt, "stream": stream}
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
            # TASK-1047 FC-4 — only ever with a system prompt, and only when the caller verified it.
            if system_governance:
                body["system_governance"] = dict(system_governance)
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
        if provider_locality:
            body["provider_locality"] = dict(provider_locality)
        if known_phi:
            body["known_phi"] = known_phi
        # The resolved reasoning posture travels AS a posture (`GenerateRequest.reasoning`); each
        # Text adapter renders it. Absent means no tier had an opinion: nothing is sent.
        posture = reasoning_wire(reasoning)
        if posture is not None:
            body["reasoning"] = posture

        # Text holds no endpoint or credential of its own (/736):
        # every adapter, LM Studio included, reads ``provider_overrides[provider]`` and
        # answers a 503 ``PROVIDER_CREDENTIALS_MISSING`` without it. The gateway injects
        # that envelope on its own proxied calls; this client calls Text DIRECTLY, so it
        # folds the gateway-resolved connection (tenant → SYSTEM, ``funding`` derived
        # gateway-side) in itself. A DENIED/UNAVAILABLE outcome fails CLOSED here, as the
        # error type every call site already degrades on, before anything is sent.
        #
        # TASK-958 G3 — the caller's RESOLVED override wins, and the by-name fetch is then
        # not consulted at all. `resolve_provider_credential(service, provider, tenant)`
        # answers with the tenant's DEFAULT connection for that vendor, which since TASK-958
        # is one of several: an agent bound to a SIBLING (`AiModel.sourceConnectionId`)
        # spent — and was billed to — the default account instead. `ResolvedAgent`
        # `providerOverride` is the credential of the bound row, already resolved gateway-side
        # with `connection_id`/`connection_slug` and the DERIVED funding on it, so it is
        # forwarded as-is. The `elif` is the fail-closed half: an override that carries no
        # credential material must never be RESCUED by the name lookup, because the rescue
        # spends an account the binding did not name.
        if provider and provider_override:
            # `provider` rides inside the entry (`{ provider, ...binding.override }`) and is
            # stripped before it becomes the map's VALUE — the same strip the gateway's own
            # realtime fold performs (`live-documentation.service.ts`). The map is keyed by
            # the provider this request declares, because that is the key `apps/text` reads.
            entry = {key: value for key, value in provider_override.items() if key != "provider"}
            if not entry.get("api_key") and not entry.get("base_url"):
                raise TextServiceError(
                    f"text generate refused: the resolved connection for {provider!r} carries "
                    "neither a key nor an endpoint; it cannot serve this call, and the "
                    "tenant's default account for that provider is not a substitute for it"
                )
            body["provider_overrides"] = {provider: entry}
        elif provider and self._credential_resolver is not None:
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
        headers.update(outbound_context_headers())
        # TASK-1050 — the correlation the guardrail evaluation record lands on (README §9.8.2),
        # only the names the contract declares and only when known; and the one-shot override of
        # a resolved hold (README §9.7.5). Never a credential and never content.
        for field_name, value in (correlation or {}).items():
            name = GUARDRAIL_CORRELATION_HEADERS.get(field_name)
            if name is not None and isinstance(value, str) and value.strip():
                headers[name] = value.strip()
        if guardrail_override:
            headers[GUARDRAIL_OVERRIDE_HEADER] = guardrail_override
        return url, body, headers


async def _read_generation_stream(
    resp: httpx.Response,
    on_delta: Callable[[str], Awaitable[None]],
    provider: str | None,
    model: str | None,
) -> TextGenerationResult:
    """Read the text service's generation SSE to its terminal frame (TASK-1038 R8)."""
    parts: list[str] = []
    event = ""
    data_lines: list[str] = []
    terminal: dict[str, Any] | None = None
    #: TASK-1050 — the `guardrail.notice` frames (warn / unverified) the stream carried.
    notices: list[dict[str, Any]] = []

    async def dispatch() -> dict[str, Any] | None:
        nonlocal event, data_lines
        name, raw = event, "\n".join(data_lines)
        event, data_lines = "", []
        if not raw:
            return None
        try:
            chunk = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(chunk, dict):
            return None
        kind = chunk.get("type") or name
        if kind == "chunk" and isinstance(chunk.get("content"), str) and chunk["content"]:
            parts.append(chunk["content"])
            await on_delta(chunk["content"])
            return None
        payload = chunk.get("data")
        data: dict[str, Any] = payload if isinstance(payload, dict) else {}
        if kind == "guardrail.notice":
            if data:
                notices.append(data)
            return None
        if kind == "error":
            refusal = guardrail_refusal(422, data)
            if refusal is not None:
                raise refusal
            raise TextServiceError(f"text stream failed: {data.get('error') or 'error frame'}")
        if kind == "done":
            return data
        return None

    async for line in resp.aiter_lines():
        if line == "":
            found = await dispatch()
            if found is not None:
                terminal = found
                break
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    else:
        found = await dispatch()
        if found is not None:
            terminal = found
    if terminal is None:
        raise TextServiceError("text stream ended without a terminal frame", after_send=True)
    usage = terminal.get("usage")
    return TextGenerationResult(
        content="".join(parts),
        provider=str(terminal.get("provider") or provider or ""),
        model=str(terminal.get("model") or model or ""),
        usage=usage if isinstance(usage, dict) else {},
        finish_reason=str(terminal.get("finish_reason") or ""),
        egress=terminal.get("egress") if isinstance(terminal.get("egress"), dict) else None,
        guardrail=(
            terminal.get("guardrail") if isinstance(terminal.get("guardrail"), dict) else None
        ),
        guardrail_notices=[
            *notices,
            *(
                n
                for n in _list_of(terminal, "guardrail_notices", "guardrailNotices")
                if isinstance(n, dict) and n not in notices
            ),
        ],
        guardrail_evaluation_ids=_string_list(
            _list_of(terminal, "guardrail_evaluation_ids", "guardrailEvaluationIds")
        ),
    )


def _list_of(source: dict[str, Any], *names: str) -> list[Any]:
    for name in names:
        value = source.get(name)
        if isinstance(value, list):
            return value
    return []
