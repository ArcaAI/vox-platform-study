"""Composing T0 and T1 into the three-axis verdict, on two clocks.

Phase 1 is **T0 + T1 only — no LLM judge.** T2 stays where TASK-818 §3B put it:
ambiguity only, hard wall-clock cap, and never inline on a streaming summary.

**The two clocks.** A finalized segment is validated in the streaming tier, on the
utterance clock, and the result drives the clinician-facing signals and caches
the task-agnostic half. A downstream task is gated in the consumption tier, on
the checkpoint clock, over the CUMULATIVE artifact. The second is not an
optimisation of the first; they answer different questions, and §5.2's cost
argument is what makes running the expensive one on the cumulative affordable —
~10-20 cumulative passes over a 30-60 minute encounter, off the interactive path.

**Chunking, never truncating.** ``sanitize_untrusted`` bounds untrusted input by
TRUNCATING it, which is right for a one-shot screen and catastrophic here: a
guardrail that inspects the first N characters of a cumulative transcript while
the model reads all of it IS Prompt Overflow. So the cumulative path windows the
whole text and reports ``inspected_chars`` over the whole text. What the ceiling
bounds is how much goes in VERBATIM (§5.2 mechanism 3) — the earlier prefix is
represented by a rolling summary that is itself a validated artifact — and that
is a caller obligation this module reports on rather than silently performs.

**Which statistic the session aggregate is, and why the verdict says so.**
§5.1's arithmetic wants a graded per-window score. ``apps/nlp``'s guard-classify
surface used to answer with LABELS alone, so the only computable score was
categorical (flagged / not flagged) and the session mean was a **flag RATE** —
not the confidence mean whose "0.32 benign -> 0.628 flagged" separation §5.1
cites. TASK-830 added per-label confidences to that surface, so when the executor
reports them each window contributes a real graded risk and the mean is the
statistic §5.1 describes.

Both cases remain reachable — a peer that reports no confidence still gets a
correct categorical verdict — so ``scoreCalibration`` is computed per aggregate
rather than asserted: ``graded`` only when EVERY window folded in carried a
confidence, ``categorical`` otherwise, with ``gradedWindows`` alongside
``windows`` so a partial session is auditable. A threshold calibrated for one
statistic is meaningless against the other, which is the whole reason the field
exists; per-tenant θ/Θ calibration must be done against a ``graded`` aggregate.
"""

from __future__ import annotations

import hashlib
import time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from guardrail.core.errors import REASON_UNSUPPORTED, GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.realtime.consumption import CapabilityPolicy
from guardrail.realtime.deterministic import DeterministicRuleSet, StreamMatcher, summarise
from guardrail.realtime.session_state import SessionRiskPolicy, SessionRiskState
from guardrail.realtime.store import RealtimeStore, segment_key, session_key
from guardrail.realtime.verdict import (
    ClinicalSignal,
    ContentHarm,
    InjectionRisk,
    TranscriptSegmentVerdict,
    VerdictScope,
    WindowAssertion,
    content_harm_cache_key,
    content_hash,
)
from guardrail.services.injection_defense import sanitize_untrusted

logger = get_logger(__name__)

#: The scope a STREAMING-tier verdict is computed under: no consumer, therefore
#: no capability. Deliberately absent from any declared capability set, so it can
#: never satisfy a consumption request — a segment verdict must never authorise
#: a read, and the scope labels say so rather than implying otherwise.
STREAM_ASSEMBLY: Final = "stream.segment@1"
STREAM_CAPABILITY_SET: Final = "none"

CALIBRATION_CATEGORICAL: Final = "categorical"
CALIBRATION_GRADED: Final = "graded"


