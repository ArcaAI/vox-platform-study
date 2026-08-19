"""Peer client for `apps/nlp` — guardrail's classification/NER executor.

TASK-735 Phases 3 & 6. `apps/guardrail` used to host a GLiNER ONNX runtime and a
MiniCheck GGUF scorer. Both moved to `apps/nlp`, which already owns NER and
token/text classification (rule 06: "a service that needs NER / token- or
text-classification calls `apps/nlp`"). Guardrail keeps POLICY — which taxonomy,
which thresholds, the verdict shape, the fail posture — and calls this client.

Wire contract (per rule 06's peer-client shape):

* ``X-Service-Token`` — the shared internal credential;
* ``X-Tenant-Id`` — **MANDATORY**. This client REFUSES TO CONSTRUCT without one,
  so an unattributable safety decision cannot be made at all. A genuinely
  tenant-less caller declares ``tenantless:<reason>``;
* a bounded retry budget owned HERE (guardrail decides how long a safety check
  may take), not by `apps/nlp`;
* a DECLARED fail posture — see below.

**Fail posture.** Every method RAISES :class:`GuardrailUndeterminedError` on an
exhausted budget. That is the correct posture for both of the shapes rule 06
distinguishes:

* a *moderation verdict* has a safe default, and guardrail's routes already turn
  this exception into 503 (single-item) or ``safe=false, issues=["undetermined"]``
  (batch) — fail-CLOSED, never ``safe: true``;
* a *generated label* — a PII span set, an entailment score — must never be
  FABRICATED. An empty span list would read as "no PII found" and a substituted
  score would read as "grounded"; both are silently wrong, so neither is ever
  synthesised here.

Guardrail forwards no vendor credential of its own: there is deliberately no
``api_key`` parameter (BYOK posture, Phase 5).
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.core.logging import get_logger

logger = get_logger(__name__)

PII_PATH = "/api/v1/guard/pii"
CLASSIFY_PATH = "/api/v1/guard/classify"
ENTAILMENT_PATH = "/api/v1/guard/entailment"


@dataclass(frozen=True)
class PiiSpan:
    """One PII span in DOCUMENT coordinates of the text that was submitted."""

    label: str
    start: int
    end: int
    score: float


class NlpGuardClient:
    """One tenant's bound view of `apps/nlp`'s guard surface."""

    def __init__(
        self,
        *,
        base_url: str,
        service_token: str,
        http_client: httpx.AsyncClient,
        tenant_id: str,
        model_id: str = "",
        model_path: str | None = None,
        labels: list[str] | None = None,
        threshold: float = 0.5,
        timeout_s: float = 60.0,
        max_attempts: int = 2,
        retry_backoff_s: float = 0.1,
    ) -> None:
        # Attribution is a CONSTRUCTION-time invariant, not a per-call check:
        # there is no way to obtain this client and then make an unattributable
        # call with it.
        if not (tenant_id or "").strip():
            raise ValueError(
                "NlpGuardClient requires a tenant: guardrail decisions must be "
                "attributable (owner directive 2026-08-16). Declare "
                "'tenantless:<reason>' for genuinely tenant-less internal work."
            )

        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._http = http_client
        self._tenant_id = tenant_id
        self.model_id = model_id
        self.model_path = model_path
        self.labels = labels or []
        self.threshold = threshold
        self._timeout_s = timeout_s
        self._max_attempts = max(1, max_attempts)
        self._retry_backoff_s = retry_backoff_s

    # ── transport ────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        headers = {"X-Tenant-Id": self._tenant_id}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        return headers

    async def _post(
        self, path: str, payload: dict[str, Any], what: str
    ) -> dict[str, Any]:
        """One bounded, retried POST. Raises rather than returning a fabricated result."""
        body = {**payload, "tenant_id": self._tenant_id}
        if self.model_id:
            body["model_name"] = self.model_id
        if self.model_path:
            body["model_path"] = self.model_path

        last_error = ""
        for attempt in range(self._max_attempts):
            try:
                response = await self._http.post(
                    f"{self._base_url}{path}",
                    json=body,
                    headers=self._headers(),
                    timeout=self._timeout_s,
                )
                if response.status_code < 400:
                    result = response.json()
                    return result if isinstance(result, dict) else {}
                last_error = f"HTTP {response.status_code}"
                # 4xx that is not a transient overload is not worth retrying —
                # a rejected request will be rejected identically next time.
                if 400 <= response.status_code < 500 and response.status_code != 429:
                    break
            except (
                Exception
            ) as exc:  # noqa: BLE001 — every transport failure is fail-closed
                last_error = f"{type(exc).__name__}"

            if attempt + 1 < self._max_attempts and self._retry_backoff_s > 0:
                await asyncio.sleep(self._retry_backoff_s * (attempt + 1))

        # PHI-safe: the error string carries no request text.
        logger.error(f"guardrail.nlp_delegation.failed what={what} error={last_error}")
        raise GuardrailUndeterminedError(
            REASON_ENGINE_ERROR,
            f"apps/nlp {what} delegation failed ({last_error}) — refusing to fabricate a result",
        )

    # ── the three delegated capabilities ─────────────────────────────────

    async def extract_pii_entities(self, text: str) -> list[PiiSpan]:
        """PII spans in the coordinates of `text`. NEVER an empty list on error."""
        payload = await self._post(
            PII_PATH,
            {"text": text, "labels": self.labels, "threshold": self.threshold},
            "pii",
        )
        spans: list[PiiSpan] = []
        for entity in payload.get("entities") or []:
            try:
                spans.append(
                    PiiSpan(
                        label=str(entity["label"]),
                        start=int(entity["start"]),
                        end=int(entity["end"]),
                        score=float(entity.get("score", 0.0)),
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                # A span we cannot trust the offsets of would corrupt the mask.
                raise GuardrailUndeterminedError(
                    REASON_ENGINE_ERROR,
                    "apps/nlp returned a PII span without usable offsets",
                ) from exc
        return spans

    async def classify(self, tasks: dict[str, Any], text: str) -> dict[str, Any]:
        """Run the caller's moderation task schema; return only what nlp answered."""
        payload = await self._post(
            CLASSIFY_PATH, {"text": text, "tasks": tasks}, "classify"
        )
        results = payload.get("results")
        return results if isinstance(results, dict) else {}

    async def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> list[float]:
        """The `NliScorer` seam's spelling (`services/groundedness_nli.py`)."""
        return await self.score_entailment(list(pairs))

    async def score_entailment(self, pairs: list[tuple[str, str]]) -> list[float]:
        """`P(claim entailed by document)` per pair, in order."""
        if not pairs:
            return []
        payload = await self._post(
            ENTAILMENT_PATH,
            {"pairs": [{"document": doc, "claim": claim} for doc, claim in pairs]},
            "entailment",
        )
        scores = payload.get("scores")
        if not isinstance(scores, list) or len(scores) != len(pairs):
            raise GuardrailUndeterminedError(
                REASON_ENGINE_ERROR,
                "apps/nlp returned an entailment score count that does not match the request",
            )
        return [float(score) for score in scores]
