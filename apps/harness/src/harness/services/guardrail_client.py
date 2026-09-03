"""Guardrail service client — direct peer call to apps/guardrail.

Mirrors ``text_client.py``'s shape (thin async ``httpx`` client, one method per endpoint used).
Unlike Text, this is the harness's FIRST direct call into ``apps/guardrail`` — no prior client
existed (the harness's own "guardrail" concept, ``harness/temporal/activities.py``'s groundedness/
safety/citation-verify/atomic-fact sensors, is a locally-computed clinical assurance pass, not a
call to this service). Rule `.claude/rules/06-python-services.md` §Gateway Integration sanctions
this as the established peer-client pattern (``nlp/services/external_text_client.py``,
``text/services/external_guardrail.py``): ``X-Service-Token`` + **mandatory** ``X-Tenant-Id``
( owner directive — a tenant-scoped internal call with no tenant header is a caller bug,
not something the callee should paper over).

Fail-closed posture ( / N-4 contract): apps/guardrail's own
``POST /guardrail/analyze`` fails OPEN (``safe=True``) on an internal exception
(``guardrails.py:96-105``) — a deliberate, documented posture for THAT service, but one this
client's caller (the ``guardrail.check`` node activity) must never inherit. This client surfaces
the raw ``GuardrailAnalysis`` (including a non-null ``error`` alongside ``safe=True``) rather than
collapsing it — the node activity is what decides "no verdict" vs "pass", per rule.
A TRANSPORT failure (guardrail unreachable, non-2xx, timeout) raises ``GuardrailServiceError``
instead of ever synthesizing a fake `safe=True` result — this client does not repeat guardrail's
own fail-open branch for a failure guardrail never even got to run.

redact (consultation.phiHop's compile target) calls the SEPARATE
``POST /guardrail/redact`` endpoint (``apps/guardrail/src/guardrail/api/endpoints/redact.py:267``)
shipped — genuinely FAIL-CLOSED on that service's own side (a runtime extraction error is
a 502, never a 200 echoing unredacted text; a missing model selection is 503), the opposite of
``/guardrail/analyze``'s legacy fail-open posture. This client does not soften either: any
transport/HTTP failure raises ``GuardrailServiceError``, exactly like ``analyze()``.
"""

from __future__ import annotations

import httpx
from pydantic import BaseModel, ConfigDict, Field

#: Path prefix apps/guardrail mounts its analyze/redact routes under. Both call sites here
#: previously omitted the `/api` segment and therefore addressed paths the service does not
#: route: `/guardrail/analyze` and `/guardrail/redact` both answer 404, while
#: `/api/guardrail/analyze` and `/api/guardrail/redact` reach the handlers (422 on an empty body).
#: Observed on a live run — `guardrail.check` DEGRADED with "guardrail analyze failed: Client
#: error '404 Not Found'", which then starved `output.deliver` of bound content. Kept as one
#: constant so the two methods cannot drift apart again.
_GUARDRAIL_PREFIX = "/api/guardrail"

#: The bidirectional SCREENING routes are mounted under a DIFFERENT prefix from
#: analyze/redact — `apps/guardrail/src/guardrail/main.py` includes the screen router at
#: `/api/v1` while medical/guardrails/redact are at `/api`. Kept as its own constant for
#: exactly the reason `_GUARDRAIL_PREFIX` is: a path guessed from a sibling route 404s.
_SCREEN_PREFIX = "/api/v1/guardrail/screen"


class GuardrailServiceError(RuntimeError):
    """The guardrail service was unreachable, timed out, or returned a non-2xx response."""


class RedactEntity(BaseModel):
    """One masked PII span — mirrors guardrail's `RedactEntityModel`."""

    model_config = ConfigDict(extra="ignore")

    label: str = ""
    start: int = 0
    end: int = 0
    score: float = 0.0


class RedactResult(BaseModel):
    """Parsed `RedactResponse` (`apps/guardrail/.../redact.py:171`)."""

    model_config = ConfigDict(extra="ignore")

    sanitized_text: str
    entities: list[RedactEntity] = []
    mode: str = ""
    request_id: str = ""
    timestamp: str = ""


class ScreenCheck(BaseModel):
    """One screening check — mirrors guardrail's `CheckOutcome.to_dict()`.

    `outcome` is one of `pass` | `flag` | `skipped` | `undetermined`. The distinction
    between the last two is load-bearing and must never be collapsed: `skipped` means
    the check DELIBERATELY did not run (its input was absent), `undetermined` means it
    COULD NOT run (the backend was unavailable). See `GuardrailSafetyScreen`.
    """

    model_config = ConfigDict(extra="ignore")

    name: str
    outcome: str
    fail_mode: str = Field(default="", alias="failMode")
    model: str = ""
    reason: str = ""
    labels: list[str] = []


