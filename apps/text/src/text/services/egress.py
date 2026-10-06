"""The egress pipeline — every LLM call, one way (TASK-1035 §3.1, §5.0).

``/generate`` (blocking and streamed) and ``/translate`` run the same steps:

1. **classify locality** per provider actually called (`core/locality.py`);
2. **inbound gate** — guardrail ``/screen/inbound`` (prompt safety + GLiNER2 PII
   spans) over every UNTRUSTED region the provider receives, CONCURRENTLY with the
   medical judge (``/api/medical/validate``) over the data regions only; both
   verdicts block. The judge is skipped only for ``medical_exempt: "internal"``.
   A system prompt is untrusted unless its ``system_governance`` digest verifies
   (TASK-1047 FC-4): GOVERNED text is static, registry-screened at authoring time,
   and is neither screened nor judged per call;
3. **cloud: pseudonymize** — the caller's ``known_phi`` (exact match, over EVERY
   text, a governed system prompt included) plus the spans, with ``[<LABEL>_<n>]``
   tokens and one platform sentence telling the model to copy them verbatim. Images pass through as-is and
   are counted (owner decision 2026-10-02). **Local:** the payload is untouched,
   but detection is still counted (OD-2);
4. provider call;
5. **output screen** (`services/output_gate.py`), ``pii_leak`` per locality;
6. **cloud: re-identify** before anything is returned, persisted or cached;
7. the ``egress`` summary — counts only — rides on the response.

The token map lives in the request's :class:`~text.services.pseudonymizer.Pseudonymizer`
and dies with the request: it is never logged, cached or serialised.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from prometheus_client import Counter

from text.core.exceptions import ContentBlockedError, GuardrailUnavailableError
from text.core.locality import CLOUD, LOCAL, resolve_locality
from text.core.logging import get_logger
from text.models.requests import GenerateRequest, TextContentPart, serialize_provider_overrides
from text.models.responses import DataFinding, EgressSummary
from text.models.usage import UsageDetail, guardrail_usage_from_verdict
from text.services.data_blocks import keyed_ranges
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    OUTBOUND_FINDING_REGION,
)
from text.services.judge_guard import assert_not_in_judge_scope
from text.services.pseudonymizer import Pseudonymizer, Span

logger = get_logger(__name__)

__all__ = [
    "PLATFORM_TOKEN_SENTENCE",
    "SYSTEM_REGION",
    "TRUST_DATA",
    "TRUST_INSTRUCTION",
    "USER_REGION",
    "EgressContext",
    "InboundResult",
    "SystemTrust",
    "prepare_egress",
    "prepare_text_egress",
    "record_outbound_data_findings",
    "request_segments",
    "run_inbound_gate",
    "source_regions",
    "system_prompt_is_governed",
    "verify_system_governance",
]

#: Joins the platform sentence onto the system prompt, and the stretches of one region.
_SEGMENT_SEPARATOR = "\n\n"

#: FC-5 region keys: an untrusted system prompt, and caller text outside any block.
SYSTEM_REGION = "system"
USER_REGION = "user"

#: FC-5b region trust. Guardrail's ``decision`` follows INSTRUCTION regions only; a
#: prompt-safety flag on a DATA region (an ``EXTERNAL_DATA`` block body) is reported
#: in ``data_findings`` instead of blocking. Instruction is the strict default.
TRUST_INSTRUCTION = "instruction"
TRUST_DATA = "data"

#: The key :func:`keyed_ranges` gives caller text outside any block while regions are
#: built. A block name is ``[a-z0-9_]+``, so this can never be one: outside text is
#: told apart from a block that happens to be NAMED ``user`` before both are keyed
#: :data:`USER_REGION`.
_OUTSIDE = "\x00outside"

#: The checks a data finding may name — the inbound prompt-safety checks (FC-5b) and
#: the outbound screen's classifier checks (FC-5c record-only); anything else counts
#: as ``other`` so the metric label stays bounded.
_DATA_FINDING_CHECKS = frozenset(
    {
        "jailbreak_detection",
        "prompt_safety",
        "prompt_toxicity",
        "response_safety",
        "response_toxicity",
        "response_refusal",
    }
)

#: How segment 0 is treated: ``absent`` (no system prompt in ``segments`` at all —
#: ``/translate``), ``governed`` (verified by digest — never screened) or
#: ``untrusted`` (screened as region :data:`SYSTEM_REGION`).
SystemTrust = Literal["absent", "governed", "untrusted"]

#: Per-call system-prompt trust outcomes (TASK-1047 FC-4). Counts only.
SYSTEM_PROMPT_GOVERNANCE = Counter(
    "text_egress_system_prompt_total",
    "System prompts by governance outcome: governed (digest verified), absent (no "
    "system_governance), mismatch (claim did not verify), none (no system prompt)",
    ["governance"],
)

#: FC-5b / FC-5c data findings: one increment per (flagged region, check). Counts only.
DATA_FINDINGS = Counter(
    "text_egress_data_findings_total",
    "Guardrail flags reported instead of blocking — prompt-safety on trust=data "
    "regions (TASK-1047 FC-5b) and outbound record-only checks (FC-5c), by check",
    ["check"],
)

#: Appended to the provider-facing system prompt on every CLOUD call (§5.0).
PLATFORM_TOKEN_SENTENCE = (
    "Bracketed tokens such as [PERSON_1] are placeholders for redacted identifiers: "
    "copy each one verbatim wherever it is needed, and never expand, alter or guess it."
)


# ── system-prompt governance (TASK-1047 FC-4) ─────────────────────────────────


def _governance_outcome(request: Any) -> str:
    system = getattr(request, "system_prompt", None)
    if not system:
        return "none"
    governance = getattr(request, "system_governance", None)
    if governance is None:
        return "absent"
    digest = hashlib.sha256(system.encode("utf-8")).hexdigest()
    return "governed" if digest == governance.composed_digest else "mismatch"


def system_prompt_is_governed(request: Any) -> bool:
    """``True`` iff ``sha256(system_prompt)`` equals the claimed ``composed_digest``.

    Presence of ``system_governance`` alone vouches for nothing: the digest is
    recomputed over the exact ``system_prompt`` received, so a one-byte edit — or
    any text the registry never screened — makes the system prompt UNTRUSTED.
    """
    return _governance_outcome(request) == "governed"


def verify_system_governance(request: Any) -> bool:
    """:func:`system_prompt_is_governed`, counted and logged — once per request.

    The log line carries the outcome, the piece count and the policy version; never
    the text. A mismatch is a warning: the composer only sends a claim it verified,
    so a mismatch is a composer bug or a tampered request — either way it is
    screened in full, never refused.
    """
    outcome = _governance_outcome(request)
    SYSTEM_PROMPT_GOVERNANCE.labels(governance=outcome).inc()
    governance = getattr(request, "system_governance", None)
    fields: dict[str, Any] = {"governance": outcome}
    if governance is not None:
        fields["pieces"] = len(governance.pieces)
        fields["policy_version"] = governance.policy_version
    if outcome == "mismatch":
        # Which side differs, without the text: the received system prompt's length and digest
        # prefix next to the claimed one (TASK-1047 V7 diagnosis).
        system = str(getattr(request, "system_prompt", "") or "")
        fields["system_chars"] = len(system)
        fields["system_digest"] = hashlib.sha256(system.encode("utf-8")).hexdigest()[:12]
        fields["claimed_digest"] = (
            str(governance.composed_digest)[:12] if governance is not None else ""
        )
        logger.warning("text.egress.system_prompt_governance", **fields)
    else:
        logger.info("text.egress.system_prompt_governance", **fields)
    return outcome == "governed"


# ── regions (TASK-1047 FC-5) ─────────────────────────────────────────────────


@dataclass(frozen=True)
class _Stretch:
    """One stretch of one segment, placed inside its region's text."""

    segment: int
    start: int  # in the segment
    end: int  # in the segment
    offset: int  # in the region text


