"""TASK-1047 FC-6 — when the harness may tell apps/text its system prompt is GOVERNED.

apps/text treats a system prompt as governed (already screened at authoring time) only when the
caller sends ``system_governance``. The harness sends it ONLY when every piece digest the Python
composer reported is among the digests the gateway stamped on the agent
(``compiledConfig.governance.pieceDigests``) under the SAME ``policyVersion`` guardrail reports
now. Any gap — no governance, no stamp, a digest missing, a stale version, a failed version
fetch — omits the field, which is the safe direction: apps/text then screens the prompt itself.

Everything here runs in activities, never in workflow code (the version fetch is I/O).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from harness.services.guardrail_client import GuardrailClient, GuardrailServiceError


def build_system_governance(
    composed: Mapping[str, Any] | None,
    compiled: Mapping[str, Any] | None,
    current_policy_version: str | None,
) -> dict[str, Any] | None:
    """The FC-4 ``system_governance`` body, or ``None`` when any condition does not hold."""
    if not composed or not compiled or not current_policy_version:
        return None
    pieces = composed.get("pieces")
    composed_digest = composed.get("composed_digest")
    if not isinstance(pieces, list) or not pieces or not composed_digest:
        return None
    if compiled.get("policyVersion") != current_policy_version:
        return None
    stamped = compiled.get("pieceDigests")
    if not isinstance(stamped, list):
        return None
    known = set(stamped)
    if any(not isinstance(p, Mapping) or p.get("digest") not in known for p in pieces):
        return None
    return {
        "composed_digest": composed_digest,
        "pieces": [dict(p) for p in pieces],
        "policy_version": current_policy_version,
    }


class PolicyVersionProbe:
    """Guardrail's current policy version, fetched at most once for the life of the probe
    (one activity call path). A failed fetch is remembered as ``None`` — never retried here."""

    def __init__(self, client: GuardrailClient, tenant_id: str) -> None:
        self._client = client
        self._tenant_id = tenant_id
        self._done = False
        self._value: str | None = None

    async def get(self) -> str | None:
        if not self._done:
            self._done = True
            try:
                self._value = await self._client.policy_version(tenant_id=self._tenant_id)
            except GuardrailServiceError:
                self._value = None
        return self._value
