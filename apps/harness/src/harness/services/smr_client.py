"""SMR tool client — text generation via ``POST /api/v1/generate`` (stream:false).

The harness always generates synchronously (``stream:false``) and passes the
activated SOAP ``response_format`` through untouched. Unset optional
hyperparameters are omitted so the SMR service applies its own defaults.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from harness.core.llm_concurrency import LlmCallTimeout, governed_request
from harness.temporal.claim_check import ClaimCheckRef


class SmrServiceError(RuntimeError):
    """The SMR service was unreachable or returned a non-2xx response.

    ``after_send`` is True when the request reached SMR and the model MAY have generated —
    so retrying would re-invoke it. It is set for the two dispatch-then-lost
    paths this client closes: a read-side transport failure (``_POST_SEND_ERRORS``) and the
    governor's per-call ``LlmCallTimeout`` firing mid-request. ``generate`` also makes the
    Temporal retry non-retryable for these, so neither the governor nor ``_GENERATE_RETRY``
    re-issues them.

    NOT covered by ``after_send`` (still retried, pre-existing / lower risk): an SMR 5xx or
    the LM-Studio ``terminated`` 400 that arrives AFTER the model ran — the governor retries
    those. A deterministic ``Idempotency-Key`` (see ``generate``) lets SMR
    dedup a replayed generate — closing the worker-crash re-delivery path; the residual is a
    5xx after the model ran but before SMR cached the response. A pre-send failure sets
    ``after_send=False`` (safe to retry).
    """

    def __init__(self, message: str, *, after_send: bool = False) -> None:
        super().__init__(message)
        self.after_send = after_send


# Read-side httpx failures: the request bytes were fully sent, so SMR MAY have run the
# model before the response was lost. Retrying re-invokes generation. WRITE/
# connect/pool failures are PRE-send (the model never saw the prompt) and stay retryable.
_POST_SEND_ERRORS = (httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError)


class _SmrResponseLost(RuntimeError):
    """Sentinel for a post-send transport failure (prompt delivered, response lost).

    Raised out of the governed ``_send`` with a deliberately MARKER-FREE message so the
    per-endpoint governor's ``is_retryable`` returns False and does NOT re-POST it (a
    re-POST is a second generation). ``generate`` converts it to
    ``SmrServiceError(after_send=True)``.
    """

    def __init__(self, cause: Exception) -> None:
        super().__init__("smr response lost after prompt dispatch; not re-issued")
        self.cause = cause


class SmrGenerationResult(BaseModel):
    """Parsed SMR ``GenerateResponse`` (the fields the loop needs)."""

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
    # the normalized ``GenerationStats`` block SMR now returns
    # (stop reason + raw, total/TTFT ms, tokens/second, token counts, engine-native blob).
    # Captured verbatim as a dict (the SMR wire shape) — the harness does not depend on the
    # smr_v2 model. Additive-optional default None ⇒ replay-safe: an old ``generate`` activity
    # result deserializes it to None, and a legacy SMR cache hit that omits ``stats`` stays
    # None (never throws over missing stats). The generate activity returns this model, so the
    # field threads through to the activity result command-neutrally (no new workflow command).
    stats: dict[str, Any] | None = None


class SmrClient:
    """Thin async client for the SMR synchronous generate endpoint."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def generate(
        self,
        *,
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
    ) -> SmrGenerationResult:
        """Generate a completion synchronously and parse the response."""
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

        # A deterministic key lets SMR dedup a replayed generate (a
        # worker-crash re-delivery) without re-invoking — and re-billing — the model. Sent
        # as a header (the api_client Idempotency-Key contract), never in the LLM body.
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None

        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:

            async def _send() -> httpx.Response:
                try:
                    resp = await client.post(url, json=body, headers=headers)
                except _POST_SEND_ERRORS as exc:
                    # The prompt reached SMR (bytes sent) but the response was
                    # lost. The model MAY have run — do NOT let the governor re-POST it.
                    raise _SmrResponseLost(exc) from exc
                resp.raise_for_status()
                return resp

            # Per-endpoint governor (the SMR/Ollama box): bounded rate-limit-aware retry
            # on a transient generation failure before the loop's own retry. generate is
            # NON-idempotent, so ``retry_on_timeout=False`` makes a per-call governor
            # timeout terminal, and a post-send read loss is surfaced as
            # ``_SmrResponseLost`` (marker-free) — the governor NEVER re-invokes the model
            # after the prompt is dispatched. Pre-send failures still retry.
            try:
                resp = await governed_request(self._base_url, _send, retry_on_timeout=False)
            except _SmrResponseLost as exc:
                raise SmrServiceError(
                    f"smr generate failed (response lost after dispatch): {exc.cause}",
                    after_send=True,
                ) from exc.cause
            except LlmCallTimeout as exc:
                # The per-call governor timeout fired mid-request — the model may already
                # be running, so treat it as a post-send failure (never re-issued).
                raise SmrServiceError(
                    f"smr generate failed (per-call timeout; not re-issued): {exc}",
                    after_send=True,
                ) from exc
            except httpx.HTTPError as exc:
                raise SmrServiceError(f"smr generate failed: {exc}") from exc
            data = resp.json()
        return SmrGenerationResult.model_validate(data)
