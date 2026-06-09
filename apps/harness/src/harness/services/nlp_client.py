"""NLP tool client — medical NER via ``POST /api/v1/classify/tokens``.

Maps the NLP service response shape (``{text, normalized_text, entity_type,
confidence, position:{start,end}}``) onto Lane H's :class:`NEREntity`
(``{text, type, start, end}``) so the sensors can consume it directly.
"""

from __future__ import annotations

from typing import Any

import httpx

from harness.sensors.base import NEREntity


class NlpServiceError(RuntimeError):
    """The NLP service was unreachable or returned a non-2xx response."""


class NlpClient:
    """Thin async client for the NLP token-classification (NER) endpoint."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def classify_tokens(
        self,
        text: str,
        *,
        language: str = "en",
        aggregation_strategy: str = "simple",
    ) -> list[NEREntity]:
        """Extract medical entities from ``text`` and map them to ``NEREntity``."""
        url = f"{self._base_url}/api/v1/classify/tokens"
        body = {
            "text": text,
            "aggregation_strategy": aggregation_strategy,
            "language": language,
        }
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(url, json=body)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise NlpServiceError(f"nlp classify/tokens failed: {exc}") from exc
            data = resp.json()
        return [self._to_entity(e) for e in data.get("entities", [])]

    @staticmethod
    def _to_entity(raw: dict[str, Any]) -> NEREntity:
        position = raw.get("position") or {}
        return NEREntity(
            text=raw.get("text", ""),
            type=raw.get("entity_type", ""),
            start=int(position.get("start", -1)),
            end=int(position.get("end", -1)),
        )
