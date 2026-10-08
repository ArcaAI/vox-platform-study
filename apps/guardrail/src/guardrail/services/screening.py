"""Bidirectional screening — the inbound prompt AND the outbound response.

Guardrail's earlier surface screened text in one direction only, and its
verdict (`{safe, issues, confidence}`) named neither the tenant whose policy
decided it, nor the model that ran, nor what would have happened had the check
failed. On a PHI platform that is not an auditable safety decision.

**What this module does**

* a check-by-check record — :class:`CheckOutcome` — carrying the check's name, what
  it FOUND (`verdict`), the ACTION configured for a violation, what the platform
  actually DID (`action_taken`), the model that answered and the regions / context
  items it screened;
* :meth:`Screener.screen_inbound` / :meth:`Screener.screen_inbound_regions` and
  :meth:`Screener.screen_outbound` (OWASP LLM05, improper output handling);
* one composition rule — **sanitize, then contain, then classify** — so the text
  that is screened is the text that will be executed.

**Decision (TASK-1050, README §9.2, §9.8.1).** Per check: `ignore` records only,
`warn` allows with a notice, `block` blocks. An UNDETERMINED check (classifier or
judge outage) DEGRADES to `unverified` — the request continues with a
`guardrail.unverified` notice — for every check, the locked medical one included
(OD-23); under an `ignore` action it is merely recorded. Precedence for the request:
block > warn > unverified > allow. The legacy `decision` field stays binary
(`allow` | `block`) because the callers that predate TASK-1050 reject any other value;
`warn` and `unverified` read as `allow` there. The four-valued answer is
:attr:`GuardrailDecision.guardrail_decision`.

**Region trust.** An `instruction` region decides at the check's action; a `data`
region decides at the check's DATA-region action (platform default `ignore` = the
TASK-1047 FC-5b record-only posture). The inbound JUDGES screen `data` regions only
(README §10.2 A3) — instruction text is governed at authoring time.

**Inbound judges are not band-gated (OD-42).** An enabled `injection_judge` /
`unsafe_content_judge` rides the per-window judge call the medical-scope judge
already makes: the screen builds the SAME plan as `/api/medical/validate`
(`judge_runner.plan_inbound_judge_calls`) and runs every group, so the call and its
window cache are shared and the locked `medical_validation` lane is decided here too
(skipped for a `medical_internal`-exempt request). With no inbound judge enabled the
screen makes no judge call at all (OD-6). On
such a call the inbound CLASSIFIER is no longer on the critical path for data
windows (TASK-1049 F6): data windows go to it only for a check whose data-region
action can change the decision, or as the judge-down FALLBACK (scored against the
row's `judgeBands` when it declares one). **Outbound judges are band-gated (OD-3 (b))**:
`clinical_safety_judge` and `leakage_judge` run when `response_safety`'s score falls in
its `judgeBands` band; `leakage_judge` also runs when the PII-leak or the
containment-echo check could not run.

**PHI safety is structural, not a review habit**: a :class:`GuardrailDecision`
holds names, labels, counts, offsets and item ids — never the analysed text, never a
matched substring, never a judge's reasoning.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from guardrail.core.availability import (
    ACTION_BLOCK,
    ACTION_IGNORE,
    ACTION_WARN,
    INBOUND_JUDGE_IDS,
    MEDICAL_VALIDATION,
    OUTBOUND_JUDGE_IDS,
    PLATFORM_DEFAULT_AVAILABILITY,
    GuardrailAvailability,
)
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.core.metrics import record_data_finding, record_screening_decision
from guardrail.core.policy import GuardrailPolicy
from guardrail.services.injection_defense import (
    SanitizationReport,
    contains_fence_echo,
    sanitize_untrusted,
)
from guardrail.services.pii_extraction import windowed_spans
from guardrail.services.safety_analyzer import _DEFAULT_BENIGN as _ANALYZER_DEFAULT_BENIGN
from guardrail.services.window_cache import answers_every_task
from guardrail.services.windowing import WindowGeometry, WindowRunner, region_windows

logger = get_logger(__name__)

DIRECTION_INBOUND: Final = "inbound"
DIRECTION_OUTBOUND: Final = "outbound"

DECISION_ALLOW: Final = "allow"
DECISION_BLOCK: Final = "block"
DECISION_WARN: Final = "warn"
DECISION_UNVERIFIED: Final = "unverified"

OUTCOME_PASS: Final = "pass"
OUTCOME_FLAG: Final = "flag"
OUTCOME_UNDETERMINED: Final = "undetermined"
OUTCOME_SKIPPED: Final = "skipped"

#: What the platform DID with a check's verdict (`GuardrailActionTaken`).
TAKEN_NONE: Final = "none"
TAKEN_IGNORE: Final = "ignore"
TAKEN_WARN: Final = "warn"
TAKEN_BLOCK: Final = "block"
TAKEN_UNVERIFIED: Final = "unverified"

_TAKEN_RANK: Final[dict[str, int]] = {
    TAKEN_NONE: 0,
    TAKEN_IGNORE: 1,
    TAKEN_UNVERIFIED: 2,
    TAKEN_WARN: 3,
    TAKEN_BLOCK: 4,
}
_ACTION_RANK: Final[dict[str, int]] = {ACTION_IGNORE: 0, ACTION_WARN: 1, ACTION_BLOCK: 2}

#: The reason recorded on a check the tenant's AVAILABILITY set does not select
#: (TASK-886). A `skipped` OUTCOME with a named reason rather than an omission.
REASON_NOT_SELECTED: Final = "not_selected_for_tenant"

#: A regions request whose regions are all empty (TASK-1047 FC-5 addendum).
REASON_NO_CONTENT: Final = "no_content"

#: An enabled inbound judge on a request that carried no `data` region (A3).
REASON_NO_DATA_REGIONS: Final = "no_data_regions"
#: A classifier check that screened nothing because the inbound judge covers the
#: data windows and no instruction region was sent (F6).
REASON_JUDGE_PRIMARY: Final = "judge_primary"
#: An outbound judge whose trigger (the `response_safety` band) did not fire.
REASON_NOT_IN_BAND: Final = "not_in_band"
#: The judge lane could not answer (no runner, an error, a missing window).
REASON_JUDGE_UNAVAILABLE: Final = "judge_unavailable"
#: The judge lane could not answer and the classifier answered in its place.
REASON_CLASSIFIER_FALLBACK: Final = "judge_unavailable_classifier_fallback"

FAIL_CLOSED: Final = "closed"

#: Region trust (TASK-1047 FC-5b, owner decision OD-13).
TRUST_INSTRUCTION: Final = "instruction"
TRUST_DATA: Final = "data"

#: The region key an outbound response is screened as, and the key a legacy
#: single-`text` inbound request is screened as.
REGION_RESPONSE: Final = "response"
REGION_PROMPT: Final = "prompt"

#: The moderation tasks each direction consults. The NAMES are part of the model
#: contract; the LABELS behind each name come from the registry taxonomy.
INBOUND_TASKS: Final = ("jailbreak_detection", "prompt_safety", "prompt_toxicity")
#: `jailbreak_detection` is on BOTH directions (TASK-878/G1), appended so
#: `reasons[0]` keeps naming `response_safety`.
OUTBOUND_TASKS: Final = (
    "response_safety",
    "response_toxicity",
    "response_refusal",
    "jailbreak_detection",
)

#: Every check DECLARES its posture here, once — not at the call site. The name is
#: kept for the TASK-886 membership rule; since TASK-1050 an undetermined check
#: degrades to `unverified` rather than blocking (OD-23).
_DECLARED_FAIL_MODES: Final[dict[str, str]] = {
    **dict.fromkeys(INBOUND_TASKS, FAIL_CLOSED),
    **dict.fromkeys(OUTBOUND_TASKS, FAIL_CLOSED),
    "pii_leak": FAIL_CLOSED,
    "containment_echo": FAIL_CLOSED,
    MEDICAL_VALIDATION: FAIL_CLOSED,
    **dict.fromkeys(INBOUND_JUDGE_IDS, FAIL_CLOSED),
    **dict.fromkeys(OUTBOUND_JUDGE_IDS, FAIL_CLOSED),
}

#: The classifier tasks that answer for an inbound judge lane when the judge is down.
_JUDGE_FALLBACK_TASKS: Final[dict[str, tuple[str, ...]]] = {
    "injection_judge": ("jailbreak_detection",),
    "unsafe_content_judge": ("prompt_safety", "prompt_toxicity"),
}

#: RE-EXPORTED from `safety_analyzer`, not restated: one label set decides "benign".
_DEFAULT_BENIGN: Final[frozenset[str]] = _ANALYZER_DEFAULT_BENIGN

#: A context item at the version that was screened: `(itemId, itemVersion)`.
ItemRef = tuple[str, int]


def action_taken_for(verdict: str, action: str) -> str:
    """What one verdict under one configured action DOES (README §9.2, §9.8.1)."""
    if verdict == OUTCOME_FLAG:
        return action if action in _ACTION_RANK else ACTION_BLOCK
    if verdict == OUTCOME_UNDETERMINED:
        # An outage degrades; under `ignore` it is merely recorded.
        return TAKEN_IGNORE if action == ACTION_IGNORE else TAKEN_UNVERIFIED
    return TAKEN_NONE


def compose_decision(taken: Sequence[str]) -> str:
    """block > warn > unverified > allow."""
    present = set(taken)
    if TAKEN_BLOCK in present:
        return DECISION_BLOCK
    if TAKEN_WARN in present:
        return DECISION_WARN
    if TAKEN_UNVERIFIED in present:
        return DECISION_UNVERIFIED
    return DECISION_ALLOW


def _strictest_taken(values: Sequence[str]) -> str:
    return max(values, key=lambda v: _TAKEN_RANK.get(v, 0), default=TAKEN_NONE)


def _unique(values: Sequence[Any]) -> tuple[Any, ...]:
    return tuple(dict.fromkeys(values))


@dataclass(frozen=True)
class CheckOutcome:
    """One check, and everything an auditor needs to interpret it."""

    name: str
    #: The LEGACY per-check outcome (`pass` | `flag` | `undetermined` | `skipped`), as
    #: decided for the deciding regions. Unchanged for callers that read it.
    outcome: str
    fail_mode: str
    model: str = ""
    reason: str = ""
    labels: tuple[str, ...] = ()
    #: What the check FOUND anywhere it looked (`""` = same as `outcome`).
    verdict: str = ""
    #: The configured action for a violation in the deciding context (`""` = not decided yet).
    action: str = ""
    #: What the platform DID (`""` = not decided yet; filled by the decision pass).
    action_taken: str = ""
    #: Classifier score in [0,1], higher = more unsafe, when the check has one.
    score: float | None = None
    category: str | None = None
    #: Judge confidence in [0,1], when a judge answered.
    confidence: float | None = None
    latency_ms: int = 0
    #: The regions (or judge windows) the check screened.
    region_keys: tuple[str, ...] = ()
    #: The regions whose finding produced `action_taken` (notice targets).
    flagged_regions: tuple[str, ...] = ()
    items: tuple[ItemRef, ...] = ()
    flagged_items: tuple[ItemRef, ...] = ()
    #: The resolved notice whose verified `X-Hope-Guardrail-Override` downgraded this
    #: check's block to a warn for this request (contract amendment 5d0760a60).
    override_notice_id: str | None = None

    @property
    def effective_verdict(self) -> str:
        return self.verdict or self.outcome

    @property
    def effective_action_taken(self) -> str:
        if self.action_taken:
            return self.action_taken
        # Not decided yet: the action-less reading (a flag blocks, an outage degrades).
        return action_taken_for(self.effective_verdict, self.action or ACTION_BLOCK)

    @property
    def blocks(self) -> bool:
        """True when this check's verdict STOPS the content under its action."""
        return self.effective_action_taken == TAKEN_BLOCK

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "outcome": self.outcome,
            "failMode": self.fail_mode,
            "model": self.model,
            "reason": self.reason,
            "labels": list(self.labels),
            # TASK-1050 — additive; no earlier reader looks at these keys.
            "verdict": self.effective_verdict,
            "action": self.action or None,
            "actionTaken": self.effective_action_taken,
            "score": self.score,
            "category": self.category,
            "confidence": self.confidence,
            "latencyMs": self.latency_ms,
            "regionKeys": list(self.region_keys),
        }


