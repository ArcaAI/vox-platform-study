"""The egress pipeline — every LLM call, one way (TASK-1035 §3.1, §5.0).

``/generate`` (blocking and streamed) and ``/translate`` run the same steps:

1. **classify locality** per provider actually called (`core/locality.py`);
2. **inbound gate** — guardrail ``/screen/inbound`` (prompt safety + GLiNER2 PII
   spans) CONCURRENTLY with the medical judge (``/api/medical/validate``); both
   verdicts block. The judge is skipped only for ``medical_exempt: "internal"``;
3. **cloud: pseudonymize** — the caller's ``known_phi`` plus the spans, in every
   text the provider receives, with ``[<LABEL>_<n>]`` tokens and one platform
   sentence telling the model to copy them verbatim. Images pass through as-is and
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
from dataclasses import dataclass
from typing import Any

from text.core.exceptions import ContentBlockedError, GuardrailUnavailableError
from text.core.locality import CLOUD, LOCAL, resolve_locality
from text.core.logging import get_logger
from text.models.requests import GenerateRequest, TextContentPart, serialize_provider_overrides
from text.models.responses import EgressSummary
from text.models.usage import UsageDetail, guardrail_usage_from_verdict
from text.services.external_guardrail import GUARDRAIL_UNAVAILABLE_REASON
from text.services.judge_guard import assert_not_in_judge_scope
from text.services.pseudonymizer import Pseudonymizer, Span

logger = get_logger(__name__)

__all__ = [
    "PLATFORM_TOKEN_SENTENCE",
    "EgressContext",
    "InboundResult",
    "prepare_egress",
    "prepare_text_egress",
    "run_inbound_gate",
]

#: Joins the texts of one request into the single string the inbound screen sees.
_SEGMENT_SEPARATOR = "\n\n"

#: Appended to the provider-facing system prompt on every CLOUD call (§5.0).
PLATFORM_TOKEN_SENTENCE = (
    "Bracketed tokens such as [PERSON_1] are placeholders for redacted identifiers: "
    "copy each one verbatim wherever it is needed, and never expand, alter or guess it."
)


# ── inbound gate ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class InboundResult:
    """What the inbound gate produced: guardrail's own spend, and spans per text."""

    guardrail_usage: UsageDetail | None
    spans_by_segment: list[list[Span]]


def _combine(segments: list[str]) -> tuple[str, list[int]]:
    """Join ``segments`` and return each one's start offset in the joined text."""
    offsets: list[int] = []
    parts: list[str] = []
    position = 0
    for index, segment in enumerate(segments):
        if index:
            parts.append(_SEGMENT_SEPARATOR)
            position += len(_SEGMENT_SEPARATOR)
        offsets.append(position)
        parts.append(segment)
        position += len(segment)
    return "".join(parts), offsets


def _split_spans(raw: Any, segments: list[str], offsets: list[int]) -> list[list[Span]]:
    """Re-base the screen's spans onto the segment each one fell in.

    A span that is malformed, or that crosses a segment boundary, is dropped from
    the span list — the caller's ``known_phi`` still covers a value it knows.
    """
    by_segment: list[list[Span]] = [[] for _ in segments]
    if not isinstance(raw, list):
        return by_segment
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            label = str(item["label"])
            start = int(item["start"])
            end = int(item["end"])
        except (KeyError, TypeError, ValueError):
            continue
        for index, base in enumerate(offsets):
            limit = base + len(segments[index])
            if base <= start and end <= limit:
                by_segment[index].append(Span(label, start - base, end - base))
                break
    return by_segment


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
    system_prompt: str | None,
    tenant_id: str | None,
    tenant_policy: Any = None,
    provider_overrides: Any = None,
    medical_exempt: str | None = None,
) -> InboundResult:
    """Run the inbound screen and the medical judge CONCURRENTLY; both verdicts block.

    ``segments`` are the texts the provider will receive; the screen sees them
    joined and its PII spans come back per segment. The judge sees
    ``system_prompt`` + ``prompt`` exactly as before. A client that is not wired is
    only ever a process the lifespan did not build (the unit harness): nothing to
    call, no spans.

    The cycle tripwire holds: guardrail delegates its judgement to this service,
    so reaching this gate from the judge lane raises.
    """
    if guardrail_client is None:
        return InboundResult(None, [[] for _ in segments])
    assert_not_in_judge_scope("egress.run_inbound_gate")

    combined, offsets = _combine(segments)
    screen = guardrail_client.screen_inbound(combined, tenant_id=tenant_id)
    if medical_exempt == "internal":
        screen_verdict = await screen
        medical_verdict: dict[str, Any] | None = None
    else:
        judge = guardrail_client.validate(
            prompt=prompt,
            system_prompt=system_prompt,
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

    # Fail-closed default: a missing ``allowed`` key is a rejection.
    if medical_verdict is not None and not medical_verdict.get("allowed", False):
        _raise_for(medical_verdict, medical=True)
    if not isinstance(screen_verdict, dict):
        raise GuardrailUnavailableError()
    if not screen_verdict.get("allowed", False):
        _raise_for(screen_verdict, medical=False)

    return InboundResult(usage, _split_spans(screen_verdict.get("pii_spans"), segments, offsets))


# ── pseudonymize / restore ───────────────────────────────────────────────────


@dataclass
class EgressContext:
    """One request's egress state. Holds the token map; never serialise it."""

    locality: str
    pseudonymizer: Pseudonymizer
    provider_request: Any
    source_context: str
    images_unredacted: int = 0
    restored: int = 0
    pii_leak_blocked: bool = False

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
    request: GenerateRequest, *, spans_by_segment: list[list[Span]] | None
) -> EgressContext:
    """Build what the provider receives for ``request``, per its locality."""
    locality = resolve_locality(request.provider, request.provider_locality)
    segments = request_segments(request)
    spans = spans_by_segment or [[] for _ in segments]
    pseudonymizer = Pseudonymizer(_known(request))

    if locality == LOCAL:
        for text, segment_spans in zip(segments, spans, strict=False):
            pseudonymizer.count(text, segment_spans)
        provider_request = request
        source_context = _source_context(request.system_prompt, request.prompt)
    else:
        rewritten = [
            pseudonymizer.pseudonymize(text, segment_spans) if text else text
            for text, segment_spans in zip(segments, spans, strict=False)
        ]
        # The output screen's source is what the provider was given, minus the
        # platform sentence (it names a token shape, not anything the model read).
        source_context = _source_context(rewritten[0] or None, rewritten[1])
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
        source_context=source_context,
        images_unredacted=images,
    )


def _source_context(system_prompt: str | None, prompt: str) -> str:
    """Joined the way the post-receive gate has always joined them."""
    return f"{system_prompt}\n\n{prompt}" if system_prompt else prompt


def prepare_text_egress(
    texts: list[str],
    *,
    provider: str,
    provider_locality: dict[str, str] | None,
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
        source_context=_SEGMENT_SEPARATOR.join(outgoing),
    )
    return context, outgoing
