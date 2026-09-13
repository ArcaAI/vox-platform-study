"""apps/nlp's peer-service client to `text`.

This is apps/nlp's FIRST outbound call to a peer AI service — every prior
`httpx` call site targets the gateway (`lifespan.py`'s fire-and-forget
self-registration, `core/effective_config.py`'s control-plane pull), never a
peer AI service directly. Mirrors `apps/text`'s `ExternalGuardrailClient`
class shape (constructor takes settings + an injected `httpx.AsyncClient`,
`X-Service-Token` attached, bounded retry with linear backoff) — used by
`nlp.topic`/`nlp.intent` to delegate open-taxonomy labeling to a real LLM
call via `text`'s `/generate` endpoint.

Fail posture DIFFERS from `ExternalGuardrailClient` deliberately: guardrail's
fail-closed return value (`allowed: False`) is a genuine SAFE DEFAULT for a
moderation verdict. There is no equivalent safe default for a generated
LABEL — silently returning an empty string or a guessed label would corrupt
the caller's response the exact way a `predicted_label` should never be
fabricated. So a sustained outage RAISES `ExternalTextUnavailableError`
(mapped to HTTP 503 by the calling endpoint), never returns a placeholder.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from nlp.core.config import ExternalTextConfig
from nlp.core.logging import get_logger

logger = get_logger(__name__)


class ExternalTextUnavailableError(Exception):
    """Raised when `text` is unreachable after the bounded retry budget, or
    returns a response with no usable generated content."""


@dataclass(frozen=True)
class GeneratedLabel:
    """One delegated generation: the label, and what it COST (TASK-957 F-7b).

    `nlp.topic` / `nlp.intent` run no local model — they spend a real LLM call
    on `apps/text`, which answers with the same `usage_detail` (and
    `guardrail_usage`) block every other TEXT caller bills from. This client
    read `content` and threw the rest away, so the only consumer of those two
    routes had nothing to record and the spend went unbilled.

    Both blocks are carried VERBATIM: the gateway already owns one parser for
    that wire shape, and a second interpretation here is a second place for the
    cache / reasoning split to be lost. `None` means the service reported none —
    a different fact from an empty block, and never collapsed into one.
    """

    label: str
    usage_detail: dict[str, Any] | None = None
    guardrail_usage: dict[str, Any] | None = None


class ExternalTextClient:
    """Calls the `text` service's `/generate` endpoint for open-taxonomy
    topic/intent labeling (`nlp.topic` / `nlp.intent`)."""

    def __init__(
        self,
        *,
        settings: ExternalTextConfig,
        http_client: httpx.AsyncClient,
        service_token: str | None = None,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.base_url = settings.base_url.rstrip("/")
        # Owner decision D-D (2026-08-17): the caller resolves the ONE shared
        # `INTERNAL_ACCESS_TOKEN` and passes it here. The legacy per-pair
        # `NLP_EXTERNAL_TEXT_SERVICE_TOKEN` fallback is gone
        # the migration it covered is complete, and a second accepted credential
        # is a second thing to rotate. `None` ⇒ no header, which is the
        # dev / hermetic-CI bypass the middleware already recognises.
        self._service_token = service_token or ""

    async def generate_label(
        self,
        prompt: str,
        system_prompt: str | None = None,
        *,
        tenant_id: str,
    ) -> str:
        """Post `prompt` to `text`'s `/generate` and return the generated
        label (the response's `content`, stripped). Raises
        `ExternalTextUnavailableError` when the retry budget is exhausted or
        the response carries no usable content — never guesses a label.

        The narrow accessor over :meth:`generate_label_with_usage`, kept for
        callers that have no billing plane to feed."""
        return (
            await self.generate_label_with_usage(prompt, system_prompt, tenant_id=tenant_id)
        ).label

    async def generate_label_with_usage(
        self,
        prompt: str,
        system_prompt: str | None = None,
        *,
        tenant_id: str,
    ) -> GeneratedLabel:
        """The same call as :meth:`generate_label`, also returning what it cost
        (TASK-957 F-7b — see :class:`GeneratedLabel`)."""
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        # MANDATORY, and keyword-only above so it cannot be forgotten.
        # `text` resolves the tenant's BYOK provider/credential from this header and
        # derives funding/cost_basis from whichever tier supplied it, so a
        # silently-omitted tenant mis-configures AND mis-bills the call. The former
        # `if tenant_id:` guard made exactly that outcome invisible.
        # Tenant-less internal work declares itself with a `tenantless:<reason>`
        # marker; a blank value is a caller defect and raises.
        resolved_tenant = (tenant_id or "").strip()
        if not resolved_tenant:
            raise ValueError(
                "external text generate_label requires a tenant_id : the "
                "gateway must inject it, or the caller must declare "
                "'tenantless:<reason>'. An absent tenant is a caller defect."
            )
        headers["X-Tenant-Id"] = resolved_tenant

        body: dict[str, Any] = {"prompt": prompt, "stream": False}
        if system_prompt:
            body["system_prompt"] = system_prompt

        # Bounded retry, mirroring ExternalGuardrailClient: total tries =
        # max_retries + 1. A transient blip is absorbed; a sustained outage
        # exhausts the budget and raises below.
        attempts = self.settings.max_retries + 1
        last_error = ""
        for attempt in range(attempts):
            try:
                response = await self.http_client.post(
                    f"{self.base_url}/generate",
                    json=body,
                    headers=headers,
                    timeout=self.settings.timeout_s,
                )
                response.raise_for_status()
                payload = response.json()
                content = str(payload.get("content", "")).strip()
                if not content:
                    raise ExternalTextUnavailableError(
                        "text returned an empty generation — refusing to fabricate a label"
                    )
                return GeneratedLabel(
                    label=content,
                    usage_detail=_usage_block(payload.get("usage_detail")),
                    guardrail_usage=_usage_block(payload.get("guardrail_usage")),
                )
            except ExternalTextUnavailableError:
                raise
            except Exception as exc:
                last_error = str(exc)
                is_last = attempt + 1 >= attempts
                logger.warning(
                    "external_text.attempt_failed attempt=%d/%d error=%s base_url=%s will_retry=%s",
                    attempt + 1,
                    attempts,
                    last_error,
                    self.base_url,
                    not is_last,
                )
                if is_last:
                    break
                backoff_s = (self.settings.retry_backoff_ms / 1000.0) * (attempt + 1)
                if backoff_s > 0:
                    await asyncio.sleep(backoff_s)

        logger.error(
            "external_text.exhausted attempts=%d error=%s base_url=%s",
            attempts,
            last_error,
            self.base_url,
        )
        raise ExternalTextUnavailableError(
            f"text unreachable after {attempts} attempt(s): {last_error}"
        )


def _usage_block(value: Any) -> dict[str, Any] | None:
    """A usage block, or `None` — never a scalar and never an empty dict.

    Shape-checked rather than trusted: this is an unvalidated peer response, and
    anything but an object here would eventually reach a
    `forbidNonWhitelisted` DTO on the gateway. An EMPTY object is dropped too —
    it would parse downstream as "measured, and it was nothing", which is not
    what a service that reported no usage said.
    """
    return value if isinstance(value, dict) and value else None
