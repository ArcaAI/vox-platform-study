"""SMR tool client — text generation via ``POST /api/v1/generate`` (stream:false).

The harness always generates synchronously (``stream:false``) and passes the
activated SOAP ``response_format`` through untouched. Unset optional
hyperparameters are omitted so the SMR service applies its own defaults.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from harness.core.llm_concurrency import governed_request


class SmrServiceError(RuntimeError):
    """The SMR service was unreachable or returned a non-2xx response.

    ``after_send`` is True when the request was fully DELIVERED but the response was
    lost (a read-side transport failure), so the model MAY have generated — retrying
    would re-invoke it (C1-04). The ``generate`` activity uses this to make the
    Temporal retry non-retryable too, so no layer re-runs a post-dispatch generation.
    """

    def __init__(self, message: str, *, after_send: bool = False) -> None:
        super().__init__(message)
        self.after_send = after_send


# Read-side httpx failures: the request bytes were fully sent, so SMR MAY have run the
# model before the response was lost. Retrying re-invokes generation (C1-04). WRITE/
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
    model: str = ""
    provider: str = ""
    usage: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int = 0
    finish_reason: str = ""


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

        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:

            async def _send() -> httpx.Response:
                try:
                    resp = await client.post(url, json=body)
                except _POST_SEND_ERRORS as exc:
                    # C1-04: the prompt reached SMR (bytes sent) but the response was
                    # lost. The model MAY have run — do NOT let the governor re-POST it.
                    raise _SmrResponseLost(exc) from exc
                resp.raise_for_status()
                return resp

            # Per-endpoint governor (the SMR/Ollama box): bounded rate-limit-aware
            # retry on a transient generation failure before the loop's own retry. A
            # post-send loss is surfaced as ``_SmrResponseLost`` (marker-free) so the
            # governor gives up after ONE attempt instead of re-invoking the model.
            try:
                resp = await governed_request(self._base_url, _send)
            except _SmrResponseLost as exc:
                raise SmrServiceError(
                    f"smr generate failed (response lost after dispatch): {exc.cause}",
                    after_send=True,
                ) from exc.cause
            except httpx.HTTPError as exc:
                raise SmrServiceError(f"smr generate failed: {exc}") from exc
            data = resp.json()
        return SmrGenerationResult.model_validate(data)
