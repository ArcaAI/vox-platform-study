"""PHI egress chokepoint (TASK-357): enforce the fail-closed guard before cloud LLM calls.

The cloud-bound activities call exactly one of these helpers immediately before any
cloud LLM egress, so the fail-closed :class:`~harness.guards.phi.redactor.PhiRedactor`
is enforced at a single, replay-safe boundary rather than scattered across call sites:

* :func:`ensure_egress_safe` — gate a single string (the ``generate`` prompt /
  system prompt before the SMR call).
* :func:`ensure_inferential_egress_safe` — fan the gate across every cloud-bound
  field of the inferential pass (the Granite-screened note + the judge-bound
  transcript, per-claim hypotheses & evidence quotes, and knowledge chunks),
  redacting only the payload destined for a *cloud* consumer.

Both honour the **run-effective policy** snapshotted at workflow start
(``phi_enabled`` / ``phi_fail_closed``) instead of re-reading config, so enforcement
is deterministic across replay. The policy is passed as two booleans (not a temporal
``HarnessPolicy``) to keep ``guards/`` decoupled from ``temporal/``.

A :class:`~harness.guards.phi.redactor.PhiEgressBlocked` from the underlying guard
(fail-closed: redaction failed/unconfirmed, or the Presidio extra is missing on a
cloud run) propagates so the activity can act on it — block the cloud call and
degrade-closed; it is never swallowed into a silent unredacted egress.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from harness.guards.phi.redactor import PhiRedactor

if TYPE_CHECKING:  # pragma: no cover - typing only
    from harness.core.config import Settings


def ensure_egress_safe(
    text: str,
    *,
    provider: str | None,
    settings: Settings,
    phi_enabled: bool,
    phi_fail_closed: bool,
    redactor: PhiRedactor | None = None,
) -> str:
    """Clear ``text`` for egress to ``provider`` under the run-effective PHI policy.

    * ``phi_enabled`` False ⇒ pure bypass (the guard is disabled by policy);
    * ``provider`` None ⇒ no egress target ⇒ pass-through;
    * otherwise delegate to :meth:`PhiRedactor.ensure_safe_for_cloud` — a no-op for a
      local (non-cloud) provider, and a fail-closed redact+confirm for a cloud one
      (raising :class:`PhiEgressBlocked` when removal cannot be confirmed).

    ``phi_fail_closed`` is the snapshotted policy value; when it differs from
    ``settings.phi.fail_closed`` the settings are copied with the policy value so the
    guard honours the *effective* policy without mutating the shared settings. Pass
    ``redactor`` to reuse one lazily-built instance across an activity's calls.
    """
    if not phi_enabled or provider is None:
        return text

    redactor = redactor if redactor is not None else PhiRedactor()
    effective = settings
    if phi_fail_closed != settings.phi.fail_closed:
        effective = settings.model_copy(
            update={"phi": settings.phi.model_copy(update={"fail_closed": phi_fail_closed})}
        )
    return redactor.ensure_safe_for_cloud(text, provider=provider, settings=effective)


def ensure_inferential_egress_safe(
    *,
    note_text: str,
    transcript_text: str,
    citations_map: dict[str, Any],
    knowledge_chunks: dict[str, str],
    judge_provider: str | None,
    safety_provider: str | None,
    settings: Settings,
    phi_enabled: bool,
    phi_fail_closed: bool,
    redactor: PhiRedactor | None = None,
) -> tuple[str, str, dict[str, Any], dict[str, str]]:
    """Redact every cloud-bound field of the inferential pass before the judge/Granite calls.

    The safety screen sends the **note** to ``safety_provider`` (Granite); the judge
    sees the **transcript**, every claim hypothesis + evidence quote (the premise),
    and the **knowledge chunks** via ``judge_provider``. Each field is gated against
    *its own* consumer's provider, so only the payload actually destined for a cloud
    consumer is redacted. When neither consumer is a cloud provider (the default
    all-local deployment) the inputs are returned unchanged — identity, so the pass
    replays byte-identical and pays no Presidio cost. A fail-closed block propagates
    :class:`PhiEgressBlocked` so the activity can degrade the whole pass.
    """
    if not phi_enabled:
        return note_text, transcript_text, citations_map, knowledge_chunks

    cloud = set(settings.phi.cloud_egress_providers)
    if judge_provider not in cloud and safety_provider not in cloud:
        return note_text, transcript_text, citations_map, knowledge_chunks

    redactor = redactor if redactor is not None else PhiRedactor()

    def _gate(value: str, provider: str | None) -> str:
        return ensure_egress_safe(
            value,
            provider=provider,
            settings=settings,
            phi_enabled=phi_enabled,
            phi_fail_closed=phi_fail_closed,
            redactor=redactor,
        )

    safe_note = _gate(note_text, safety_provider)
    safe_transcript = _gate(transcript_text, judge_provider)
    safe_citations = _redact_citations_map(citations_map, _gate, judge_provider)
    safe_chunks = {cid: _gate(text, judge_provider) for cid, text in knowledge_chunks.items()}
    return safe_note, safe_transcript, safe_citations, safe_chunks


def _redact_citations_map(
    citations_map: dict[str, Any],
    gate: Callable[[str, str | None], str],
    provider: str | None,
) -> dict[str, Any]:
    """Copy ``citations_map`` with each claim hypothesis + evidence quote redacted.

    The judge's premise is built from the claim ``text`` and each evidence ``quote``,
    so both are gated. Claim ids/sections + every other key are preserved verbatim,
    and the input is never mutated in place.
    """
    claims = citations_map.get("claims")
    if not isinstance(claims, list):
        return citations_map

    new_claims: list[Any] = []
    for claim in claims:
        if not isinstance(claim, dict):
            new_claims.append(claim)
            continue
        new_claim = dict(claim)
        text = new_claim.get("text")
        if isinstance(text, str):
            new_claim["text"] = gate(text, provider)
        evidence = new_claim.get("evidence")
        if isinstance(evidence, list):
            new_evidence: list[Any] = []
            for ev in evidence:
                if isinstance(ev, dict) and isinstance(ev.get("quote"), str):
                    new_ev = dict(ev)
                    new_ev["quote"] = gate(new_ev["quote"], provider)
                    new_evidence.append(new_ev)
                else:
                    new_evidence.append(ev)
            new_claim["evidence"] = new_evidence
        new_claims.append(new_claim)
    return {**citations_map, "claims": new_claims}
