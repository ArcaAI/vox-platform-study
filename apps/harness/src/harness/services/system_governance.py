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

import hashlib
from collections.abc import Mapping
from typing import Any, Protocol

import structlog

from harness.services.api_client import ApiServiceError
from harness.services.guardrail_client import GuardrailClient, GuardrailServiceError
from harness.temporal.interpreter.compose_messages import output_language_step, platform_rules

_LOGGER = structlog.get_logger(__name__)

#: The pieces the gateway stamps on an agent at publish (``compiledConfig.governance``). PLATFORM /
#: LANGUAGE / CONTRACT pieces are platform-owned and are confirmed by the gateway's verify route.
_INSTRUCTION_KINDS = frozenset({"TEMPLATE_BODY", "FRAGMENT"})


def build_system_governance(
    composed: Mapping[str, Any] | None,
    compiled: Mapping[str, Any] | None,
    current_policy_version: str | None,
) -> dict[str, Any] | None:
    """The FC-4 ``system_governance`` body, or ``None`` when any condition does not hold.

    Instruction pieces must be among the stamped digests; the platform-owned pieces are NOT in the
    stamp and are confirmed separately by :class:`GovernanceVerifier` — a caller must consult it
    before sending what this returns."""
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
    if any(
        not isinstance(p, Mapping)
        or (p.get("kind") in _INSTRUCTION_KINDS and p.get("digest") not in known)
        for p in pieces
    ):
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


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def non_instruction_pieces(composed: Mapping[str, Any]) -> list[dict[str, str]]:
    """``{kind, key, digest, text}`` for the platform-owned pieces whose static text this process can
    reconstruct (platform rules, the output-language sentence). A piece whose reconstruction does not
    hash to the composed digest is dropped — nothing is offered for registration that was not the
    text the composer actually emitted. The ``core.agent`` lane has no CONTRACT layer."""
    out: list[dict[str, str]] = []
    for piece in composed.get("pieces") or []:
        if not isinstance(piece, Mapping):
            continue
        kind, key, digest = piece.get("kind"), piece.get("key"), piece.get("digest")
        text: str | None = None
        if kind == "PLATFORM":
            text = platform_rules()
        elif kind == "LANGUAGE" and isinstance(key, str) and key.startswith("language:"):
            text = output_language_step(key[len("language:") :])
        if text and isinstance(digest, str) and _sha256(text) == digest and isinstance(key, str):
            out.append({"kind": str(kind), "key": key, "digest": digest, "text": text})
    return out


class _GovernedPromptsApi(Protocol):
    async def verify_governed_prompts(
        self, *, tenant_id: str, digests: list[str], pieces: list[dict[str, str]] | None
    ) -> dict[str, Any]: ...


class GovernanceVerifier:
    """The gateway's verdict on a composed prompt's whole digest set, asked at most once per
    ``(tenant, frozenset(digests))`` for the life of the verifier (one activity). Any failure is
    remembered as "not governed" — the safe direction: apps/text then screens the prompt itself."""

    def __init__(self, api: _GovernedPromptsApi, tenant_id: str) -> None:
        self._api = api
        self._tenant_id = tenant_id
        self._cache: dict[tuple[str, frozenset[str]], tuple[bool, str | None]] = {}

    async def verify(self, composed: Mapping[str, Any]) -> tuple[bool, str | None]:
        digests = [
            p["digest"]
            for p in composed.get("pieces") or []
            if isinstance(p, Mapping) and isinstance(p.get("digest"), str)
        ]
        unique = list(dict.fromkeys(digests))[:64]
        if not unique:
            return (False, None)
        key = (self._tenant_id, frozenset(unique))
        if key not in self._cache:
            self._cache[key] = await self._ask(composed, unique)
        return self._cache[key]

    async def _ask(
        self, composed: Mapping[str, Any], digests: list[str]
    ) -> tuple[bool, str | None]:
        try:
            answer = await self._api.verify_governed_prompts(
                tenant_id=self._tenant_id,
                digests=digests,
                pieces=non_instruction_pieces(composed) or None,
            )
        except ApiServiceError:
            _LOGGER.warning("harness.governed_prompt_verify_failed")
            return (False, None)
        version = answer.get("policyVersion")
        return (
            answer.get("governed") is True and isinstance(version, str),
            version if isinstance(version, str) else None,
        )