class ScreenResult(BaseModel):
    """Parsed `ScreenResponse` (`apps/guardrail/.../api/endpoints/screen.py:68`).

    Carries the ATTRIBUTION the legacy `{safe, issues, confidence}` shape cannot: which
    tenant's policy decided, which config tier supplied it, and — per check — what ran,
    with which model, under which declared fail mode.
    """

    model_config = ConfigDict(extra="ignore")

    decision: str
    direction: str = ""
    reasons: list[str] = []
    checks: list[ScreenCheck] = []
    tenant_id: str = ""
    policy_source_tenant_id: str | None = None


class GuardrailAnalysis(BaseModel):
    """Parsed ``GuardrailResponse`` (``apps/guardrail/src/guardrail/api/endpoints/guardrails.py``).

    ``error`` non-null alongside ``safe=True`` is guardrail's OWN fail-open signal for a runtime
    exception — never treat that combination as a pass (see the module docstring).
    """

    model_config = ConfigDict(extra="ignore")

    safe: bool
    issues: list[str] = []
    confidence: float = 0.0
    processing_time_ms: float = 0.0
    request_id: str = ""
    timestamp: str = ""
    error: str | None = None


class GuardrailClient:
    """Thin async client for ``POST /guardrail/analyze``."""

    def __init__(
        self,
        base_url: str,
        *,
        service_token: str,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._timeout = timeout
        self._transport = transport

    async def analyze(
        self,
        *,
        text: str,
        tenant_id: str,
        guardrail_type: str = "comprehensive",
        request_id: str | None = None,
    ) -> GuardrailAnalysis:
        """Analyze ``text`` for safety issues. Raises :class:`GuardrailServiceError` on any
        transport/HTTP failure — never returns a synthesized result for one (see module doc)."""
        url = f"{self._base_url}{_GUARDRAIL_PREFIX}/analyze"
        body: dict[str, object] = {"text": text, "guardrail_type": guardrail_type}
        if request_id:
            body["request_id"] = request_id
        headers = {
            # Empty token = dev-mode bypass on the guardrail side (rule 06); presented
            # unconditionally so a configured token is always honoured.
            "X-Service-Token": self._service_token,
            # mandatory on every tenant-scoped internal service call.
            "X-Tenant-Id": tenant_id,
        }
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout
            ) as client:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            raise GuardrailServiceError(f"guardrail analyze failed: {exc}") from exc
        return GuardrailAnalysis.model_validate(data)

    async def screen_outbound(
        self,
        *,
        response: str,
        tenant_id: str,
        source_context: str | None = None,
        nonce: str | None = None,
    ) -> ScreenResult:
        """Screen a model response before it reaches a clinician.

        The delegation target for the harness safety sensor ( A.1 / F-02).
        `apps/guardrail` owns the safety POLICY, the label taxonomy and the tenant
        cascade, and delegates the ENGINE to text/nlp — which is precisely what
        harness must not do for itself.

        Unlike `analyze()`, this route has NO fail-open branch on guardrail's side: a
        check that could not run yields `outcome="undetermined"` and the decision is
        `block`, and an unhandled error is a 503, never a 200 reporting "allow". This
        client does not soften either — any transport/HTTP failure raises
        :class:`GuardrailServiceError`.
        """
        url = f"{self._base_url}{_SCREEN_PREFIX}/outbound"
        body: dict[str, object] = {"response": response}
        if source_context is not None:
            body["source_context"] = source_context
        if nonce is not None:
            body["nonce"] = nonce
        headers = {
            "X-Service-Token": self._service_token,
            # mandatory on every tenant-scoped internal service call. Guardrail
            # answers 428 without it — a screening decision must be attributable.
            "X-Tenant-Id": tenant_id,
        }
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout
            ) as client:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            raise GuardrailServiceError(f"guardrail outbound screen failed: {exc}") from exc
        return ScreenResult.model_validate(data)

    async def redact(
        self,
        *,
        text: str,
        mode: str,
        tenant_id: str,
        request_id: str | None = None,
    ) -> RedactResult:
        """Sanitize `text` per `mode` (`'pseudonymize'` or `'full'`). Raises
        :class:`GuardrailServiceError` on ANY transport/HTTP failure — never returns a
        synthesized/unredacted result for one (see module doc; mirrors `analyze()`)."""
        url = f"{self._base_url}{_GUARDRAIL_PREFIX}/redact"
        body: dict[str, object] = {"text": text, "mode": mode}
        if request_id:
            body["request_id"] = request_id
        headers = {
            "X-Service-Token": self._service_token,
            # mandatory on every tenant-scoped internal service call.
            "X-Tenant-Id": tenant_id,
        }
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout
            ) as client:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            raise GuardrailServiceError(f"guardrail redact failed: {exc}") from exc
        return RedactResult.model_validate(data)