@dataclass(frozen=True)
class DataFinding:
    """A `data` region on which ≥1 inbound check flagged (FC-5b). Names only, never text.

    The outbound FC-5c finding (a record-only check) is retired with `outboundRecordOnlyChecks`
    (TASK-1050 follow-up B): the outbound screen reports none."""

    region: str
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"region": self.region, "reasons": list(self.reasons)}


@dataclass(frozen=True)
class GuardrailDecision:
    """An ATTRIBUTABLE screening verdict. Carries no analysed text."""

    tenant_id: str
    direction: str
    #: LEGACY binary decision (`allow` | `block`) — `warn` / `unverified` read `allow`.
    decision: str
    checks: list[CheckOutcome] = field(default_factory=list)
    #: The tier that supplied the policy — request tenant, or SYSTEM.
    policy_source_tenant_id: str | None = None
    #: The tier that supplied the AVAILABILITY set — request tenant, or SYSTEM (TASK-886).
    availability_source_tenant_id: str | None = None
    sanitization: SanitizationReport | None = None
    #: The delegated executor's OWN per-call usage, forwarded VERBATIM (TASK-878/G2).
    usage_detail: dict[str, Any] | None = None
    #: FC-5b inbound data findings (`None` on the outbound screen since FC-5c was retired).
    data_findings: list[DataFinding] | None = None
    #: TASK-1050: `allow` | `warn` | `block` | `unverified` (`""` = same as `decision`).
    guardrail_decision: str = ""
    #: The guardrail policy version the decision was made under (`""` = unknown).
    policy_version: str = ""

    @property
    def reasons(self) -> list[str]:
        """The names of the checks that caused a block, in evaluation order."""
        return [check.name for check in self.checks if check.blocks]

    @property
    def allowed(self) -> bool:
        return self.decision == DECISION_ALLOW

    @property
    def effective_decision(self) -> str:
        return self.guardrail_decision or self.decision

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenantId": self.tenant_id,
            "policySourceTenantId": self.policy_source_tenant_id,
            "availabilitySourceTenantId": self.availability_source_tenant_id,
            "direction": self.direction,
            "decision": self.decision,
            "guardrailDecision": self.effective_decision,
            "reasons": self.reasons,
            "checks": [check.to_dict() for check in self.checks],
            "sanitization": (
                self.sanitization.to_dict() if self.sanitization is not None else None
            ),
            "usageDetail": self.usage_detail,
            "policyVersion": self.policy_version or None,
            **(
                {"dataFindings": [finding.to_dict() for finding in self.data_findings]}
                if self.data_findings is not None
                else {}
            ),
        }


