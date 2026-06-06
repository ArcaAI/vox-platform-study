"""SMR tool client — text generation via ``POST /api/v1/generate`` (stream:false).

The harness always generates synchronously (``stream:false``) and passes the
activated SOAP ``response_format`` through untouched. Unset optional
hyperparameters are omitted so the SMR service applies its own defaults.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field


class SmrServiceError(RuntimeError):
    """The SMR service was unreachable or returned a non-2xx response."""


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
        transport: httpx.BaseTransport | None = None,
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
            try:
                resp = await client.post(url, json=body)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise SmrServiceError(f"smr generate failed: {exc}") from exc
            data = resp.json()
        return SmrGenerationResult.model_validate(data)
