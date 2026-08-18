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
        service_token: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._service_token = service_token
        self._transport = transport

    async def classify_tokens(
        self,
        text: str,
        *,
        tenant_id: str,
        language: str = "en",
        aggregation_strategy: str = "simple",
    ) -> list[NEREntity]:
        """Extract medical entities from ``text`` and map them to ``NEREntity``.

        ``tenant_id`` is MANDATORY (TASK-737): NER model selection is per-tenant
        (`nlp.ner` `AiTaskDefault`), so a dropped tenant silently runs someone
        else's model choice. Tenant-less internal work must declare itself with a
        ``tenantless:<reason>`` marker instead of omitting the header.
        """
        if not tenant_id or not tenant_id.strip():
            raise ValueError(
                "nlp classify_tokens requires a tenant_id (TASK-737): pass the "
                "consultation's tenant, or an explicit 'tenantless:<reason>' marker."
            )
        url = f"{self._base_url}/api/v1/classify/tokens"
        body = {
            "text": text,
            "aggregation_strategy": aggregation_strategy,
            "language": language,
        }
        # NLP's ServiceAuthMiddleware requires X-Service-Token whenever NLP_SERVICE_TOKEN
        # is configured — omitted when unset so local dev-bypass keeps working.
        headers: dict[str, str] = {"X-Tenant-Id": tenant_id.strip()}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(url, json=body, headers=headers)
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
            # Carry the NLP-resolved ontology codes through so the
            # persisted NamedEntity rows are coded (nullable when un-resolved).
            umls_cui=raw.get("umls_cui"),
            snomed_code=raw.get("snomed_code"),
            rxnorm_code=raw.get("rxnorm_code"),
            icd_code=raw.get("icd_code"),
            loinc_code=raw.get("loinc_code"),
            # carry the assertion polarity so it reaches the sensors
            # and the persisted NamedEntity rows (None ⇒ PRESENT default).
            assertion=raw.get("assertion"),
        )