def _merge_labels(per_text: Sequence[dict[str, list[str]]]) -> dict[str, list[str]]:
    """Union of labels per task, first occurrence order (the window-merge rule)."""
    merged: dict[str, list[str]] = {}
    for labels_by_task in per_text:
        for name, labels in labels_by_task.items():
            bucket = merged.setdefault(name, [])
            bucket.extend(label for label in labels if label not in bucket)
    return merged


def _merge_scores(per_window: Sequence[dict[str, float]]) -> dict[str, float]:
    merged: dict[str, float] = {}
    for scores in per_window:
        for name, value in scores.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                merged[name] = max(float(value), merged.get(name, 0.0))
    return merged


def _unsafe_score(
    labels: Sequence[str], scores: Mapping[str, Any] | None, benign: frozenset[str]
) -> float | None:
    """One task's score in [0,1], higher = more unsafe (the TASK-1049 contract).

    The highest confidence behind a non-benign label; otherwise one minus the
    confidence of the benign label; ``None`` when the peer reported no confidences —
    never a fabricated zero.
    """
    if not isinstance(scores, Mapping) or not scores:
        return None
    flagged = [
        float(scores[label])
        for label in labels
        if label.lower() not in benign and isinstance(scores.get(label), (int, float))
    ]
    if flagged:
        return max(0.0, min(1.0, max(flagged)))
    benign_scores = [
        float(scores[label])
        for label in labels
        if label.lower() in benign and isinstance(scores.get(label), (int, float))
    ]
    if benign_scores:
        return max(0.0, min(1.0, 1.0 - max(benign_scores)))
    return None


@dataclass(frozen=True)
class _LocalJudgeWindow:
    """Duck-typed stand-in for `judge_runner.JudgeWindow` while that module is absent."""

    region_key: str
    text: str
    items: tuple[ItemRef, ...] = ()


def _judge_api() -> Any:
    """`services/judge_runner` (lane W2a1), or ``None`` before it is installed."""
    try:
        from guardrail.services import judge_runner
    except ImportError:
        return None
    required = ("JudgeWindow", "plan_inbound_judge_calls", "window_region_key", "region_of")
    return judge_runner if all(hasattr(judge_runner, name) for name in required) else None


def _window_key(region: str, offset: int) -> str:
    api = _judge_api()
    return api.window_region_key(region, offset) if api is not None else f"{region}@{offset}"


def _region_of(region_key: str) -> str:
    api = _judge_api()
    if api is not None:
        return str(api.region_of(region_key))
    return region_key.rsplit("@", 1)[0] if "@" in region_key else region_key


def _plan_inbound_judge_calls(
    regions: Sequence[tuple[str, str, str]],
    *,
    enabled_safety_lanes: Sequence[str],
    medical_skip: frozenset[str],
    geometry: WindowGeometry,
    include_medical: bool,
    items: Mapping[str, tuple[ItemRef, ...]],
) -> list[tuple[tuple[str, ...], list[Any]]]:
    """`judge_runner.plan_inbound_judge_calls` — the SAME plan the medical route builds.

    Same inputs ⇒ the same lane sets over the same windows, so the runner's single-flight
    and window cache make one call between the two routes. The local body is the
    identical algorithm, used only until lane W2a1's module is installed.
    """
    api = _judge_api()
    if api is not None:
        return list(
            api.plan_inbound_judge_calls(
                regions,
                enabled_safety_lanes=enabled_safety_lanes,
                medical_skip=medical_skip,
                geometry=geometry,
                include_medical=include_medical,
                items=items,
            )
        )
    safety = tuple(lane for lane in INBOUND_JUDGE_IDS if lane in set(enabled_safety_lanes))
    plan: dict[tuple[str, ...], list[Any]] = {}
    for key, text, trust in regions:
        wanted: list[str] = []
        if include_medical and key not in medical_skip:
            wanted.append(MEDICAL_VALIDATION)
        if trust == TRUST_DATA:
            wanted.extend(safety)
        if not wanted:
            continue
        lanes = tuple(wanted)
        for window in region_windows(key, text, geometry):
            plan.setdefault(lanes, []).append(
                _LocalJudgeWindow(_window_key(key, window.offset), window.text, items.get(key, ()))
            )
    return list(plan.items())


def _judge_window(region_key: str, text: str, items: tuple[ItemRef, ...]) -> Any:
    api = _judge_api()
    if api is None:
        return _LocalJudgeWindow(region_key=region_key, text=text, items=items)
    return api.JudgeWindow(region_key=region_key, text=text, items=items)


#: `core/policy.band_route` outcomes (lane W2a1).
_BAND_PASS: Final = "pass"
_BAND_JUDGE: Final = "judge"
_BAND_CLASSIFIER: Final = "classifier"


def _band_route(score: float, band: tuple[float, float]) -> str:
    """`core/policy.band_route`: below low PASS, in band the JUDGE, at/above high the CLASSIFIER."""
    try:
        from guardrail.core.policy import band_route  # type: ignore[attr-defined,unused-ignore]
    except ImportError:
        low, high = band
        if score < low:
            return _BAND_PASS
        return _BAND_JUDGE if score < high else _BAND_CLASSIFIER
    return str(band_route(score, band))


def _parse_band(blob: Mapping[str, Any], check_id: str) -> tuple[float, float] | None:
    """`judgeBands[check_id]` read directly — used only before lane W2a1's
    `GuardrailPolicy.judge_band` is installed. Same validity rule: 0 <= low <= high <= 1."""
    bands = blob.get("judgeBands") if isinstance(blob, Mapping) else None
    entry = bands.get(check_id) if isinstance(bands, Mapping) else None
    if not isinstance(entry, Mapping):
        return None
    low, high = entry.get("low"), entry.get("high")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (low, high)):
        return None
    if not 0.0 <= float(low) <= float(high) <= 1.0:  # type: ignore[arg-type]
        return None
    return float(low), float(high)  # type: ignore[arg-type]


