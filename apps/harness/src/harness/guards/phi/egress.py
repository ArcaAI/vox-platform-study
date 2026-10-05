"""PHI egress screens for the DIRECT (non-``/generate``) hops the harness still owns.

TASK-1035 moved LLM egress safety for every ``apps/text`` ``/generate`` call into text itself
(pseudonymize on cloud, re-identify, fail closed), so the former per-call
``ensure_egress_safe`` chokepoint is gone from every activity and node. What remains here are
the two hops that do NOT go through ``/generate``:

* :func:`ensure_inferential_egress_safe` — the inferential judge posts to its selected provider
  DIRECTLY from this process (``build_judge_client``), so its premise (transcript, per-claim
  hypotheses & evidence quotes, knowledge chunks) is redacted here when the judge transport is
  cloud. The local set is code (:data:`harness.core.llm_egress.LOCAL_DIRECT_TRANSPORTS`), not
  the retired ``HARNESS_PHI_LOCAL_PROVIDERS`` env.
* :func:`ensure_mcp_args_safe` — outbound MCP tool args to an EXTERNAL server are BLOCKED if they
  carry PHI (never an LLM call at all).

Both honour the **run-effective policy** snapshotted at workflow start
(``phi_enabled`` / ``phi_fail_closed``) instead of re-reading config, so enforcement is
deterministic across replay. A :class:`~harness.guards.phi.redactor.PhiEgressBlocked` propagates
so the activity can act on it — it is never swallowed into a silent unredacted egress.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from harness.core.llm_egress import is_local_direct_transport
from harness.guards.phi.redactor import PhiEgressBlocked, PhiRedactor


def _serialize_mcp_args(args: dict[str, Any]) -> str:
    """Deterministic, PHI-detectable serialization of the outbound tool args.

    Sorted keys + ``default=str`` so any nested value is flattened to text the
    analyzer can scan (a non-JSON value never silently escapes the screen).
    """
    return json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)


def ensure_mcp_args_safe(
    args: dict[str, Any],
    *,
    phi_boundary: str,
    phi_enabled: bool,
    phi_fail_closed: bool,
    server: str = "mcp",
    redactor: PhiRedactor | None = None,
) -> dict[str, Any]:
    """Fail-closed PHI screen for OUTBOUND MCP tool args to an EXTERNAL server.

    * ``phi_enabled`` False OR an ``in-boundary`` (self-hosted) server ⇒ pass-through —
      an in-boundary tool call is not a cloud egress, so it is never screened.
    * ``external`` server ⇒ detect PHI in the serialized args. Any detected PHI span —
      OR a redactor failure (e.g. the Presidio extra is missing on an external run) —
      **BLOCKS** the call by raising :class:`PhiEgressBlocked` when ``phi_fail_closed``
      (the default). Clean args pass through UNCHANGED.

    Unlike an LLM prompt (which ``apps/text`` pseudonymizes), tool args are BLOCKED-if-PHI,
    never silently redacted: a READ-ONLY external tool (e.g. FHIR terminology validation) must
    carry only codes/terms, so PHI in its args is a defect that must fail closed, not a
    payload to sanitize. When ``phi_fail_closed`` is False the guard degrades OPEN
    (returns the args) — an explicit per-tenant opt-out.
    """
    if not phi_enabled or phi_boundary != "external":
        return args

    redactor = redactor if redactor is not None else PhiRedactor()
    serialized = _serialize_mcp_args(args)
    try:
        result = redactor.redact(serialized)
    except Exception as exc:  # noqa: BLE001 — fail closed on ANY analyzer failure
        if phi_fail_closed:
            raise PhiEgressBlocked(provider=server, reason=f"redaction failed: {exc}") from exc
        return args

    if result.entities and phi_fail_closed:
        raise PhiEgressBlocked(
            provider=server,
            reason=f"PHI detected in tool args ({len(result.entities)} spans)",
        )
    return args


def ensure_inferential_egress_safe(
    *,
    note_text: str,
    transcript_text: str,
    citations_map: dict[str, Any],
    knowledge_chunks: dict[str, str],
    judge_provider: str | None,
    safety_provider: str | None,
    phi_enabled: bool,
    phi_fail_closed: bool,
    redactor: PhiRedactor | None = None,
) -> tuple[str, str, dict[str, Any], dict[str, str]]:
    """Redact every cloud-bound field of the inferential pass before the DIRECT judge calls.

    The safety screen sends the **note** to ``safety_provider``; the judge sees the
    **transcript**, every claim hypothesis + evidence quote (the premise), and the **knowledge
    chunks** via ``judge_provider``. Each field is gated against *its own* consumer's
    transport, so only the payload actually destined for a cloud consumer is redacted. When
    neither consumer is a cloud transport (the default all-local deployment) the inputs are
    returned unchanged — identity, so the pass replays byte-identical and pays no Presidio
    cost. A fail-closed block propagates :class:`PhiEgressBlocked` so the activity can degrade
    the whole pass.
    """
    if not phi_enabled:
        return note_text, transcript_text, citations_map, knowledge_chunks

    def _is_cloud(provider: str | None) -> bool:
        # None ⇒ no egress target (pass-through); everything else defaults to
        # cloud unless it is a recognized local transport (default-deny).
        return provider is not None and not is_local_direct_transport(provider)

    if not _is_cloud(judge_provider) and not _is_cloud(safety_provider):
        return note_text, transcript_text, citations_map, knowledge_chunks

    guard = redactor if redactor is not None else PhiRedactor()

    def _gate(value: str, provider: str | None) -> str:
        if provider is None:
            return value
        return guard.ensure_safe_for_cloud(value, provider=provider, fail_closed=phi_fail_closed)

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
