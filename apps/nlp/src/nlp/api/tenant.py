"""Inbound tenant attribution — the header and the body must agree.

`apps/nlp` receives its tenant in the request BODY (the gateway and its peer
callers inject it there alongside the resolved model selection), and its peers
ALSO send the canonical `X-Tenant-Id` header — `apps/guardrail`'s
`external_nlp_client` sets both from the same value.

Nothing read the header, so a caller sending header `A` with body `B` was
accepted and every attributable record followed `B`. Guardrail decisions must
be attributable (owner directive 2026-08-16), and two disagreeing claims about
whose work this is cannot both be true, so the request is refused rather than
silently resolved in favour of one of them.

This is a DISAGREEMENT check, not a second mandatory header: absence of the
header is the caller's business and is enforced upstream, so a body
tenant with no header is unchanged.
"""

from __future__ import annotations

from fastapi import HTTPException

TENANT_HEADER = "X-Tenant-Id"


def assert_tenant_matches_header(body_tenant: str | None, header_tenant: str | None) -> None:
    """Refuse a request whose header and body name DIFFERENT tenants.

    400, not 403 or 428: the request contradicts itself. It is neither a
    privilege decision nor a missing precondition — there is no tenant this
    request can be attributed to.
    """
    header = (header_tenant or "").strip()
    body = (body_tenant or "").strip()
    if header and body and header != body:
        raise HTTPException(
            status_code=400,
            detail=(
                f"tenant mismatch: {TENANT_HEADER} and the request body name different "
                "tenants. The caller must send one tenant identity, not two."
            ),
        )
