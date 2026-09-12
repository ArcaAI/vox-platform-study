"""The three-axis transcript verdict, and the two cache scopes it travels under.

**Why three axes and not one (C-1).** A single "is this safe" boolean conflates
three questions whose answers have different blast radii:

======================  =====================================  ================
Axis                    Property of                            Travels
======================  =====================================  ================
``contentHarm``         the TEXT                               freely, cached
``injectionRisk``       text x assembly x capability set       only within scope
``clinical``            the PATIENT                            to a human, never a gate
======================  =====================================  ================

Position materially changes attack success — a distractor at the end of a prompt
costs 60.4% accuracy, the middle 52.5%, the start 48.7% — so an injection verdict
computed against one prompt assembly **does not transfer** to another. Content
harm does: it is the same text whoever reads it. Collapsing the two means either
re-running the expensive task-agnostic check per task, or reusing a scoped verdict
outside its scope. The first is waste; the second is the bug.

**Why the clinical axis exists but never gates.** A general harm taxonomy flags
roughly three-quarters of safe clinical conversation (Llama Guard 3 1B: 71.3% FP
at 90% recall), and the documented deployed failure is the *absence* of
escalation, not over-blocking. So a self-harm disclosure is routed to a clinician
and is never allowed to stop the note being written about it. That is enforced
here rather than at the call sites: :attr:`TranscriptSegmentVerdict.gating_reasons`
never reads axis 3, so no consumer can opt into gating on it.

**C-5, structurally.** This artifact carries offsets, labels, counts and versions
— never transcript text — and it has no field with which to ask anyone to remove,
redact or withhold any. ``transcriptDisposition`` is a one-valued constant rather
than an enum with a second member, because retention is not a branch. A guardrail
that cannot express "delete this" cannot blank a live transcript, and a blanked
transcript is a patient-safety event in its own right.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Final

#: The ONLY disposition a guardrail decision may express about the clinical
#: record. Declared as a tuple of one so a future edit that adds a second value
#: is a visible, reviewable change to the safety contract rather than a quiet
#: extra branch — `test_transcript_disposition_has_exactly_one_possible_value`
#: fails the moment it grows.
RETAIN_VERBATIM: Final = "retain_verbatim"
TRANSCRIPT_DISPOSITIONS: Final[tuple[str, ...]] = (RETAIN_VERBATIM,)

#: Axis-2 decisions. NEUTRALIZE keeps the segment in the transcript verbatim and
#: passes it downstream as inert data — never in instruction position.
INJECTION_PASS: Final = "PASS"
INJECTION_NEUTRALIZE: Final = "NEUTRALIZE"
INJECTION_BLOCK: Final = "BLOCK"
INJECTION_DECISIONS: Final[tuple[str, ...]] = (
    INJECTION_PASS,
    INJECTION_NEUTRALIZE,
    INJECTION_BLOCK,
)


@dataclass(frozen=True)
class VerdictScope:
    """Everything a verdict is only valid UNDER. This is the cache key's body.

    ``tenantId`` is mandatory and non-blank for the same reason
    :class:`~guardrail.services.screening.Screener` demands one: a verdict nobody
    can attribute must not be renderable, and a cache key that omits the tenant
    serves one tenant's policy verdict to another.
    """

    content_hash: str
    policy_version: int
    classifier_version: str
    taxonomy_version: str
    threshold_set: str
    tenant_id: str

    def __post_init__(self) -> None:
        if not (self.tenant_id or "").strip():
            raise ValueError(
                "a verdict scope requires a tenant: verdicts must be attributable, "
                "and a tenant-less cache key is a cross-tenant hit waiting to happen"
            )
        if not (self.content_hash or "").strip():
            raise ValueError("a verdict scope requires the content hash it was computed over")

    def components(self) -> tuple[str, ...]:
        """The declared key components, in a fixed order."""
        return (
            self.content_hash,
            str(self.policy_version),
            self.classifier_version,
            self.taxonomy_version,
            self.threshold_set,
            self.tenant_id,
        )


def _key(prefix: str, parts: tuple[str, ...]) -> str:
    # NUL-joined: no component can forge a boundary by containing the separator.
    digest = hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()
    return f"{prefix}:{digest}"


def content_harm_cache_key(scope: VerdictScope) -> str:
    """Axis-1 key. Deliberately blind to assembly and capability — it fans out."""
    return _key("gr:rt:harm", scope.components())


def injection_risk_cache_key(
    scope: VerdictScope, *, assembly_template_id: str, capability_set_id: str
) -> str:
    """Axis-2 key: the scope PLUS what the content will be composed into.

    A strictly longer key, so a differing assembly or capability set is a cache
    MISS by construction. There is no code path that can decide to reuse across
    them, which is the point — C-3's silent privilege escalation is exactly a
    verdict inherited across a capability change.
    """
    if not (assembly_template_id or "").strip() or not (capability_set_id or "").strip():
        raise ValueError(
            "an injection-risk verdict is scoped to (assembly x capability); both must "
            "be declared, because an undeclared scope is an unbounded one"
        )
    return _key("gr:rt:inj", (*scope.components(), assembly_template_id, capability_set_id))


@dataclass(frozen=True)
class ContentHarm:
    """Axis 1 — a property of the text. Cacheable, fan-out safe."""

    categories: tuple[str, ...] = ()
    confidence: float = 0.0
    classifier_version: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "categories": list(self.categories),
            "confidence": self.confidence,
            "classifierVersion": self.classifier_version,
        }


@dataclass(frozen=True)
class InjectionRisk:
    """Axis 2 — a property of (content x assembly x capability set)."""

    decision: str = INJECTION_PASS
    assembly_template_id: str = ""
    capability_set_id: str = ""
    confidence: float = 0.0

    def __post_init__(self) -> None:
        if self.decision not in INJECTION_DECISIONS:
            raise ValueError(f"unknown injection decision {self.decision!r}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "assemblyTemplateId": self.assembly_template_id,
            "capabilitySetId": self.capability_set_id,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class ClinicalSignal:
    """Axis 3 — a signal for a clinician. Offsets only; never the words."""

    category: str
    confidence: float
    span: tuple[int, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "confidence": self.confidence,
            "span": [self.span[0], self.span[1]],
        }


@dataclass(frozen=True)
class WindowAssertion:
    """C-2 made checkable: is this verdict valid for what the consumer will send?

    ``inspected_chars`` is what the guardrail actually looked at;
    ``consumer_window_chars`` is what the model will actually be fed. A verdict
    whose inspection is narrower than the model's window is the Prompt Overflow
    shape verbatim — the guard scores less than the model infers.

    A SEGMENT verdict always reports ``complete=False`` and
    ``consumer_window_chars=0``: a delta is not a consumption window, and saying
    so in the artifact is what stops it being mistaken for one.
    """

    inspected_chars: int = 0
    consumer_window_chars: int = 0
    complete: bool = False

    @property
    def covers_consumer_window(self) -> bool:
        return self.complete and self.inspected_chars >= self.consumer_window_chars > 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "inspectedChars": self.inspected_chars,
            "consumerWindowChars": self.consumer_window_chars,
            "complete": self.complete,
        }


@dataclass(frozen=True)
class TranscriptSegmentVerdict:
    """One validated unit, and everything needed to know how far it travels."""

    segment_id: str
    scope: VerdictScope
    content_harm: ContentHarm
    injection_risk: InjectionRisk
    window: WindowAssertion
    clinical: tuple[ClinicalSignal, ...] = ()
    validator_id: str = ""
    created_at: str = ""
    #: Session-aggregation state at the time this verdict was rendered, for audit.
    session_aggregate: dict[str, Any] = field(default_factory=dict)

    # -- the gate ----------------------------------------------------------

    @property
    def gating_reasons(self) -> tuple[str, ...]:
        """Why derivations are blocked. **Axis 3 is not consulted, ever.**

        Written as an explicit two-axis read rather than "anything flagged" so
        that adding a clinical category can never widen the gate by accident.
        """
        reasons: list[str] = []
        if self.content_harm.categories:
            reasons.extend(f"contentHarm:{c}" for c in self.content_harm.categories)
        if self.injection_risk.decision == INJECTION_BLOCK:
            reasons.append("injectionRisk:BLOCK")
        return tuple(reasons)

    @property
    def gates_derivations(self) -> bool:
        return bool(self.gating_reasons)

    @property
    def transcript_disposition(self) -> str:
        """Always :data:`RETAIN_VERBATIM`. Not a decision — an invariant (C-5)."""
        return RETAIN_VERBATIM

    def to_dict(self) -> dict[str, Any]:
        return {
            "segmentId": self.segment_id,
            "contentHash": self.scope.content_hash,
            "policyVersion": self.scope.policy_version,
            "classifierVersion": self.scope.classifier_version,
            "taxonomyVersion": self.scope.taxonomy_version,
            "thresholdSet": self.scope.threshold_set,
            "tenantId": self.scope.tenant_id,
            "contentHarm": self.content_harm.to_dict(),
            "injectionRisk": self.injection_risk.to_dict(),
            "clinical": {"signals": [s.to_dict() for s in self.clinical]},
            "window": self.window.to_dict(),
            "gatesDerivations": self.gates_derivations,
            "gatingReasons": list(self.gating_reasons),
            # Restated on every artifact rather than assumed by the reader.
            "transcriptDisposition": self.transcript_disposition,
            "sessionAggregate": dict(self.session_aggregate),
            "validatorId": self.validator_id,
            "createdAt": self.created_at,
        }


def content_hash(text: str) -> str:
    """The canonical content hash. Exact bytes only — never a semantic hash.

    Guardrail verdicts are adversarially sensitive: near-identical inputs can
    legitimately have opposite verdicts, so approximate matching is unsound here
    even though it is fine for answer caching.
    """
    return "sha256:" + hashlib.sha256((text or "").encode("utf-8")).hexdigest()