@dataclass
class _ClassifierRun:
    """One delegated classification over a set of texts."""

    tasks: tuple[str, ...]
    indices: tuple[int, ...]
    labels: dict[int, dict[str, list[str]]] = field(default_factory=dict)
    scores: dict[int, dict[str, float]] = field(default_factory=dict)
    latency_ms: int = 0
    error: str | None = None


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
        judge_runner: Any = None,
        judge_geometry: WindowGeometry | None = None,
        judge_bands: Mapping[str, tuple[float, float]] | None = None,
        policy_version: str = "",
        screen_policy: GuardrailPolicy | None = None,
        medical_skip: frozenset[str] = frozenset(),
        pii_leak_quasi_identifier_labels: frozenset[str] = frozenset(),
    ) -> None:
        if not (tenant_id or "").strip():
            raise ValueError("Screener requires a tenant: decisions must be attributable")
        self._analyzer = analyzer
        self.tenant_id = tenant_id
        self.policy_source_tenant_id = policy_source_tenant_id
        self._max_untrusted_chars = max_untrusted_chars
        # AVAILABILITY (TASK-886 / TASK-1050 v2). The default is the catalogue set.
        self._availability = availability or PLATFORM_DEFAULT_AVAILABILITY
        self._pii_leak_min_score = self._availability.tighten("pii_leak", pii_leak_min_score)
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
        # TASK-1050 judge lanes. No runner ⇒ an enabled judge lane is undetermined
        # (degrades to `unverified`), never a pass.
        self.judge_runner = judge_runner
        self.judge_geometry = judge_geometry or window_geometry
        #: Explicit band overrides; otherwise `screen_policy.judge_band` (the
        #: `guardrail.safety` row's `judgeBands`, read fail-closed).
        self.judge_bands: dict[str, tuple[float, float]] = dict(judge_bands or {})
        self._screen_policy = screen_policy
        #: The region keys the medical lane skips (`medicalJudgeConfigRegions`).
        self.medical_skip = frozenset(medical_skip)
        #: `piiLeakQuasiIdentifierLabels` (follow-up A), case-folded: a pii_leak flag on these
        #: labels ALONE is taken at `warn` under a `block` action. Empty ⇒ no downgrade.
        self.pii_leak_quasi_identifier_labels = frozenset(
            label.strip().casefold() for label in pii_leak_quasi_identifier_labels if label.strip()
        )
        self.policy_version = policy_version

    @property
    def availability(self) -> GuardrailAvailability:
        return self._availability

    # -- helpers ------------------------------------------------------------

    def _benign(self) -> frozenset[str]:
        policy = getattr(self._analyzer, "policy", None)
        labels = getattr(policy, "benign_labels", None)
        return labels if isinstance(labels, frozenset) and labels else _DEFAULT_BENIGN

    def _benign_for(self, task: str) -> frozenset[str]:
        """``task``'s benign labels, read off the model that answers it (TASK-1049 R1:
        `jailbreak_detection` may be the `guardrail.injection` model's, not GLiGuard's)."""
        getter = getattr(self._analyzer, "benign_labels_for", None)
        if callable(getter):
            labels = getter(task)
            if isinstance(labels, frozenset) and labels:
                return labels
        return self._benign()

    def _route_groups(self, tasks: tuple[str, ...]) -> list[tuple[str, ...]]:
        """``tasks`` split by the model that answers them (one group when the analyzer
        routes nothing). Each group is its own classify call, window-cache entry and
        outage: a `guardrail.injection` failure leaves the GLiGuard checks decided."""
        getter = getattr(self._analyzer, "route_groups", None)
        if not callable(getter):
            return [tasks]
        groups = [tuple(group) for group in getter(tasks) if group]
        if sorted(name for group in groups for name in group) != sorted(tasks):
            return [tasks]
        return groups or [tasks]

    def _usage_detail(self) -> dict[str, Any] | None:
        """The delegated executor's own per-call usage, if it reported one."""
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

    def _skipped(self, name: str, reason: str, model: str = "") -> CheckOutcome:
        return CheckOutcome(
            name=name,
            outcome=OUTCOME_SKIPPED,
            fail_mode=_DECLARED_FAIL_MODES[name],
            model=model,
            reason=reason,
        )

    def _asked_tasks(self, tasks: tuple[str, ...]) -> tuple[str, ...]:
        """The tasks a classify call over ``tasks`` actually SENDS (the model declares them).

        Read off the analyzer (`SafetyAnalyzer.declared_tasks`); an analyzer that does not say
        is taken to send every task — the strict reading, so an omission is never cached.
        """
        getter = getattr(self._analyzer, "declared_tasks", None)
        if callable(getter):
            return tuple(getter(tasks))
        return tasks

    def _scored_seam(self) -> Any:
        seam = getattr(self._analyzer, "classify_tasks_scored", None)
        return seam if inspect.iscoroutinefunction(seam) else None

    async def _classify_texts(
        self, selected: tuple[str, ...], texts: Sequence[str]
    ) -> tuple[list[dict[str, list[str]]], list[dict[str, float]]]:
        """Classify every window of every text in ONE run; merge per text.

        Labels are the union across a text's windows; scores the max. When NO text
        produces a window the request is still asked as one empty window, attributed
        to the first text — no path composes an "allow" the model was never asked about.
        """
        owners: list[int] = []
        windows: list[str] = []
        for index, text in enumerate(texts):
            for window in region_windows(str(index), text, self.window_geometry):
                owners.append(index)
                windows.append(window.text)
        if not windows:
            owners, windows = [0], [""]
        model = self._model(selected[0])
        scored = self._scored_seam()

        async def _compute(window_text: str) -> dict[str, Any]:
            raw: Any
            scores_by_task: Any = {}
            if scored is not None:
                result = await self._analyzer.classify_tasks_scored(selected, window_text)
                raw = getattr(result, "labels", {}) or {}
                scores_by_task = getattr(result, "scores", {}) or {}
            else:
                raw = await self._analyzer.classify_tasks(selected, window_text)
            labels: dict[str, list[str]] = {}
            for name, value in (raw or {}).items():
                if value is None:
                    continue
                labels[str(name)] = (
                    [str(value)] if isinstance(value, str) else [str(v) for v in value]
                )
            scores: dict[str, float] = {}
            for name, task_labels in labels.items():
                task_scores = (
                    scores_by_task.get(name) if isinstance(scores_by_task, Mapping) else None
                )
                score = _unsafe_score(task_labels, task_scores, self._benign_for(name))
                if score is not None:
                    scores[name] = score
            return {"labels": labels, "scores": scores}

        verdicts = await self.window_runner.run(
            f"classify:{','.join(selected)}",
            model,
            windows,
            _compute,
            # Follow-up I: an answer that omits a task this call asked for is never cached.
            complete=answers_every_task(self._asked_tasks(selected)),
        )
        per_labels: list[list[dict[str, list[str]]]] = [[] for _ in range(max(1, len(texts)))]
        per_scores: list[list[dict[str, float]]] = [[] for _ in range(max(1, len(texts)))]
        for owner, verdict in zip(owners, verdicts, strict=True):
            per_labels[owner].append(verdict.get("labels") or {})
            per_scores[owner].append(verdict.get("scores") or {})
        return (
            [_merge_labels(found) for found in per_labels],
            [_merge_scores(found) for found in per_scores],
        )

    async def _classify_windows(
        self, selected: tuple[str, ...], texts: Sequence[str]
    ) -> list[dict[str, list[str]]]:
        """Labels only, per text (the TASK-1047 seam). Delegates to the analyzer via
        ``self._analyzer.classify_tasks`` (scored when it offers the scored seam)."""
        labels, _scores = await self._classify_texts(selected, texts)
        return labels

    async def _run_classifier(
        self, tasks: tuple[str, ...], indices: tuple[int, ...], texts: Sequence[str]
    ) -> _ClassifierRun:
        run = _ClassifierRun(tasks=tasks, indices=indices)
        started = time.monotonic()
        try:
            labels, scores = await self._classify_texts(tasks, [texts[i] for i in indices])
        except GuardrailUndeterminedError as exc:
            logger.warning(
                "guardrail.screen.undetermined", tenant_id=self.tenant_id, reason=exc.reason
            )
            run.error = exc.reason
        else:
            for position, index in enumerate(indices):
                run.labels[index] = labels[position] if position < len(labels) else {}
                run.scores[index] = scores[position] if position < len(scores) else {}
        run.latency_ms = int((time.monotonic() - started) * 1000)
        return run

    async def _run_classifiers(
        self, tasks: tuple[str, ...], indices: tuple[int, ...], texts: Sequence[str]
    ) -> list[_ClassifierRun]:
        """One `_run_classifier` per model group, concurrently (TASK-1049 R1)."""
        groups = self._route_groups(tasks)
        if len(groups) == 1:
            return [await self._run_classifier(groups[0], indices, texts)]
        return list(
            await asyncio.gather(*(self._run_classifier(group, indices, texts) for group in groups))
        )

    async def _classify(
        self,
        task_names: tuple[str, ...],
        texts: Sequence[str],
        *,
        data_mask: Sequence[bool] | None = None,
        keys: Sequence[str] | None = None,
        direction: str = DIRECTION_INBOUND,
        data_tasks: tuple[str, ...] | None = None,
        items: Mapping[str, tuple[ItemRef, ...]] | None = None,
    ) -> tuple[list[CheckOutcome], list[tuple[int, tuple[str, ...]]]]:
        """Run the SELECTED moderation tasks and decide each one per region trust.

        Returns the checks and the DATA findings (FC-5b): ``(text index, flagged
        check names in task order)`` for every data text on which a check flagged.
        An instruction text decides at the check's action, a data text at its DATA
        action (default `ignore`). ``data_tasks`` (F6) narrows which tasks the data
        texts are sent for; ``None`` sends every selected task (today's behaviour).
        An outage makes the affected checks undetermined (→ `unverified`).

        Only the selected tasks reach the delegated classifier (via
        ``self._classify_windows`` / its scored twin), but every declared name stays
        on the record, in the caller's order.
        """
        selected = self._availability.selected(task_names)
        if not selected:
            logger.info(
                "guardrail.screen.no_selected_checks",
                tenant_id=self.tenant_id,
                availability_source_tenant_id=self._availability.source_tenant_id,
                tasks=list(task_names),
            )
            return [self._not_selected(name) for name in task_names], []

        mask = list(data_mask) if data_mask is not None else [False] * len(texts)
        region_keys = (
            list(keys)
            if keys is not None
            else [REGION_PROMPT if direction == DIRECTION_INBOUND else REGION_RESPONSE] * len(texts)
        )
        item_map = items or {}
        runs: list[_ClassifierRun] = []
        if data_tasks is None or not any(mask):
            runs.extend(
                await self._run_classifiers(tuple(selected), tuple(range(len(texts))), texts)
            )
        else:
            instruction = tuple(i for i, is_data in enumerate(mask) if not is_data)
            data = tuple(i for i, is_data in enumerate(mask) if is_data)
            data_selected = tuple(t for t in selected if t in data_tasks)
            jobs = []
            if instruction:
                jobs.append(self._run_classifiers(tuple(selected), instruction, texts))
            if data_selected and data:
                jobs.append(self._run_classifiers(data_selected, data, texts))
            runs = [run for group in await asyncio.gather(*jobs) for run in group] if jobs else []

        outcomes: list[CheckOutcome] = []
        for name in task_names:
            if name not in selected:
                outcomes.append(self._not_selected(name))
                continue
            covering = [run for run in runs if name in run.tasks]
            if not covering:
                outcomes.append(self._skipped(name, REASON_JUDGE_PRIMARY, self._model(name)))
                continue
            covered = sorted({index for run in covering for index in run.indices})
            keys_seen = _unique([region_keys[i] for i in covered])
            items_seen = _unique([ref for i in covered for ref in item_map.get(region_keys[i], ())])
            latency = max(run.latency_ms for run in covering)
            failed = [run for run in covering if run.error is not None]
            if failed:
                trusts = {TRUST_DATA if mask[i] else TRUST_INSTRUCTION for i in covered}
                action = max(
                    (self._availability.action_for(name, direction, trust=t) for t in trusts),
                    key=lambda a: _ACTION_RANK.get(a, 2),
                )
                outcomes.append(
                    CheckOutcome(
                        name=name,
                        outcome=OUTCOME_UNDETERMINED,
                        fail_mode=_DECLARED_FAIL_MODES[name],
                        model=self._model(name),
                        reason=str(failed[0].error),
                        verdict=OUTCOME_UNDETERMINED,
                        action=action,
                        action_taken=action_taken_for(OUTCOME_UNDETERMINED, action),
                        latency_ms=latency,
                        region_keys=keys_seen,
                        flagged_regions=keys_seen,
                        items=items_seen,
                        flagged_items=items_seen,
                    )
                )
                continue
            per_labels = {i: run.labels.get(i, {}) for run in covering for i in run.indices}
            per_scores = {i: run.scores.get(i, {}) for run in covering for i in run.indices}
            if not any(name in per_labels.get(i, {}) for i in covered):
                # The taxonomy does not declare this task — not run, never invented.
                outcomes.append(self._skipped(name, "not_in_taxonomy", self._model(name)))
                continue
            instr_action = self._availability.action_for(name, direction, trust=TRUST_INSTRUCTION)
            data_action = self._availability.action_for(name, direction, trust=TRUST_DATA)
            benign = self._benign_for(name)
            parts: list[tuple[int, str, tuple[str, ...]]] = []
            for i in covered:
                flagged = tuple(
                    label
                    for label in per_labels.get(i, {}).get(name, [])
                    if label.lower() not in benign
                )
                if flagged:
                    parts.append((i, data_action if mask[i] else instr_action, flagged))
            taken = _strictest_taken([p[1] for p in parts]) if parts else TAKEN_NONE
            deciding = [p for p in parts if not mask[p[0]] or p[1] != ACTION_IGNORE]
            labels = _unique([label for p in deciding for label in p[2]])
            all_labels = _unique([label for p in parts for label in p[2]])
            target_parts = [p for p in parts if p[1] == taken]
            scores = [per_scores[i][name] for i in covered if name in per_scores.get(i, {})]
            outcomes.append(
                CheckOutcome(
                    name=name,
                    outcome=OUTCOME_FLAG if deciding else OUTCOME_PASS,
                    fail_mode=_DECLARED_FAIL_MODES[name],
                    model=self._model(name),
                    reason="label_flagged" if deciding else "",
                    labels=labels,
                    verdict=OUTCOME_FLAG if parts else OUTCOME_PASS,
                    action=instr_action if any(not mask[i] for i in covered) else data_action,
                    action_taken=taken,
                    score=max(scores) if scores else None,
                    category=all_labels[0] if all_labels else None,
                    latency_ms=latency,
                    region_keys=keys_seen,
                    flagged_regions=_unique([region_keys[p[0]] for p in target_parts]),
                    items=items_seen,
                    flagged_items=_unique(
                        [ref for p in target_parts for ref in item_map.get(region_keys[p[0]], ())]
                    ),
                )
            )
        findings: list[tuple[int, tuple[str, ...]]] = []
        labels_by_text = {i: run.labels.get(i, {}) for run in runs for i in run.indices}
        for index, is_data in enumerate(mask if data_mask is not None else ()):
            if not is_data:
                continue
            reasons = tuple(
                name
                for name in task_names
                if name in selected
                and any(
                    lbl.lower() not in self._benign_for(name)
                    for lbl in labels_by_text.get(index, {}).get(name, [])
                )
            )
            if reasons:
                findings.append((index, reasons))
        return outcomes, findings

    # -- judges -------------------------------------------------------------

    def _band(self, check_id: str) -> tuple[float, float] | None:
        """``check_id``'s borderline band, or ``None`` when none is declared.

        `GuardrailPolicy.judge_band` (lane W2a1) is fail-CLOSED and raises for an absent or
        malformed band; here that means "no band", so nothing is routed on a guessed one.
        """
        if check_id in self.judge_bands:
            return self.judge_bands[check_id]
        policy = self._screen_policy
        if policy is None:
            return None
        getter = getattr(policy, "judge_band", None)
        if callable(getter):
            try:
                low, high = getter(check_id)
            except GuardrailUndeterminedError:
                return None
            return float(low), float(high)
        return _parse_band(getattr(policy, "blob", {}) or {}, check_id)

    async def _run_judge(
        self,
        direction: str,
        lanes: tuple[str, ...],
        windows: Sequence[Any],
        *,
        mode: str,
        prompt_context: str | None = None,
    ) -> Mapping[tuple[str, str], Any]:
        """One runner call. Results are keyed ``(lane, window.region_key)``. Never raises."""
        if self.judge_runner is None or not windows or not lanes:
            return {}
        try:
            results = await self.judge_runner.judge(
                tenant_id=self.tenant_id,
                direction=direction,
                lanes=lanes,
                windows=list(windows),
                mode=mode,
                prompt_context=prompt_context,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — an outage degrades, never a pass
            logger.warning(
                "guardrail.screen.judge_failed",
                tenant_id=self.tenant_id,
                direction=direction,
                error_type=type(exc).__name__,
            )
            return {}
        return results if isinstance(results, Mapping) else {}

    @staticmethod
    def _aggregate_lane(
        lane: str, windows: Sequence[Any], results: Mapping[tuple[str, str], Any]
    ) -> dict[str, Any]:
        """Worst-of over the windows a lane was asked about: flag > undetermined > pass."""
        flags: list[tuple[Any, Any]] = []
        passes: list[Any] = []
        reasons: list[str] = []
        models: list[str] = []
        latency = 0
        for window in windows:
            verdict = results.get((lane, window.region_key))
            if verdict is None:
                reasons.append(REASON_JUDGE_UNAVAILABLE)
                continue
            models.append(str(getattr(verdict, "model", "") or ""))
            latency = max(latency, int(getattr(verdict, "latency_ms", 0) or 0))
            value = getattr(verdict, "verdict", OUTCOME_UNDETERMINED)
            if value == OUTCOME_FLAG:
                flags.append((window, verdict))
            elif value == OUTCOME_PASS:
                passes.append(verdict)
            else:
                # On `undetermined` the runner's `category` is the REASON code (JUDGE_*).
                reasons.append(str(getattr(verdict, "category", None) or REASON_JUDGE_UNAVAILABLE))
        if flags:
            outcome = OUTCOME_FLAG
        elif reasons:
            outcome = OUTCOME_UNDETERMINED
        else:
            outcome = OUTCOME_PASS
        conf = [getattr(v, "confidence", None) for _w, v in flags] or [
            getattr(v, "confidence", None) for v in passes
        ]
        numbers = [float(c) for c in conf if isinstance(c, (int, float))]
        confidence: float | None = None
        if numbers and outcome == OUTCOME_FLAG:
            confidence = max(numbers)
        elif numbers and outcome == OUTCOME_PASS:
            confidence = min(numbers)
        return {
            "verdict": outcome,
            "category": next(
                (str(v.category) for _w, v in flags if getattr(v, "category", None)),
                None,
            ),
            "confidence": confidence,
            "tiers": tuple(getattr(v, "tier", None) for _w, v in flags),
            "reason": reasons[0] if outcome == OUTCOME_UNDETERMINED else "",
            "model": next((m for m in models if m), ""),
            "latency_ms": latency,
            "region_keys": _unique([w.region_key for w in windows]),
            "flagged_regions": _unique([w.region_key for w, _v in flags]),
            "items": _unique([ref for w in windows for ref in w.items]),
            "flagged_items": _unique([ref for w, _v in flags for ref in w.items]),
        }

    def _judge_check(
        self, lane: str, agg: dict[str, Any], direction: str, *, trust: str | None = None
    ) -> CheckOutcome:
        """One judge lane's check. A native tier mapped to `warn` / `block` is a FIXED
        outcome; a tier `flag` (and every criteria-json flag) takes the configured action."""
        action = self._availability.action_for(lane, direction, trust=trust)
        verdict = agg["verdict"]
        locked = self._availability.is_locked(lane)
        if verdict == OUTCOME_FLAG:
            if not locked and not self._availability.direction_enabled(direction):
                taken = TAKEN_IGNORE  # monitor only (OD-7)
            elif locked:
                taken = action
            else:
                per_flag = [
                    tier if tier in (ACTION_WARN, ACTION_BLOCK) else action
                    for tier in (agg.get("tiers") or (None,))
                ]
                taken = _strictest_taken(per_flag)
        else:
            taken = action_taken_for(verdict, action)
        flagged = verdict == OUTCOME_FLAG
        acted = taken != TAKEN_NONE
        return CheckOutcome(
            name=lane,
            outcome=verdict,
            fail_mode=_DECLARED_FAIL_MODES[lane],
            model=agg["model"],
            reason=agg.get("reason") or ("judge_flagged" if flagged else ""),
            labels=(agg["category"],) if flagged and agg["category"] else (),
            verdict=verdict,
            action=action,
            action_taken=taken,
            score=agg.get("score"),
            category=agg["category"] if flagged else None,
            confidence=agg["confidence"],
            latency_ms=agg["latency_ms"],
            region_keys=agg["region_keys"],
            flagged_regions=(
                (agg["flagged_regions"] if flagged else agg["region_keys"]) if acted else ()
            ),
            items=agg["items"],
            flagged_items=((agg["flagged_items"] if flagged else agg["items"]) if acted else ()),
        )

    async def _judge_fallback(
        self,
        lane: str,
        data: Sequence[tuple[str, str]],
        items: Mapping[str, tuple[ItemRef, ...]],
    ) -> dict[str, Any] | None:
        """The classifier answers for an inbound judge lane that could not (OD-42).

        Routed by the classifier task's `judgeBands` band when one is declared
        (`band_route`: below low PASS, in band the judge would decide — it is down, so
        UNDETERMINED — at/above high the CLASSIFIER verdict stands); with no band the label
        decides. ``None`` when the classifier cannot answer either.
        """
        tasks = _JUDGE_FALLBACK_TASKS.get(lane, ())
        if not tasks or not data:
            return None
        started = time.monotonic()
        try:
            labels, scores = await self._classify_texts(tasks, [text for _k, text in data])
        except GuardrailUndeterminedError:
            return None
        flagged_keys: list[str] = []
        category: str | None = None
        undetermined = False
        answered = False
        top: float | None = None
        for position, (key, _text) in enumerate(data):
            text_labels = labels[position] if position < len(labels) else {}
            text_scores = scores[position] if position < len(scores) else {}
            for task in tasks:
                if task not in text_labels:
                    continue
                answered = True
                bad = [
                    lbl for lbl in text_labels[task] if lbl.lower() not in self._benign_for(task)
                ]
                score = text_scores.get(task)
                if score is not None:
                    top = score if top is None else max(top, score)
                band = self._band(task)
                route = _band_route(score, band) if band is not None and score is not None else None
                if route == _BAND_PASS:
                    continue
                if route == _BAND_JUDGE:
                    undetermined = True
                    continue
                if bad:
                    flagged_keys.append(key)
                    category = category or bad[0]
        if not answered:
            return None
        verdict = (
            OUTCOME_FLAG
            if flagged_keys
            else (OUTCOME_UNDETERMINED if undetermined else OUTCOME_PASS)
        )
        keys = _unique([k for k, _t in data])
        flagged = _unique(flagged_keys)
        return {
            "verdict": verdict,
            "category": category,
            "confidence": None,
            "tiers": (),
            "score": top,
            "reason": REASON_CLASSIFIER_FALLBACK,
            "model": self._model(tasks[0]),
            "latency_ms": int((time.monotonic() - started) * 1000),
            "region_keys": keys,
            "flagged_regions": flagged,
            "items": _unique([ref for k in keys for ref in items.get(k, ())]),
            "flagged_items": _unique([ref for k in flagged for ref in items.get(k, ())]),
        }

    async def _inbound_judges(
        self,
        regions: Sequence[tuple[str, str, str]],
        items: Mapping[str, tuple[ItemRef, ...]],
        *,
        has_content: bool,
        include_medical: bool = True,
    ) -> list[CheckOutcome]:
        """The enabled inbound judge lanes (OD-42), on DATA windows only (A3).

        The plan is `plan_inbound_judge_calls` over the request's regions — the SAME plan
        the medical route builds — and EVERY group runs, so the medical lane rides the same
        per-window calls (shared through the runner's single-flight and window cache) and is
        decided here too. With no inbound judge enabled nothing runs: the medical route
        then judges on its own path, and the screen adds no judge call (OD-6, M-3).
        """
        enabled = self._availability.selected(INBOUND_JUDGE_IDS)
        if not enabled:
            return []
        if not has_content:
            return [self._skipped(lane, REASON_NO_CONTENT) for lane in enabled]
        present = [(key, text, trust) for key, text, trust in regions if text]
        plan = _plan_inbound_judge_calls(
            present,
            enabled_safety_lanes=enabled,
            medical_skip=self.medical_skip,
            geometry=self.judge_geometry,
            include_medical=include_medical,
            items=items,
        )
        answers = await asyncio.gather(
            *(
                self._run_judge(DIRECTION_INBOUND, tuple(lanes), windows, mode="prompt")
                for lanes, windows in plan
            )
        )
        results: dict[tuple[str, str], Any] = {}
        windows_by_lane: dict[str, list[Any]] = {}
        for (lanes, windows), answer in zip(plan, answers, strict=True):
            results.update(answer)
            for lane in lanes:
                windows_by_lane.setdefault(lane, []).extend(windows)

        data = [(key, text) for key, text, trust in present if trust == TRUST_DATA]
        checks: list[CheckOutcome] = []
        for lane in enabled:
            lane_windows = windows_by_lane.get(lane, [])
            if not lane_windows:
                checks.append(self._skipped(lane, REASON_NO_DATA_REGIONS))
                continue
            agg = self._aggregate_lane(lane, lane_windows, results)
            if agg["verdict"] == OUTCOME_UNDETERMINED:
                fallback = await self._judge_fallback(lane, data, items)
                if fallback is not None:
                    agg = fallback
            checks.append(self._judge_check(lane, agg, DIRECTION_INBOUND, trust=TRUST_DATA))
        medical_windows = windows_by_lane.get(MEDICAL_VALIDATION, [])
        if include_medical and medical_windows:
            agg = self._aggregate_lane(MEDICAL_VALIDATION, medical_windows, results)
            checks.append(self._judge_check(MEDICAL_VALIDATION, agg, DIRECTION_INBOUND))
        return checks

    async def _outbound_judges(
        self,
        response: str,
        checks: Sequence[CheckOutcome],
        items: tuple[ItemRef, ...],
        *,
        prompt_context: str | None = None,
    ) -> list[CheckOutcome]:
        """The enabled outbound judge lanes, band-gated on `response_safety` (OD-3 (b))."""
        enabled = self._availability.selected(OUTBOUND_JUDGE_IDS)
        if not enabled:
            return []
        by_name = {check.name: check for check in checks}
        safety = by_name.get("response_safety")
        band = self._band("response_safety")
        in_band = bool(
            band is not None
            and safety is not None
            and safety.score is not None
            and _band_route(safety.score, band) == _BAND_JUDGE
        )
        side_checks_skipped = any(
            by_name.get(name) is not None and by_name[name].outcome == OUTCOME_SKIPPED
            for name in ("pii_leak", "containment_echo")
        )
        triggered = tuple(
            lane for lane in enabled if in_band or (lane == "leakage_judge" and side_checks_skipped)
        )
        windows = [
            _judge_window(_window_key(REGION_RESPONSE, window.offset), window.text, items)
            for window in region_windows(REGION_RESPONSE, response, self.judge_geometry)
        ]
        results: Mapping[tuple[str, str], Any] = {}
        if triggered and windows:
            results = await self._run_judge(
                DIRECTION_OUTBOUND,
                triggered,
                windows,
                mode="response",
                prompt_context=prompt_context,
            )
        out: list[CheckOutcome] = []
        for lane in enabled:
            if lane not in triggered:
                out.append(self._skipped(lane, REASON_NOT_IN_BAND))
                continue
            if not windows:
                out.append(self._skipped(lane, REASON_NO_CONTENT))
                continue
            agg = self._aggregate_lane(lane, windows, results)
            out.append(self._judge_check(lane, agg, DIRECTION_OUTBOUND))
        return out

    # -- decision -----------------------------------------------------------

    def _decide(self, direction: str, check: CheckOutcome) -> CheckOutcome:
        """Fill `action` / `action_taken` on a check its producer left undecided."""
        if check.action_taken:
            return check
        action = check.action or self._availability.action_for(check.name, direction)
        taken = action_taken_for(check.effective_verdict, action)
        flagged = taken != TAKEN_NONE
        return dataclasses.replace(
            check,
            action=action,
            action_taken=taken,
            flagged_regions=check.flagged_regions or (check.region_keys if flagged else ()),
            flagged_items=check.flagged_items or (check.items if flagged else ()),
        )

    def _finish(
        self,
        direction: str,
        checks: list[CheckOutcome],
        report: SanitizationReport | None,
        data_findings: list[DataFinding] | None = None,
    ) -> GuardrailDecision:
        decided = [self._decide(direction, check) for check in checks]
        outcome = compose_decision([check.effective_action_taken for check in decided])
        decision = GuardrailDecision(
            tenant_id=self.tenant_id,
            direction=direction,
            decision=DECISION_BLOCK if outcome == DECISION_BLOCK else DECISION_ALLOW,
            checks=decided,
            policy_source_tenant_id=self.policy_source_tenant_id,
            availability_source_tenant_id=self._availability.source_tenant_id,
            sanitization=report,
            usage_detail=self._usage_detail(),
            data_findings=data_findings,
            guardrail_decision=outcome,
            policy_version=self.policy_version,
        )
        reasons = decision.reasons
        record_screening_decision(direction, outcome, reasons[0] if reasons else "none")
        logger.info(
            "guardrail.screen.decided",
            tenant_id=self.tenant_id,
            direction=direction,
            decision=outcome,
            reasons=reasons,
            warned=[c.name for c in decided if c.effective_action_taken == TAKEN_WARN],
            unverified=[c.name for c in decided if c.effective_action_taken == TAKEN_UNVERIFIED],
        )
        if data_findings:
            for finding in data_findings:
                for task in finding.reasons:
                    record_data_finding(task)
            # PHI-safe: region KEYS and check names only, never the region text.
            logger.info(
                "guardrail.screen.data_findings",
                tenant_id=self.tenant_id,
                direction=direction,
                decision=outcome,
                regions=[finding.region for finding in data_findings],
                findings=[finding.to_dict() for finding in data_findings],
                count=sum(len(finding.reasons) for finding in data_findings),
            )
        return decision

    # -- inbound ------------------------------------------------------------

    async def screen_inbound(self, text: str, *, kind: str = "content") -> GuardrailDecision:
        """Screen untrusted inbound content (T1/T2/T3) — one `instruction` text.

        Sanitizes FIRST, then classifies the sanitized text. The inbound judges
        screen data regions only, so an enabled judge is `skipped` here.
        """
        clean, report = sanitize_untrusted(text, max_chars=self._max_untrusted_chars)
        checks, _ = await self._classify(INBOUND_TASKS, [clean], keys=[REGION_PROMPT])
        checks.extend(
            # A legacy single text is one INSTRUCTION region: no inbound judge screens it
            # (A3), and its medical check stays with `/api/medical/validate`'s whole-text
            # path, which a windowed screen could not share a call with.
            await self._inbound_judges(
                [(REGION_PROMPT, clean, TRUST_INSTRUCTION)],
                {},
                has_content=bool(clean),
                include_medical=False,
            )
        )
        return self._finish(DIRECTION_INBOUND, checks, report)

    async def screen_inbound_regions(
        self,
        regions: Sequence[tuple[str, str] | tuple[str, str, str]],
        *,
        kind: str = "content",
        items: Mapping[str, Sequence[ItemRef]] | None = None,
        include_medical: bool = True,
    ) -> GuardrailDecision:
        """Screen untrusted inbound REGIONS (TASK-1047 FC-5) — each windowed on its own.

        A region is ``(key, text)`` or ``(key, text, trust)`` (FC-5b); trust
        defaults to `instruction`. ``items`` maps a region key to the context items
        (at the screened version) behind it — they travel onto the evaluation record
        and the notices.
        """
        keys: list[str] = []
        data_mask: list[bool] = []
        cleaned: list[str] = []
        removed: dict[str, int] = {}
        truncated = False
        original = sanitized = 0
        for region in regions:
            key, text = region[0], region[1]
            trust = region[2] if len(region) > 2 else TRUST_INSTRUCTION
            keys.append(key)
            data_mask.append(trust == TRUST_DATA)
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
        item_map = {key: tuple(refs) for key, refs in (items or {}).items()}
        has_data = any(data_mask)
        data_findings: list[DataFinding] | None = [] if has_data else None
        trusted = [
            (key, text, TRUST_DATA if is_data else TRUST_INSTRUCTION)
            for key, text, is_data in zip(keys, cleaned, data_mask, strict=True)
        ]
        if not any(cleaned):
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
            checks.extend(await self._inbound_judges(trusted, item_map, has_content=False))
            return self._finish(DIRECTION_INBOUND, checks, report, data_findings)

        judge_primary = has_data and bool(self._availability.selected(INBOUND_JUDGE_IDS))
        # F6: with a judge on the data windows, the classifier sees them only for a
        # check whose data-region action can change the decision.
        data_tasks = (
            tuple(
                task
                for task in INBOUND_TASKS
                if self._availability.action_for(task, DIRECTION_INBOUND, trust=TRUST_DATA)
                != ACTION_IGNORE
            )
            if judge_primary
            else None
        )
        (checks, found), judges = await asyncio.gather(
            self._classify(
                INBOUND_TASKS,
                cleaned,
                data_mask=data_mask if has_data else None,
                keys=keys,
                direction=DIRECTION_INBOUND,
                data_tasks=data_tasks,
                items=item_map,
            ),
            self._inbound_judges(
                trusted, item_map, has_content=True, include_medical=include_medical
            ),
        )
        if has_data:
            data_findings = [DataFinding(region=keys[index], reasons=r) for index, r in found]
        checks.extend(judges)
        return self._finish(DIRECTION_INBOUND, checks, report, data_findings)

    # -- outbound -----------------------------------------------------------

    async def screen_outbound(
        self,
        response: str,
        *,
        source_context: str | None = None,
        nonce: str | None = None,
        source_regions: Sequence[tuple[str, str]] | None = None,
        response_items: Sequence[ItemRef] | None = None,
        prompt_context: str | None = None,
    ) -> GuardrailDecision:
        """Screen a model response before it reaches a clinician (T4/T5/T6).

        ``source_regions`` (TASK-1047 FC-5) replaces ``source_context`` when given.
        ``response_items`` names the generated context item(s) the response becomes.
        """
        clean, report = sanitize_untrusted(response, max_chars=self._max_untrusted_chars)
        refs = tuple(response_items or ())
        checks, _ = await self._classify(
            OUTBOUND_TASKS,
            [clean],
            keys=[REGION_RESPONSE],
            direction=DIRECTION_OUTBOUND,
            items={REGION_RESPONSE: refs},
        )
        sources: list[str] | None
        if source_regions is not None:
            sources = [text for _key, text in source_regions if text and text.strip()]
        elif source_context is not None:
            sources = [source_context] if source_context.strip() else []
        else:
            sources = None
        checks.append(await self._check_pii_leak(clean, sources, refs))
        checks.append(self._check_containment_echo(clean, nonce, refs))
        checks.extend(
            await self._outbound_judges(clean, checks, refs, prompt_context=prompt_context)
        )
        # TASK-1050 follow-up B: no record-only set any more — every outbound check decides at
        # its configured action (`ignore` = recorded only), so there are no outbound findings.
        return self._finish(DIRECTION_OUTBOUND, checks, report)

    async def _check_pii_leak(
        self, response: str, sources: list[str] | None, refs: tuple[ItemRef, ...] = ()
    ) -> CheckOutcome:
        """PII in the response that is absent from the declared source is a leak.

        Without a source context the check CANNOT RUN: recorded as skipped, never passed.
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

        started = time.monotonic()
        try:
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
                latency_ms=int((time.monotonic() - started) * 1000),
                region_keys=(REGION_RESPONSE,),
                items=refs,
            )

        haystacks = [source.casefold() for source in sources]
        leaked: list[str] = []
        for span in spans:
            if float(getattr(span, "score", 1.0)) < self._pii_leak_min_score:
                continue
            fragment = response[int(span.start) : int(span.end)].strip()
            if fragment and not any(fragment.casefold() in hay for hay in haystacks):
                # The LABEL is recorded, never the fragment — the fragment is the PHI.
                leaked.append(str(span.label))

        latency_ms = int((time.monotonic() - started) * 1000)
        if not leaked:
            return CheckOutcome(
                name=name,
                outcome=OUTCOME_PASS,
                fail_mode=_DECLARED_FAIL_MODES[name],
                model=self._model(name),
                latency_ms=latency_ms,
                region_keys=(REGION_RESPONSE,),
                items=refs,
            )
        action = self._availability.action_for(name, DIRECTION_OUTBOUND)
        taken = action_taken_for(OUTCOME_FLAG, action)
        quasi_only = bool(self.pii_leak_quasi_identifier_labels) and all(
            label.strip().casefold() in self.pii_leak_quasi_identifier_labels for label in leaked
        )
        if taken == TAKEN_BLOCK and quasi_only:
            # Follow-up A: quasi-identifiers alone warn — never stricter than configured, and an
            # unlisted label (a direct identifier, a secret) keeps the configured action.
            taken = TAKEN_WARN
        acted = taken != TAKEN_NONE
        return CheckOutcome(
            name=name,
            outcome=OUTCOME_FLAG,
            fail_mode=_DECLARED_FAIL_MODES[name],
            model=self._model(name),
            reason="pii_absent_from_source",
            labels=tuple(leaked),
            verdict=OUTCOME_FLAG,
            action=action,
            action_taken=taken,
            category=leaked[0],
            latency_ms=latency_ms,
            region_keys=(REGION_RESPONSE,),
            flagged_regions=(REGION_RESPONSE,) if acted else (),
            items=refs,
            flagged_items=refs if acted else (),
        )

    def _check_containment_echo(
        self, response: str, nonce: str | None, refs: tuple[ItemRef, ...] = ()
    ) -> CheckOutcome:
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
            category="envelope_echoed" if echoed else None,
            region_keys=(REGION_RESPONSE,),
            items=refs,
        )