@dataclass
class _ScreenRegion:
    """One region as guardrail sees it, and where each of its stretches came from."""

    key: str
    text: str = ""
    stretches: list[_Stretch] = field(default_factory=list)
    trust: str = TRUST_DATA

    def add(self, segment: int, source: str, start: int, end: int, *, trust: str) -> None:
        # One key, one trust: a stitched region is DATA only if every stretch is.
        if trust == TRUST_INSTRUCTION:
            self.trust = TRUST_INSTRUCTION
        if self.text:
            self.text += _SEGMENT_SEPARATOR
        self.stretches.append(_Stretch(segment, start, end, len(self.text)))
        self.text += source[start:end]


def _screen_regions(segments: list[str], *, system: SystemTrust) -> list[_ScreenRegion]:
    """The regions of ``segments`` an ML screen inspects, in first-appearance order.

    Each ``EXTERNAL_DATA`` body is keyed by its block name and caller text outside
    any block by :data:`USER_REGION`; segment 0 is the system prompt unless
    ``system`` is ``absent`` — skipped when ``governed``, keyed :data:`SYSTEM_REGION`
    as a whole (markers aside) when ``untrusted``. Stretches sharing a key are
    stitched into ONE region with the segment separator, so every key is unique on
    the wire and a span maps back to exactly one stretch.

    Trust (FC-5b): a block body is DATA; caller text outside blocks and an untrusted
    system prompt are INSTRUCTION, and a region stitched from both is INSTRUCTION.
    """
    regions: dict[str, _ScreenRegion] = {}
    for index, text in enumerate(segments):
        is_system = index == 0 and system != "absent"
        if is_system and system == "governed":
            continue
        for key, start, end in keyed_ranges(text, outside=_OUTSIDE):
            trust = TRUST_DATA
            if is_system:
                key, trust = SYSTEM_REGION, TRUST_INSTRUCTION
            elif key == _OUTSIDE:
                key, trust = USER_REGION, TRUST_INSTRUCTION
            regions.setdefault(key, _ScreenRegion(key)).add(index, text, start, end, trust=trust)
    return list(regions.values())


