"""The single place an adapter learns WHERE to connect and WITH WHAT.

`apps/text` holds no provider connection config. Every endpoint, credential,
region and routing pair arrives per request as a `ProviderOverride` the gateway
resolved through the tenant → SYSTEM cascade, with ``funding`` DERIVED from
whichever row supplied it (`.claude/rules/09-infrastructure-devops.md` §"Tenant-first
resolution & BYO"). This module is hop 7 of the F-01 seven-hop contract:

    **Consume, FAIL CLOSED.** Every adapter builds a REQUEST-SCOPED client (never
    mutates a shared one, so concurrent tenants cannot race); no injected
    connection ⇒ raise, never substitute.

Before TASK-799 lane B there was a second source: a process-wide
`TEXT_<PROVIDER>_BASE_URL` / `_ENDPOINT` / `_REGION` read from the environment.
That is exactly the shape §Configuration Principles forbids — a value no tenant
could override and no admin could change without a redeploy — and it is why a
keyless local engine looked "configured" while a BYO tenant's own endpoint had
nowhere to live. There is now one source, and its absence is an error rather than
a silent fallback.

## Operational consequence, stated plainly

A provider is reachable only when an `AiProviderConnection` row resolves for it —
the caller's own row, or the SYSTEM-tenant platform default. That includes the
self-hosted engines (LM Studio, Ollama, vLLM, llama.cpp, TEI): a platform admin
seeds a SYSTEM row carrying the engine's `baseUrl`. A row with no key injects on
NEITHER tier by design (it is what stops a `baseUrl` being mistaken for a
credential), so a self-host SYSTEM row must carry the keyless-local placeholder
its engine expects rather than be left blank.
"""

from __future__ import annotations

from text.core.exceptions import ProviderConnectionMissingError, ProviderCredentialsError
from text.models.requests import ProviderOverride


def resolve_connection(request: object) -> ProviderOverride | None:
    """The connection the gateway injected for THIS request's provider, if any.

    Keyed by ``request.provider`` so only the entry for the SELECTED provider is
    ever read — the gateway forwards only that one (minimal exposure), and a
    request that somehow carried more must not be able to cross-wire them.
    """
    overrides = getattr(request, "provider_overrides", None)
    if not isinstance(overrides, dict) or not overrides:
        return None
    provider = getattr(request, "provider", None)
    if not isinstance(provider, str) or not provider:
        return None
    resolved = overrides.get(provider)
    return resolved if isinstance(resolved, ProviderOverride) else None


def require_connection(request: object, *, provider: str) -> ProviderOverride:
    """The injected connection, or a typed 503.

    The message names the row that is missing rather than the variable that used
    to be unset, because the fix is now an administrative action and the operator
    needs to know which one.
    """
    connection = resolve_connection(request)
    if connection is None:
        raise ProviderConnectionMissingError(
            f"No provider connection resolved for '{provider}'. Text holds no "
            "endpoint or credential of its own: an AiProviderConnection row must "
            "exist for this tenant or for the SYSTEM tenant, be ENABLED, and "
            "carry a key. See .claude/rules/09-infrastructure-devops.md "
            "§'Tenant-first resolution & BYO'.",
            provider=provider,
        )
    return connection


def require_api_key(request: object, *, provider: str) -> str:
    """The vendor credential for a BYOK provider, or a typed 503.

    Never falls back to an ambient SDK credential chain: `boto3.client(...)` and
    `genai.Client(...)` without an explicit credential authenticate from the
    process environment, which is why deleting a pydantic field alone could never
    close this hole (F-01).
    """
    connection = require_connection(request, provider=provider)
    key = connection.api_key.get_secret_value()
    if not key:
        raise ProviderCredentialsError(
            f"No credential for provider '{provider}': the resolved "
            "AiProviderConnection row carries no key, and there is no platform "
            "or environment fallback.",
            provider=provider,
        )
    return key


def require_base_url(request: object, *, provider: str) -> str:
    """The engine endpoint for a self-hosted provider, or a typed 503."""
    connection = require_connection(request, provider=provider)
    base_url = (connection.base_url or "").strip()
    if not base_url:
        raise ProviderConnectionMissingError(
            f"No base_url for provider '{provider}': the resolved "
            "AiProviderConnection row carries no endpoint.",
            provider=provider,
        )
    return base_url.rstrip("/")
