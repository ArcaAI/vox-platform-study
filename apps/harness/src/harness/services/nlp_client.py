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

        tenant_id is MANDATORY : NER model selection is per-tenant
        (the `nlp.ner` `AiRoutingPolicy` row), so a dropped tenant silently runs someone
        else's model choice. Tenant-less internal work must declare itself with a
        ``tenantless:<reason>`` marker instead of omitting the header.
        """
        if not tenant_id or not tenant_id.strip():
            raise ValueError(
                "nlp classify_tokens requires a tenant_id : pass the "
                "consultation's tenant, or an explicit 'tenantless:<reason>' marker."
            )
        data = await self.classify_tokens_raw(
            text,
            tenant_id=tenant_id,
            language=language,
            aggregation_strategy=aggregation_strategy,
        )
        return [self._to_entity(e) for e in data.get("entities", [])]

    async def classify_tokens_raw(
        self,
        text: str,
        *,
        tenant_id: str,
        model_name: str | None = None,
        model_path: str | None = None,
        labels: list[str] | None = None,
        threshold: float | None = None,
        language: str = "en",
        aggregation_strategy: str | None = None,
    ) -> dict[str, Any]:
        """The RAW ``TokenClassificationResponse`` (``entities``, ``model_version``, ``vitals``).

        F13 — `core.classify` needs each span's own ``entity_type``/``confidence``/offsets to map
        a TOKEN_CLASSIFICATION model onto its declared classes, which the :class:`NEREntity`
        projection above drops. ``model_name``/``model_path`` are the registry row's
        ``sourceUri``/``localPath`` the gateway resolved — the NLP service fails closed (503)
        without a model, and this client never invents one. Both are omitted when absent so the
        NER sensors' body stays byte-identical to what it always sent.

        F14 — ``labels``/``threshold`` are the OPEN taxonomy a `gliner2` EXTRACTOR
        checkpoint needs: it carries no label set of its own, so `apps/nlp` fails closed
        (503) without one and never invents a default. The CALLER resolves them (the node's
        declared labels, else the registry row's ``labelTaxonomy``). Both are omitted when
        absent, so a closed-taxonomy checkpoint — whose labels ARE its own — keeps the body
        it has always received.
        """
        if not tenant_id or not tenant_id.strip():
            raise ValueError(
                "nlp classify_tokens requires a tenant_id : pass the "
                "consultation's tenant, or an explicit 'tenantless:<reason>' marker."
            )
        url = f"{self._base_url}/api/v1/classify/tokens"
        body: dict[str, Any] = {"text": text}
        if aggregation_strategy is not None:
            body["aggregation_strategy"] = aggregation_strategy
        body["language"] = language
        if model_name:
            body["model_name"] = model_name
        if model_path:
            body["model_path"] = model_path
        if labels:
            body["labels"] = labels
        if threshold is not None:
            body["threshold"] = threshold
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
        return data if isinstance(data, dict) else {}

    async def classify_text(
        self,
        text: str,
        *,
        tenant_id: str,
        model_name: str,
        model_path: str | None = None,
        language: str = "en",
    ) -> dict[str, Any]:
        """TASK-864 `core.classify` -> ``POST /api/v1/classify/text`` (single-label).

        Returns the raw ``TextClassificationResponse`` dict (``predicted_label``, ``confidence``,
        ``probabilities``, ``model_version``). ``model_name``/``model_path`` are the registry
        row's ``sourceUri``/``localPath`` the gateway resolved — the NLP service fails closed
        (503) without a model, and this client never invents one.
        """
        if not tenant_id or not tenant_id.strip():
            raise ValueError("nlp classify_text requires a tenant_id")
        url = f"{self._base_url}/api/v1/classify/text"
        body: dict[str, Any] = {"text": text, "language": language, "model_name": model_name}
        if model_path:
            body["model_path"] = model_path
        headers: dict[str, str] = {"X-Tenant-Id": tenant_id.strip()}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise NlpServiceError(f"nlp classify/text failed: {exc}") from exc
            return resp.json()  # type: ignore[no-any-return]

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
