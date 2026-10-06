"""Bidirectional screening — the inbound prompt AND the outbound response.

Guardrail's earlier surface screened text in one direction only, and its
verdict (`{safe, issues, confidence}`) named neither the tenant whose policy
decided it, nor the model that ran, nor what would have happened had the check
failed. On a PHI platform that is not an auditable safety decision.

**What this module adds**

* a check-by-check record — :class:`CheckOutcome` — carrying the check's name, its
  outcome, its **DECLARED** fail mode, the model that answered and the config tier
  that supplied the policy;
* :meth:`Screener.screen_outbound`, which did not exist: response safety/toxicity/
  refusal, a PHI-leakage check against the declared source, and containment-echo
  detection, all BEFORE a response reaches a clinician (OWASP LLM05, improper
  output handling);
* one composition rule — **sanitize, then contain, then classify** — so the text
  that is screened is the text that will be executed.

**Fail posture is declared per check, in `_DECLARED_FAIL_MODES`, and every check
here is fail-CLOSED.** A screening check that could not run yields
``outcome="undetermined"`` and the overall decision is BLOCK. There is no path
through this module that answers "allow" without a model having answered — which
is the same invariant `core/errors.py` states for the analyzer, restated at the
level where a decision is composed from several checks.

**PHI safety is structural, not a review habit**: a :class:`GuardrailDecision`
holds names, labels, counts and offsets — never the analysed text, never a matched
substring.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from guardrail.core.availability import PLATFORM_DEFAULT_AVAILABILITY, GuardrailAvailability
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.core.metrics import record_screening_decision
from guardrail.core.policy import GuardrailPolicy
from guardrail.services.injection_defense import (
    SanitizationReport,
    contains_fence_echo,
    sanitize_untrusted,
)
from guardrail.services.pii_extraction import windowed_spans
from guardrail.services.safety_analyzer import _DEFAULT_BENIGN as _ANALYZER_DEFAULT_BENIGN
from guardrail.services.windowing import WindowGeometry, WindowRunner, region_windows

logger = get_logger(__name__)

DIRECTION_INBOUND: Final = "inbound"
DIRECTION_OUTBOUND: Final = "outbound"

DECISION_ALLOW: Final = "allow"
DECISION_BLOCK: Final = "block"

OUTCOME_PASS: Final = "pass"
OUTCOME_FLAG: Final = "flag"
OUTCOME_UNDETERMINED: Final = "undetermined"
OUTCOME_SKIPPED: Final = "skipped"

#: The reason recorded on a check the tenant's AVAILABILITY set does not select
#: (TASK-886). It is deliberately a `skipped` OUTCOME with a named reason rather
#: than an omission: a de-selected check must stay on the record, or a dashboard
#: reads "not run" as "passed" and nobody can tell a narrowed tenant from a
#: broken one.
REASON_NOT_SELECTED: Final = "not_selected_for_tenant"

#: A regions request whose regions are all empty (TASK-1047 FC-5 addendum).
REASON_NO_CONTENT: Final = "no_content"

FAIL_CLOSED: Final = "closed"

#: The moderation tasks each direction consults. The NAMES are part of the model
#: contract (they are the schema keys the safety model was trained on); the LABELS
#: behind each name are configuration and come from the registry taxonomy.
INBOUND_TASKS: Final = ("jailbreak_detection", "prompt_safety", "prompt_toxicity")
#: `jailbreak_detection` is on BOTH directions (TASK-878/G1). A response that
#: echoes — or complies with — an injected instruction is exactly what a
#: post-receive check exists to catch, and it was inbound-only. It is APPENDED so
#: `reasons[0]` keeps naming `response_safety` for every rejection that already
#: had that label, and it costs no extra peer call: `_classify` sends the whole
#: tuple in ONE delegated `classify`.
OUTBOUND_TASKS: Final = (
    "response_safety",
    "response_toxicity",
    "response_refusal",
    "jailbreak_detection",
)

#: Every check DECLARES its posture here, once — not at the call site. All of them
#: are fail-closed: each one gates content reaching, or produced for, a clinician.
_DECLARED_FAIL_MODES: Final[dict[str, str]] = {
    **dict.fromkeys(INBOUND_TASKS, FAIL_CLOSED),
    **dict.fromkeys(OUTBOUND_TASKS, FAIL_CLOSED),
    "pii_leak": FAIL_CLOSED,
    "containment_echo": FAIL_CLOSED,
}

#: Labels that mean "nothing detected". Bootstrap set only — the registry row's
#: `benignLabels` overrides it through the analyzer's policy.
#:
#: RE-EXPORTED from `safety_analyzer`, not restated. This
#: module used to declare its own SUPERSET (`clean`/`no`/`false` on top), so one
#: label set decided "benign" in the analyzer and a different one decided it here.
#: The two are reached on different paths — the analyzer's rides
#: `SafetyPolicy.benign_labels`, this one is the fallback when no policy is
#: attached — so a model emitting `"clean"` was benign to the screener and UNSAFE
#: to the analyzer. Two literals for one concept is the defect; the narrower set
#: wins because a label that means "nothing detected" must be declared, not guessed.
_DEFAULT_BENIGN: Final[frozenset[str]] = _ANALYZER_DEFAULT_BENIGN


@dataclass(frozen=True)
class CheckOutcome:
    """One check, and everything an auditor needs to interpret it."""

    name: str
    outcome: str
    fail_mode: str
    model: str = ""
    reason: str = ""
    labels: tuple[str, ...] = ()

    @property
    def blocks(self) -> bool:
        """Fail-CLOSED: both a flag and an unrunnable check stop the content."""
        return self.outcome in (OUTCOME_FLAG, OUTCOME_UNDETERMINED)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "outcome": self.outcome,
            "failMode": self.fail_mode,
            "model": self.model,
            "reason": self.reason,
            "labels": list(self.labels),
        }


@dataclass(frozen=True)
class GuardrailDecision:
    """An ATTRIBUTABLE screening verdict. Carries no analysed text."""

    tenant_id: str
    direction: str
    decision: str
    checks: list[CheckOutcome] = field(default_factory=list)
    #: The tier that supplied the policy — request tenant, or SYSTEM.
    policy_source_tenant_id: str | None = None
    #: The tier that supplied the AVAILABILITY set — request tenant, or SYSTEM
    #: (TASK-886). DISTINCT from `policy_source_tenant_id`: the policy blob rides
    #: the selected model's registry row, the availability set is its own row, and
    #: the two cascades can legitimately answer from different tiers. A screening
    #: decision must name BOTH or it cannot be reconstructed.
    availability_source_tenant_id: str | None = None
    sanitization: SanitizationReport | None = None
    #: The delegated executor's OWN per-call usage, forwarded VERBATIM (TASK-878/G2).
    #: Guardrail is a peer service with no gateway in front of it, so riding back on
    #: the verdict is the only path a delegated call's spend has to the billing
    #: plane. ``None`` — never ``{}`` and never zeros — when no delegated call
    #: reported one: a zero row tells the billing plane the call was FREE rather
    #: than that it never happened (the rule `_stats_of` states on /medical/validate).
    usage_detail: dict[str, Any] | None = None

    @property
    def reasons(self) -> list[str]:
        """The names of the checks that caused a block, in evaluation order."""
        return [check.name for check in self.checks if check.blocks]

    @property
    def allowed(self) -> bool:
        return self.decision == DECISION_ALLOW

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenantId": self.tenant_id,
            "policySourceTenantId": self.policy_source_tenant_id,
            "availabilitySourceTenantId": self.availability_source_tenant_id,
            "direction": self.direction,
            "decision": self.decision,
            "reasons": self.reasons,
            "checks": [check.to_dict() for check in self.checks],
            "sanitization": (
                self.sanitization.to_dict() if self.sanitization is not None else None
            ),
            "usageDetail": self.usage_detail,
        }


class Screener:
    """Composes the declared checks for one tenant into one attributable decision."""

    def __init__(
        self,
        *,
        analyzer: Any,
        tenant_id: str,
        policy_source_tenant_id: str | None = None,
        max_untrusted_chars: int | None = None,
        pii_leak_min_score: float = 0.5,
        availability: GuardrailAvailability | None = None,
        window_geometry: WindowGeometry | None = None,
        window_runner: WindowRunner | None = None,
    ) -> None:
        if not (tenant_id or "").strip():
            # Same construction-time invariant as the peer clients: a screening
            # decision that cannot be attributed must not be renderable at all.
            raise ValueError("Screener requires a tenant: decisions must be attributable")
        self._analyzer = analyzer
        self.tenant_id = tenant_id
        self.policy_source_tenant_id = policy_source_tenant_id
        self._max_untrusted_chars = max_untrusted_chars
        # AVAILABILITY (TASK-886). The default is the FULL declared set, not an
        # empty one: an un-wired screener must screen everything, never nothing.
        self._availability = availability or PLATFORM_DEFAULT_AVAILABILITY
        # The tenant's threshold may only TIGHTEN the model row's value. Composed
        # once here so no call site can compose it the other way round.
        self._pii_leak_min_score = self._availability.tighten("pii_leak", pii_leak_min_score)
        # REGION WINDOWS (TASK-1047 D4). The default is the declared policy
        # geometry with no cache — an un-wired screener still never sends more than
        # one window to the peer, it just computes every one of them.
        if window_geometry is None:
            defaults = GuardrailPolicy.from_blob({})
            size, overlap = defaults.screen_window_geometry
            window_geometry = WindowGeometry(size, overlap, defaults.screen_window_concurrency)
        self.window_geometry = window_geometry
        self.window_runner = window_runner or WindowRunner(
            tenant_id=tenant_id,
            policy_version=None,
            cache=None,
            concurrency=window_geometry.concurrency,
        )

    # -- helpers ------------------------------------------------------------

    def _benign(self) -> frozenset[str]:
        policy = getattr(self._analyzer, "policy", None)
        labels = getattr(policy, "benign_labels", None)
        return labels if isinstance(labels, frozenset) and labels else _DEFAULT_BENIGN

    def _usage_detail(self) -> dict[str, Any] | None:
        """The delegated executor's own per-call usage, if it reported one.

        Telemetry must never decide a safety verdict, so an analyzer that does not
        expose the seam — or raises reaching for it — costs the caller its billing
        row, not its decision.
        """
        getter = getattr(self._analyzer, "usage_detail", None)
        if not callable(getter):
            return None
        try:
            usage = getter()
        except Exception:  # noqa: BLE001 — a telemetry read never breaks a decision
            return None
        return usage if isinstance(usage, dict) and usage else None

    def _model(self, check: str) -> str:
        getter = getattr(self._analyzer, "model_for", None)
        if callable(getter):
            return str(getter(check) or "")
        return ""

    def _not_selected(self, name: str) -> CheckOutcome:
        """A check this tenant's availability set does not select (TASK-886)."""
        return CheckOutcome(
            name=name,
            outcome=OUTCOME_SKIPPED,
            fail_mode=_DECLARED_FAIL_MODES[name],
            model=self._model(name),
            reason=REASON_NOT_SELECTED,
        )

    async def _classify_windows(
        self, selected: tuple[str, ...], texts: Sequence[str]
    ) -> dict[str, Any]:
        """Classify every window of every text; merge the labels per task.

        A task's labels are the union across windows, so "block if ANY window
        blocks" falls out of the per-task flag below. A task absent from EVERY
        window's answer is absent from the merge (not in the taxonomy). Texts that
        produce no window at all (empty) are still asked as one empty window — no
        path composes an "allow" the model was never asked about.
        """
        windows = [
            w.text
            for index, text in enumerate(texts)
            for w in region_windows(str(index), text, self.window_geometry)
        ] or [""]
        model = self._model(selected[0])

        async def _compute(window_text: str) -> dict[str, Any]:
            raw = await self._analyzer.classify_tasks(selected, window_text)
            labels: dict[str, list[str]] = {}
            for name, value in (raw or {}).items():
                if value is None:
                    continue
                labels[str(name)] = (
                    [str(value)] if isinstance(value, str) else [str(v) for v in value]
                )
            return {"labels": labels}

        verdicts = await self.window_runner.run(
            f"classify:{','.join(selected)}", model, windows, _compute
        )
        merged: dict[str, list[str]] = {}
        for verdict in verdicts:
            for name, labels in (verdict.get("labels") or {}).items():
                bucket = merged.setdefault(name, [])
                bucket.extend(label for label in labels if label not in bucket)
        return merged

    async def _classify(
        self, task_names: tuple[str, ...], texts: Sequence[str]
    ) -> list[CheckOutcome]:
        """Run the SELECTED moderation tasks; an outage marks every one undetermined.

        Only the tasks this tenant's availability set selects are sent to the
        delegated classifier — the de-selected ones cost no peer call — but every
        declared name still appears in the returned list, in the caller's order,
        so `reasons[0]` keeps naming the same check and a de-selected check is
        visibly `skipped` rather than absent.

        When NOTHING is selected for a direction the classifier is not called at
        all, and the gate still composes a verdict from the skipped record. That
        is a platform admin's explicit, audited narrowing — never a tenant's, and
        never a silent one.
        """
        selected = self._availability.selected(task_names)
        if not selected:
            logger.info(
                "guardrail.screen.no_selected_checks",
                tenant_id=self.tenant_id,
                availability_source_tenant_id=self._availability.source_tenant_id,
                tasks=list(task_names),
            )
            return [self._not_selected(name) for name in task_names]

        try:
            results = await self._classify_windows(tuple(selected), texts)
        except GuardrailUndeterminedError as exc:
            logger.warning(
                "guardrail.screen.undetermined",
                tenant_id=self.tenant_id,
                reason=exc.reason,
            )
            return [
                (
                    CheckOutcome(
                        name=name,
                        outcome=OUTCOME_UNDETERMINED,
                        fail_mode=_DECLARED_FAIL_MODES[name],
                        model=self._model(name),
                        reason=exc.reason,
                    )
                    if name in selected
                    else self._not_selected(name)
                )
                for name in task_names
            ]

        benign = self._benign()
        outcomes: list[CheckOutcome] = []
        for name in task_names:
            if name not in selected:
                outcomes.append(self._not_selected(name))
                continue
            value = results.get(name)
            if value is None:
                # The taxonomy simply does not declare this task — it did not run,
                # and guardrail never invents one. Not a failure; recorded as such.
                outcomes.append(
                    CheckOutcome(
                        name=name,
                        outcome=OUTCOME_SKIPPED,
                        fail_mode=_DECLARED_FAIL_MODES[name],
                        model=self._model(name),
                        reason="not_in_taxonomy",
                    )
                )
                continue
            labels = [value] if isinstance(value, str) else [str(v) for v in value]
            flagged = tuple(lbl for lbl in labels if lbl.lower() not in benign)
            outcomes.append(
                CheckOutcome(
                    name=name,
                    outcome=OUTCOME_FLAG if flagged else OUTCOME_PASS,
                    fail_mode=_DECLARED_FAIL_MODES[name],
                    model=self._model(name),
                    reason="label_flagged" if flagged else "",
                    labels=flagged,
                )
            )
        return outcomes

    def _finish(
        self,
        direction: str,
        checks: list[CheckOutcome],
        report: SanitizationReport | None,
    ) -> GuardrailDecision:
        blocked = any(check.blocks for check in checks)
        decision = GuardrailDecision(
            tenant_id=self.tenant_id,
            direction=direction,
            decision=DECISION_BLOCK if blocked else DECISION_ALLOW,
            checks=checks,
            policy_source_tenant_id=self.policy_source_tenant_id,
            availability_source_tenant_id=self._availability.source_tenant_id,
            sanitization=report,
            usage_detail=self._usage_detail(),
        )
        record_screening_decision(
            direction, decision.decision, decision.reasons[0] if blocked else "none"
        )
        logger.info(
            "guardrail.screen.decided",
            tenant_id=self.tenant_id,
            direction=direction,
            decision=decision.decision,
            reasons=decision.reasons,
        )
        return decision

    # -- inbound ------------------------------------------------------------

    async def screen_inbound(self, text: str, *, kind: str = "content") -> GuardrailDecision:
        """Screen untrusted inbound content (T1/T2/T3).

        Sanitizes FIRST, then classifies the sanitized text — screening the raw
        text while the model reads a different string checks something nobody
        executes.
        """
        clean, report = sanitize_untrusted(text, max_chars=self._max_untrusted_chars)
        checks = await self._classify(INBOUND_TASKS, [clean])
        return self._finish(DIRECTION_INBOUND, checks, report)

    async def screen_inbound_regions(
        self, regions: Sequence[tuple[str, str]], *, kind: str = "content"
    ) -> GuardrailDecision:
        """Screen untrusted inbound REGIONS (TASK-1047 FC-5) — each windowed on its own.

        Same composition rule as :meth:`screen_inbound` — sanitize, then classify
        the sanitized text — applied per region, so every region's windows are cut
        from that region's own start. The containment bound applies per region and
        the sanitization report is the aggregate (counts only, never text).
        """
        cleaned: list[str] = []
        removed: dict[str, int] = {}
        truncated = False
        original = sanitized = 0
        for _key, text in regions:
            clean, part = sanitize_untrusted(text, max_chars=self._max_untrusted_chars)
            cleaned.append(clean)
            for name, count in part.removed.items():
                removed[name] = removed.get(name, 0) + count
            truncated = truncated or part.truncated
            original += part.original_length
            sanitized += part.sanitized_length
        report = SanitizationReport(
            removed=removed,
            truncated=truncated,
            original_length=original,
            sanitized_length=sanitized,
        )
        if not any(cleaned):
            # Nothing exists to be unsafe (FC-5 addendum: `regions: []` / all-empty
            # is ALLOW). Recorded as `skipped/no_content`, never as a model `pass`.
            checks = [
                CheckOutcome(
                    name=name,
                    outcome=OUTCOME_SKIPPED,
                    fail_mode=_DECLARED_FAIL_MODES[name],
                    model=self._model(name),
                    reason=REASON_NO_CONTENT,
                )
                for name in INBOUND_TASKS
            ]
        else:
            checks = await self._classify(INBOUND_TASKS, cleaned)
        return self._finish(DIRECTION_INBOUND, checks, report)

    # -- outbound -----------------------------------------------------------

    async def screen_outbound(
        self,
        response: str,
        *,
        source_context: str | None = None,
        nonce: str | None = None,
        source_regions: Sequence[tuple[str, str]] | None = None,
    ) -> GuardrailDecision:
        """Screen a model response before it reaches a clinician (T4/T5/T6).

        ``source_regions`` (TASK-1047 FC-5) replaces ``source_context`` when given:
        the governed system prompt is no longer part of the source, only the data
        regions are.
        """
        clean, report = sanitize_untrusted(response, max_chars=self._max_untrusted_chars)
        checks = await self._classify(OUTBOUND_TASKS, [clean])
        sources: list[str] | None
        if source_regions is not None:
            sources = [text for _key, text in source_regions if text and text.strip()]
        elif source_context is not None:
            sources = [source_context] if source_context.strip() else []
        else:
            sources = None
        checks.append(await self._check_pii_leak(clean, sources))
        checks.append(self._check_containment_echo(clean, nonce))
        return self._finish(DIRECTION_OUTBOUND, checks, report)

    async def _check_pii_leak(self, response: str, sources: list[str] | None) -> CheckOutcome:
        """PII in the response that is absent from the declared source is a leak.

        Either the model hallucinated an identifier or it surfaced one from outside
        this consultation; both are reportable, and neither is deliverable.

        Without a source context the check CANNOT RUN. It is recorded as skipped
        rather than passed — a check that silently passes when its input is missing
        is worse than no check, because a dashboard reads it as green.
        """
        name = "pii_leak"
        if not self._availability.is_enabled(name):
            return self._not_selected(name)
        if not sources:
            return CheckOutcome(
                name=name,
                outcome=OUTCOME_SKIPPED,
                fail_mode=_DECLARED_FAIL_MODES[name],
                model=self._model(name),
                reason="no_source_context",
            )

        try:
            # Windowed like every other screen (TASK-1047 C2): the response never
            # reaches the PII model in one call, and its spans come back in
            # response coordinates.
            spans = await windowed_spans(
                self.window_runner,
                self._analyzer.extract_pii_entities,
                self._model(name),
                [(None, response)],
                self.window_geometry,
            )
        except GuardrailUndeterminedError as exc:
            return CheckOutcome(
                name=name,
                outcome=OUTCOME_UNDETERMINED,
                fail_mode=_DECLARED_FAIL_MODES[name],
                model=self._model(name),
                reason=exc.reason,
            )

        haystacks = [source.casefold() for source in sources]
        leaked: list[str] = []
        for span in spans:
            if float(getattr(span, "score", 1.0)) < self._pii_leak_min_score:
                continue
            fragment = response[int(span.start) : int(span.end)].strip()
            # Present in ANY one source region — never matched across a boundary
            # between two regions, which no source actually contains.
            if fragment and not any(fragment.casefold() in hay for hay in haystacks):
                # The LABEL is recorded, never the fragment — this record is an
                # audit artefact, and the fragment is the PHI.
                leaked.append(str(span.label))

        return CheckOutcome(
            name=name,
            outcome=OUTCOME_FLAG if leaked else OUTCOME_PASS,
            fail_mode=_DECLARED_FAIL_MODES[name],
            model=self._model(name),
            reason="pii_absent_from_source" if leaked else "",
            labels=tuple(leaked),
        )

    def _check_containment_echo(self, response: str, nonce: str | None) -> CheckOutcome:
        """A response repeating the containment token means the boundary failed (T6)."""
        name = "containment_echo"
        if not self._availability.is_enabled(name):
            return self._not_selected(name)
        if not nonce:
            return CheckOutcome(
                name=name,
                outcome=OUTCOME_SKIPPED,
                fail_mode=_DECLARED_FAIL_MODES[name],
                reason="no_nonce",
            )
        echoed = contains_fence_echo(response, nonce)
        return CheckOutcome(
            name=name,
            outcome=OUTCOME_FLAG if echoed else OUTCOME_PASS,
            fail_mode=_DECLARED_FAIL_MODES[name],
            reason="envelope_echoed" if echoed else "",
        )