def _wire(regions: list[_ScreenRegion]) -> list[dict[str, str]]:
    """Regions as the judge and the output screen take them: key and text only."""
    return [{"key": region.key, "text": region.text} for region in regions]


def _screen_wire(regions: list[_ScreenRegion]) -> list[dict[str, str]]:
    """Regions for the inbound screen: each with its explicit ``trust`` (FC-5b)."""
    return [{"key": region.key, "text": region.text, "trust": region.trust} for region in regions]


def source_regions(segments: list[str], *, system: SystemTrust) -> list[dict[str, str]]:
    """The ``pii_leak`` source (FC-5 ``source_regions``): the untrusted regions sent.

    Governed system text is not a source — it carries no runtime value — and the
    platform token sentence is never included (it names a token shape, not data).
    """
    return _wire(_screen_regions(segments, system=system))


def _rebase(raw: Any, segment_count: int, regions: list[_ScreenRegion]) -> list[list[Span]]:
    """Re-base guardrail's region-relative spans onto the segment each one fell in.

    A span that is malformed, names no (or an unknown) region, or crosses a stitch
    between two stretches is dropped from the span list — the caller's
    ``known_phi`` still covers a value it knows.
    """
    by_segment: list[list[Span]] = [[] for _ in range(segment_count)]
    if not isinstance(raw, list):
        return by_segment
    by_key = {region.key: region for region in regions}
    for item in raw:
        if not isinstance(item, dict):
            continue
        region = by_key.get(str(item.get("region")))
        if region is None:
            continue
        try:
            label = str(item["label"])
            start = int(item["start"])
            end = int(item["end"])
        except (KeyError, TypeError, ValueError):
            continue
        for stretch in region.stretches:
            limit = stretch.offset + (stretch.end - stretch.start)
            if stretch.offset <= start and end <= limit:
                shift = stretch.start - stretch.offset
                by_segment[stretch.segment].append(Span(label, start + shift, end + shift))
                break
    return by_segment


# ── inbound gate ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class InboundResult:
    """What the inbound gate produced: guardrail's own spend, spans per text, and the
    FC-5b data findings (``[{region, reasons}]`` — keys and check names, never text)."""

    guardrail_usage: UsageDetail | None
    spans_by_segment: list[list[Span]]
    data_findings: list[dict[str, Any]] = field(default_factory=list)