@dataclass(frozen=True)
class AxisTasks:
    """Which moderation tasks feed which axis. Configuration, and fail-closed.

    Without this declaration there is no way to know whether a flagged task
    should gate a derivation or page a clinician — and guessing is exactly the
    C-1 failure. So an absent declaration raises rather than defaulting.
    """

    content_harm: tuple[str, ...]
    injection_risk: tuple[str, ...]
    clinical: tuple[str, ...]

    def fingerprint(self) -> str:
        """Which task feeds which axis — i.e. which signals GATE (C-1)."""
        return "|".join(
            ",".join(sorted(axis))
            for axis in (self.content_harm, self.injection_risk, self.clinical)
        )

    @classmethod
    def from_declaration(cls, declaration: Mapping[str, Any] | None) -> AxisTasks:
        blob = declaration or {}
        harm = tuple(str(t) for t in blob.get("contentHarm") or ())
        injection = tuple(str(t) for t in blob.get("injectionRisk") or ())
        clinical = tuple(str(t) for t in blob.get("clinical") or ())
        if not (harm or injection):
            raise GuardrailUndeterminedError(
                REASON_UNSUPPORTED,
                "the realtime axis map is unresolved (failMode=closed): declare "
                "`labelTaxonomy.realtime.axes` with `contentHarm` and `injectionRisk` "
                "task lists on the guardrail.safety model row. Which signals GATE and "
                "which merely inform a clinician is a policy decision, not a default",
            )
        overlap = (set(harm) | set(injection)) & set(clinical)
        if overlap:
            raise GuardrailUndeterminedError(
                REASON_UNSUPPORTED,
                f"tasks {sorted(overlap)} are declared as BOTH gating and clinical; a "
                "clinical signal must never gate (C-1), so the map is ambiguous",
            )
        return cls(content_harm=harm, injection_risk=injection, clinical=clinical)

    @property
    def all_tasks(self) -> tuple[str, ...]:
        return (*self.content_harm, *self.injection_risk, *self.clinical)


@dataclass(frozen=True)
class RealtimePolicy:
    """One tenant's fully-resolved realtime policy. Nothing here has a literal."""

    axes: AxisTasks
    rules: DeterministicRuleSet
    capabilities: CapabilityPolicy
    session: SessionRiskPolicy
    lexicons: Mapping[str, Sequence[str]] = field(default_factory=dict)
    benign_labels: frozenset[str] = frozenset()
    window_chars: int = 4_000
    overlap_chars: int = 256
    ceiling_chars: int = 120_000
    ttl_s: int = 3_600
    policy_version: int = 0
    classifier_version: str = ""
    taxonomy_version: str = ""
    threshold_set: str = "default"
    source_tenant_id: str | None = None

    @property
    def stamp(self) -> str:
        """Everything a verdict computed under this policy DEPENDED ON.

        The four declared versions are not enough on their own. They are operator-
        maintained integers and strings, while the values that actually decide a
        verdict — the noise floor, the declared phrases, the capability sets, the
        axis map, the window geometry — live on `_metadata` and can all be edited
        without touching any of them. A cache keyed on the declared versions alone
        therefore keeps serving pre-change verdicts after a change, which is worst
        exactly when it matters most: an operator TIGHTENING the guardrail during
        an incident gets the old answers until the TTL expires.

        So the stamp is derived from the resolved policy rather than asserted
        beside it, and it is a PROPERTY rather than a constructor argument — a
        future construction site cannot forget to pass it, and cannot pass one
        that disagrees with the policy it accompanies.

        `ttl_s` is deliberately absent: how long a verdict may be reused is not
        part of what the verdict SAYS, so changing it must not throw away a
        warm cache.
        """
        parts: tuple[str, ...] = (
            str(self.policy_version),
            self.classifier_version,
            self.taxonomy_version,
            self.threshold_set,
            # Provenance: a tenant taking over from SYSTEM is a governance event,
            # and a safety cache should re-derive across it rather than inherit.
            str(self.source_tenant_id or ""),
            self.axes.fingerprint(),
            self.rules.declaration_digest,
            self.capabilities.fingerprint(),
            f"{self.session.noise_floor}",
            f"{self.session.excess_risk_threshold}",
            f"{self.session.consecutive_limit}",
            f"{self.session.mean_score_threshold}",
            f"{self.session.min_windows_for_mean}",
            f"{self.window_chars}",
            f"{self.overlap_chars}",
            f"{self.ceiling_chars}",
            "\x1f".join(sorted(self.benign_labels)),
            "\x1f".join(
                f"{name}={','.join(sorted(str(t) for t in terms))}"
                for name, terms in sorted(self.lexicons.items())
            ),
        )
        return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()


def _windows(text: str, size: int, overlap: int) -> Iterator[tuple[int, str]]:
    """Cover the WHOLE text. The last window is short, never dropped."""
    if not text:
        return
    step = max(1, size - max(0, overlap))
    start = 0
    while start < len(text):
        yield start, text[start : start + size]
        if start + size >= len(text):
            return
        start += step