def _record_data_findings(verdict: Any, regions: list[_ScreenRegion]) -> list[dict[str, Any]]:
    """Log and count the screen's ``data_findings`` (FC-5b); return them.

    One ``text.egress.data_findings`` line per request — region keys, check names and
    counts, never text — and one ``text_egress_data_findings_total`` increment per
    (region, check), with an unknown check name counted as ``other``. The client
    already drops malformed items; they are re-checked here (any stub may stand in for
    it) and dropped, never raised on. Nothing here touches the verdict.
    """
    findings = _well_formed_findings(verdict, {region.key for region in regions})
    if not findings:
        return []
    _count_findings(findings)
    logger.warning(
        "text.egress.data_findings",
        direction="inbound",
        findings=findings,
        regions_flagged=len({f["region"] for f in findings}),
        data_regions=sum(1 for region in regions if region.trust == TRUST_DATA),
        regions_screened=len(regions),
    )
    return findings


def record_outbound_data_findings(verdict: Any, *, where: str) -> list[dict[str, Any]]:
    """Log and count the OUTBOUND screen's ``data_findings`` (TASK-1047 FC-5c); return them.

    Guardrail reports a record-only check (``outboundRecordOnlyChecks``, default
    ``jailbreak_detection``) that flagged on the response as
    ``[{region: "response", reasons}]`` instead of blocking. Recorded exactly like the
    inbound findings: one ``text.egress.data_findings`` line with ``direction:
    "outbound"`` (region + check names, never text) and the same
    ``text_egress_data_findings_total`` counter. Malformed items are dropped, never
    raised on, and nothing here touches the verdict.
    """
    findings = _well_formed_findings(verdict, {OUTBOUND_FINDING_REGION})
    if not findings:
        return []
    _count_findings(findings)
    logger.warning(
        "text.egress.data_findings",
        direction="outbound",
        where=where,
        findings=findings,
        regions_flagged=len({f["region"] for f in findings}),
    )
    return findings


def _well_formed_findings(verdict: Any, sent: set[str]) -> list[dict[str, Any]]:
    """``verdict["data_findings"]`` items shaped ``{region in sent, reasons: [str, …]}``."""
    raw = verdict.get("data_findings") if isinstance(verdict, dict) else None
    return [
        {"region": item["region"], "reasons": list(item["reasons"])}
        for item in (raw if isinstance(raw, list) else [])
        if isinstance(item, dict)
        and item.get("region") in sent
        and isinstance(item.get("reasons"), list)
        and item["reasons"]
        and all(isinstance(reason, str) for reason in item["reasons"])
    ]


def _count_findings(findings: list[dict[str, Any]]) -> None:
    for finding in findings:
        for check in finding["reasons"]:
            DATA_FINDINGS.labels(check=check if check in _DATA_FINDING_CHECKS else "other").inc()


def _raise_for(verdict: dict[str, Any], *, medical: bool) -> None:
    """Map a not-allowed verdict onto the fixed, non-PHI HTTP surface."""
    reason = verdict.get("reason", "not_allowed")
    if reason == GUARDRAIL_UNAVAILABLE_REASON:
        raise GuardrailUnavailableError()
    if medical and verdict.get("is_medical") is False:
        raise ContentBlockedError(
            "The prompt was not classified as clinical content by the "
            "medical-relevance guardrail.",
            error_code="CONTENT_BLOCKED_NOT_MEDICAL",
        )
    raise ContentBlockedError("Content was blocked by the safety guardrail.")


async def run_inbound_gate(
    guardrail_client: Any,
    *,
    segments: list[str],
    prompt: str,
    system: SystemTrust,
    tenant_id: str | None,
    tenant_policy: Any = None,
    provider_overrides: Any = None,
    medical_exempt: str | None = None,
) -> InboundResult:
    """Run the inbound screen and the medical judge CONCURRENTLY; both verdicts block.

    ``segments`` are the texts the provider will receive; segment 0 is the system
    prompt unless ``system`` is ``absent``. The screen gets the UNTRUSTED regions
    (FC-5): every block body by its name, caller text outside blocks as ``user``,
    and the system prompt as ``system`` unless it is ``governed`` (digest verified,
    FC-4). Its PII spans come back region-relative and are re-based per segment, so
    the cloud pseudonymiser covers every untrusted stretch. The medical judge keeps
    OD-1's scope: the data regions only, never the system prompt, governed or not.
    A client that is not wired is only ever a process the lifespan did not build
    (the unit harness): nothing to call, no spans.

    The cycle tripwire holds: guardrail delegates its judgement to this service,
    so reaching this gate from the judge lane raises.
    """
    if guardrail_client is None:
        return InboundResult(None, [[] for _ in segments])
    assert_not_in_judge_scope("egress.run_inbound_gate")

    regions = _screen_regions(segments, system=system)
    screen = guardrail_client.screen_inbound(regions=_screen_wire(regions), tenant_id=tenant_id)
    if medical_exempt == "internal":
        screen_verdict = await screen
        medical_verdict: dict[str, Any] | None = None
    else:
        judged = _wire(
            _screen_regions(segments, system="absent" if system == "absent" else "governed")
        )
        # An empty context is nothing to judge; the judge then gets the direct prompt.
        judge = guardrail_client.validate(
            regions=judged or [{"key": USER_REGION, "text": prompt}],
            tenant_id=tenant_id,
            tenant_policy=tenant_policy,
            # The connection the gateway injected, forwarded so guardrail's judge
            # has one (TASK-890). Serialized: `SecretStr` masks itself on dump.
            provider_overrides=serialize_provider_overrides(provider_overrides),
        )
        screen_verdict, medical_verdict = await asyncio.gather(screen, judge)

    # Usage is lifted BEFORE the allow/deny branch: a rejected prompt still burned
    # guardrail tokens. The judge is the call that spends; the screen runs local
    # weights and reports none.
    usage = guardrail_usage_from_verdict(medical_verdict) if medical_verdict else None
    if usage is None and isinstance(screen_verdict, dict):
        usage = guardrail_usage_from_verdict(screen_verdict)
    # FC-5b: recorded whatever the outcome — a data flag never blocks, but it is
    # always visible.
    data_findings = _record_data_findings(screen_verdict, regions)

    # Fail-closed default: a missing ``allowed`` key is a rejection.
    if medical_verdict is not None and not medical_verdict.get("allowed", False):
        _raise_for(medical_verdict, medical=True)
    if not isinstance(screen_verdict, dict):
        raise GuardrailUnavailableError()
    if not screen_verdict.get("allowed", False):
        _raise_for(screen_verdict, medical=False)

    return InboundResult(
        usage,
        _rebase(screen_verdict.get("pii_spans"), len(segments), regions),
        data_findings,
    )


# ── pseudonymize / restore ───────────────────────────────────────────────────


@dataclass
class EgressContext:
    """One request's egress state. Holds the token map; never serialise it."""

    locality: str
    pseudonymizer: Pseudonymizer
    provider_request: Any
    source_regions: list[dict[str, str]]
    images_unredacted: int = 0
    restored: int = 0
    pii_leak_blocked: bool = False
    data_findings: list[dict[str, Any]] = field(default_factory=list)

    @property
    def is_cloud(self) -> bool:
        return self.locality == CLOUD

    def restore(self, text: str) -> str:
        """Re-identify ``text`` on cloud (counted); identity on local."""
        if not self.is_cloud or not text:
            return text
        restored, count = self.pseudonymizer.restore(text)
        self.restored += count
        return restored

    @property
    def summary(self) -> EgressSummary:
        return EgressSummary(
            locality=self.locality,
            detected=dict(self.pseudonymizer.detected),
            redacted=self.pseudonymizer.redacted,
            restored=self.restored,
            pii_leak_blocked=self.pii_leak_blocked,
            images_unredacted=self.images_unredacted,
            guardrail_data_findings=[DataFinding.model_validate(f) for f in self.data_findings],
        )

    def log(self, where: str) -> None:
        """One structured line per request — counts only, never a value."""
        summary = self.summary
        logger.info(
            "text.egress.applied",
            where=where,
            locality=summary.locality,
            detected=summary.detected,
            redacted=summary.redacted,
            restored=summary.restored,
            pii_leak_blocked=summary.pii_leak_blocked,
            images_unredacted=summary.images_unredacted,
        )