class RealtimeValidator:
    """One tenant, one session's worth of realtime validation."""

    def __init__(
        self,
        *,
        analyzer: Any,
        policy: RealtimePolicy,
        tenant_id: str,
        store: RealtimeStore,
        validator_id: str = "guardrail.realtime",
    ) -> None:
        if not (tenant_id or "").strip():
            raise ValueError("RealtimeValidator requires a tenant: verdicts are attributable")
        self._analyzer = analyzer
        self._policy = policy
        self._tenant_id = tenant_id
        self._store = store
        self._validator_id = validator_id

    # -- public surface -----------------------------------------------------

    async def validate_segment(
        self, *, session_id: str, segment_id: str, text: str
    ) -> TranscriptSegmentVerdict:
        """Streaming tier. Never produces a complete consumption window."""
        verdict = await self._validate(
            session_id=session_id,
            artifact_id=segment_id,
            text=text,
            assembly_template_id=STREAM_ASSEMBLY,
            capability_set_id=STREAM_CAPABILITY_SET,
            complete=False,
        )
        # The handle consumers read the verdict BY, so a fan-out of three tasks
        # is three store reads and one classification — not three classifications
        # producing three verdicts on the same text.
        stored = verdict.to_dict()
        # The policy this verdict was computed under, so a reader can tell whether
        # it is still the policy in force. The store key cannot carry this: a
        # consumer reads by segment id and holds no policy to key with.
        stored["policyStamp"] = self._policy.stamp
        await self._store.put(segment_key(self._tenant_id, segment_id), stored, self._policy.ttl_s)
        return verdict

    async def read_segment_verdict(self, segment_id: str) -> dict[str, Any] | None:
        """What a consumer calls instead of guardrail. Tenant-scoped by key.

        A verdict computed under a policy that is no longer in force is a MISS,
        not a hit: the caller revalidates under the current policy rather than
        acting on an answer the platform has since changed its mind about. This
        is the read-side half of invalidation — the config-invalidation channel
        drops the CONFIG cache so the new policy is resolved, and this drops the
        VERDICTS that the old one produced. Without it, tightening a threshold
        mid-incident has no effect until the TTL expires.

        Recomputing is cheap (T0 is ~0.03 ms per utterance) and correct; serving
        a stale safety verdict is neither.
        """
        held = await self._store.get(segment_key(self._tenant_id, segment_id))
        if held is None:
            return None
        if held.get("policyStamp") != self._policy.stamp:
            logger.info(
                "guardrail.realtime.verdict_stale",
                segment_id=segment_id,
                reason="policy_changed_since_validation",
            )
            return None
        return held

    async def validate_cumulative(
        self,
        *,
        session_id: str,
        text: str,
        assembly_template_id: str,
        capability_set_id: str,
    ) -> TranscriptSegmentVerdict:
        """Consumption tier. The unit is the whole artifact (C-2)."""
        return await self._validate(
            session_id=session_id,
            artifact_id=f"cumulative:{session_id}",
            text=text,
            assembly_template_id=assembly_template_id,
            capability_set_id=capability_set_id,
            complete=True,
        )

    # -- the shared body ----------------------------------------------------

    async def _validate(
        self,
        *,
        session_id: str,
        artifact_id: str,
        text: str,
        assembly_template_id: str,
        capability_set_id: str,
        complete: bool,
    ) -> TranscriptSegmentVerdict:
        policy = self._policy
        # Sanitize, then classify — the text that is screened must be the text
        # that will be executed. NO max_chars here: bounding by truncation is
        # exactly the failure this tier exists to prevent (see module docstring).
        clean, _sanitization = sanitize_untrusted(text)

        session_state, session_matcher = await self._load_session(session_id)

        # ── which state this pass folds into ────────────────────────────────
        #
        # The two tiers must NOT share an accumulator, and the reason is a false
        # positive rather than a false negative. The consumption tier re-reads
        # the whole transcript at every checkpoint, so folding its windows into
        # the persistent session state counts the same prefix once per
        # checkpoint: `excess_risk` grows with the SQUARE of the encounter and a
        # long, entirely benign consultation eventually trips the session alarm
        # on its own length. Over-blocking a clinician is a patient-safety
        # failure, not a tuning inconvenience (§3B.2).
        #
        # So: the streaming tier owns the persistent accumulation, seeing each
        # utterance exactly once; the consumption tier scores its own artifact
        # afresh and is discarded. The firing decision reads BOTH, because
        # "this artifact is suspicious" and "this encounter has been
        # accumulating suspicion" are different findings and either one matters.
        if complete:
            artifact_state = SessionRiskState(policy.session)
            # A fresh automaton over the artifact: the persistent one has already
            # consumed this text utterance by utterance, and re-feeding it would
            # double-count its hits and corrupt its absolute offsets.
            matcher = StreamMatcher(policy.rules)
        else:
            artifact_state = session_state
            matcher = session_matcher

        # --- T0: deterministic, persistent-state, chunking-invariant ---------
        t0_matches = matcher.feed(clean)

        # --- T1: the small classifier, over EVERY window of the artifact -----
        harm_labels: set[str] = set()
        injection_flagged = False
        clinical: list[ClinicalSignal] = []
        windows = 0

        for offset, window in _windows(clean, policy.window_chars, policy.overlap_chars):
            windows += 1
            results, confidences = await self._classify(policy.axes.all_tasks, window)
            harm = self._flagged(results, policy.axes.content_harm)
            injection = self._flagged(results, policy.axes.injection_risk)
            harm_labels.update(harm)
            injection_flagged = injection_flagged or bool(injection)
            for label in self._flagged(results, policy.axes.clinical):
                clinical.append(
                    ClinicalSignal(
                        category=label,
                        confidence=1.0,
                        # Window granularity is the honest resolution: the
                        # delegated surface returns labels, not spans.
                        span=(offset, offset + len(window)),
                    )
                )
            # GRADED when the executor reported confidences, CATEGORICAL when it
            # did not — and `scoreCalibration` below says which. See §5.1.
            graded_score = self._graded_risk(
                results,
                confidences,
                (*policy.axes.content_harm, *policy.axes.injection_risk),
                policy.benign_labels,
            )
            if graded_score is None:
                artifact_state.observe(1.0 if (harm or injection) else 0.0)
            else:
                artifact_state.observe(graded_score, graded=True)

        if not complete:
            await self._save_session(session_id, session_state, session_matcher)

        # T0 is deterministic evidence, so it contributes to the injection axis
        # directly rather than through the score.
        #
        # The escalation is deliberate and asymmetric. A single hit — a matched
        # phrase, a flagged window — is CONTAINED, not blocked: §8 rules that a
        # suspected-injection segment stays verbatim in the transcript and is
        # passed downstream as inert data, never in instruction position.
        # Dictation artefacts and quoted emails land here, and blocking them
        # would be the over-blocking §2.1 warns is itself a safety failure.
        #
        # A SESSION-LEVEL firing is different in kind. It is the stateful global
        # aggregation of §5.1, the only mitigation shown to recover a
        # split-payload bypass, and it means the evidence is distributed rather
        # than incidental. That stops derivations.
        aggregate_fired = artifact_state.fired or session_state.fired
        if complete and aggregate_fired:
            decision = "BLOCK"
        elif injection_flagged or t0_matches:
            decision = "NEUTRALIZE"
        else:
            decision = "PASS"
        injection_positive = decision != "PASS"

        aggregate = artifact_state.to_dict()
        # GRADED only when EVERY window folded into this aggregate carried a real
        # confidence. A mix is neither statistic, and calling it graded would hand
        # Phase 4 calibration data that is silently part flag rate — so a partial
        # session understates itself. `gradedWindows` (in `to_dict`) is there so
        # the mix is auditable rather than merely conservative.
        aggregate["scoreCalibration"] = (
            CALIBRATION_GRADED
            if artifact_state.windows and artifact_state.graded_windows == artifact_state.windows
            else CALIBRATION_CATEGORICAL
        )
        aggregate["deterministicHits"] = summarise(t0_matches)
        aggregate["windowsThisArtifact"] = windows
        if complete:
            # Both views, named, so an auditor can tell WHICH one fired.
            aggregate["sessionFired"] = session_state.fired
            aggregate["sessionFireReasons"] = list(session_state.fire_reasons)
            aggregate["fired"] = aggregate_fired
        if complete and len(clean) > policy.ceiling_chars:
            # Reported, not silently applied: the caller owns the rolling summary
            # of the earlier prefix, and that summary must itself be validated.
            aggregate["ceilingExceeded"] = True

        return TranscriptSegmentVerdict(
            segment_id=artifact_id,
            scope=VerdictScope(
                content_hash=content_hash(text),
                policy_version=policy.policy_version,
                classifier_version=policy.classifier_version,
                taxonomy_version=policy.taxonomy_version,
                threshold_set=policy.threshold_set,
                tenant_id=self._tenant_id,
            ),
            content_harm=ContentHarm(
                categories=tuple(sorted(harm_labels)),
                confidence=1.0 if harm_labels else 0.0,
                classifier_version=policy.classifier_version,
            ),
            injection_risk=InjectionRisk(
                decision=decision,
                assembly_template_id=assembly_template_id,
                capability_set_id=capability_set_id,
                confidence=1.0 if injection_positive else 0.0,
            ),
            clinical=tuple(clinical),
            window=WindowAssertion(
                # Over the WHOLE artifact — sanitization removes invisible
                # characters, so the inspected length is the sanitized length.
                inspected_chars=len(clean),
                consumer_window_chars=len(clean) if complete else 0,
                complete=complete,
            ),
            validator_id=self._validator_id,
            created_at=str(int(time.time())),
            session_aggregate=aggregate,
        )

    # -- helpers ------------------------------------------------------------

    async def _classify(
        self, tasks: Sequence[str], window: str
    ) -> tuple[Mapping[str, Any], Mapping[str, Mapping[str, float]]]:
        """One classification pass — with confidences when the analyzer has them.

        The scored seam is OPTIONAL by design. An analyzer that predates
        TASK-830 (or a peer `apps/nlp` that still answers with labels alone)
        keeps working and is reported as `categorical`; nothing is synthesised to
        make the graded path look available when it is not.
        """
        scored = getattr(self._analyzer, "classify_tasks_scored", None)
        if callable(scored):
            answer = await scored(tasks, window)
            return answer.labels, answer.scores
        return await self._analyzer.classify_tasks(tasks, window), {}

    def _graded_risk(
        self,
        results: Mapping[str, Any],
        confidences: Mapping[str, Mapping[str, float]],
        tasks: Sequence[str],
        benign: frozenset[str],
    ) -> float | None:
        """This window's graded risk in [0, 1], or None when nothing scored it.

        Per label: a NON-BENIGN label contributes its own confidence, and a
        benign one contributes `1 - confidence` — the mass the model did NOT put
        on "clean". The window takes the max across the gating tasks.

        `1 - P(benign)` is exact for a single-label softmax task, which is the
        shape `prompt_safety` / `jailbreak_detection` use: with one benign label
        in the taxonomy it IS the total probability on the harmful ones. For a
        multi-label sigmoid task it is an estimate rather than a bound — the
        executor returns the labels it selected, not a distribution over the whole
        taxonomy — but it moves monotonically with detector confidence, which is
        the property §5.1's aggregate actually needs. It is deliberately computed
        HERE and not in `apps/nlp`: `benign_labels` is guardrail's policy, and the
        executor must keep returning raw numbers it does not interpret.

        Returns None unless EVERY task that answered was scored. A max taken over
        a subset silently understates the window — a task with no confidence
        cannot contribute — so a partly-scored window is reported as unscored
        rather than as a number that looks complete.
        """
        risk = 0.0
        answered = 0
        scored = 0
        for task in tasks:
            value = results.get(task)
            if value is None:
                continue
            answered += 1
            per_label = confidences.get(task) or {}
            labels = [value] if isinstance(value, str) else [str(v) for v in value]
            task_risk: float | None = None
            for label in labels:
                confidence = per_label.get(label)
                if confidence is None:
                    continue
                harmful = label.casefold() not in benign
                contribution = confidence if harmful else 1.0 - confidence
                task_risk = contribution if task_risk is None else max(task_risk, contribution)
            if task_risk is None:
                continue
            scored += 1
            risk = max(risk, task_risk)
        if not answered or scored != answered:
            return None
        return risk

    def _flagged(self, results: Mapping[str, Any], tasks: Sequence[str]) -> list[str]:
        benign = self._policy.benign_labels
        out: list[str] = []
        for task in tasks:
            value = results.get(task)
            if value is None:
                continue
            labels = [value] if isinstance(value, str) else [str(v) for v in value]
            out.extend(lbl for lbl in labels if lbl.casefold() not in benign)
        return out

    async def _load_session(self, session_id: str) -> tuple[SessionRiskState, StreamMatcher]:
        snapshot = await self._store.get(session_key(self._tenant_id, session_id)) or {}
        state = SessionRiskState.restore(self._policy.session, snapshot.get("risk"))
        matcher = StreamMatcher(
            self._policy.rules,
            resume_tail=str(snapshot.get("tail") or ""),
            start_offset=int(snapshot.get("offset") or 0),
        )
        return state, matcher

    async def _save_session(
        self, session_id: str, state: SessionRiskState, matcher: StreamMatcher
    ) -> None:
        await self._store.put(
            session_key(self._tenant_id, session_id),
            {
                "risk": state.snapshot(),
                "tail": matcher.tail,
                "offset": matcher.consumed_chars,
            },
            self._policy.ttl_s,
        )

    # -- axis-1 cache -------------------------------------------------------

    def content_harm_key(self, text: str) -> str:
        """The task-agnostic cache handle. Axis 1 fans out; axis 2 does not."""
        return content_harm_cache_key(
            VerdictScope(
                content_hash=content_hash(text),
                policy_version=self._policy.policy_version,
                classifier_version=self._policy.classifier_version,
                taxonomy_version=self._policy.taxonomy_version,
                threshold_set=self._policy.threshold_set,
                tenant_id=self._tenant_id,
            )
        )


def new_validator_id() -> str:
    return f"guardrail.realtime:{uuid.uuid4()}"