def request_segments(request: GenerateRequest) -> list[str]:
    """Every text the provider receives, in a fixed order: system, prompt, text parts."""
    segments = [request.system_prompt or "", request.prompt]
    for part in request.content_parts or []:
        if isinstance(part, TextContentPart):
            segments.append(part.text)
    return segments


def _known(request: Any) -> list[tuple[str, str]]:
    return [(item.label, item.value) for item in (getattr(request, "known_phi", None) or [])]


def prepare_egress(
    request: GenerateRequest,
    *,
    spans_by_segment: list[list[Span]] | None,
    system_governed: bool = False,
    data_findings: list[dict[str, Any]] | None = None,
) -> EgressContext:
    """Build what the provider receives for ``request``, per its locality.

    The ``known_phi`` exact-match pass covers EVERY segment on cloud — a governed
    system prompt included, as defence in depth; ML spans exist only where the
    inbound screen looked. ``system_governed`` (verified by the caller, FC-4) keeps
    the system prompt out of the ``pii_leak`` source regions. ``data_findings`` (the
    inbound gate's FC-5b findings) ride on the egress summary.
    """
    locality = resolve_locality(request.provider, request.provider_locality)
    segments = request_segments(request)
    spans = spans_by_segment or [[] for _ in segments]
    pseudonymizer = Pseudonymizer(_known(request))
    system: SystemTrust = "governed" if system_governed else "untrusted"

    if locality == LOCAL:
        for text, segment_spans in zip(segments, spans, strict=False):
            pseudonymizer.count(text, segment_spans)
        provider_request = request
        regions = source_regions(segments, system=system)
    else:
        rewritten = [
            pseudonymizer.pseudonymize(text, segment_spans) if text else text
            for text, segment_spans in zip(segments, spans, strict=False)
        ]
        # The output screen's source is the untrusted regions the provider was
        # given, pseudonymised; never the platform sentence (it names a token
        # shape, not anything the model read).
        regions = source_regions(rewritten, system=system)
        system_prompt = rewritten[0]
        system_prompt = (
            f"{system_prompt}{_SEGMENT_SEPARATOR}{PLATFORM_TOKEN_SENTENCE}"
            if system_prompt
            else PLATFORM_TOKEN_SENTENCE
        )
        parts = None
        if request.content_parts:
            texts = iter(rewritten[2:])
            parts = [
                (
                    part.model_copy(update={"text": next(texts)})
                    if isinstance(part, TextContentPart)
                    else part
                )
                for part in request.content_parts
            ]
        provider_request = request.model_copy(
            update={
                "system_prompt": system_prompt,
                "prompt": rewritten[1],
                "content_parts": parts,
                "known_phi": None,
            }
        )

    images = len(request.image_parts()) if locality == CLOUD else 0
    return EgressContext(
        locality=locality,
        pseudonymizer=pseudonymizer,
        provider_request=provider_request,
        source_regions=regions,
        images_unredacted=images,
        data_findings=list(data_findings or []),
    )


def prepare_text_egress(
    texts: list[str],
    *,
    provider: str,
    provider_locality: Mapping[str, str] | None,
    known_phi: Any,
    spans_by_segment: list[list[Span]] | None,
) -> tuple[EgressContext, list[str]]:
    """The same egress for a list of plain texts (``/translate``)."""
    locality = resolve_locality(provider, provider_locality)
    spans = spans_by_segment or [[] for _ in texts]
    pseudonymizer = Pseudonymizer([(item.label, item.value) for item in (known_phi or [])])
    if locality == LOCAL:
        for text, segment_spans in zip(texts, spans, strict=False):
            pseudonymizer.count(text, segment_spans)
        outgoing = list(texts)
    else:
        outgoing = [
            pseudonymizer.pseudonymize(text, segment_spans)
            for text, segment_spans in zip(texts, spans, strict=False)
        ]
    context = EgressContext(
        locality=locality,
        pseudonymizer=pseudonymizer,
        provider_request=None,
        source_regions=source_regions(outgoing, system="absent"),
    )
    return context, outgoing
