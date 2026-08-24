"""Guardrail's POLICY bundle — thresholds and criteria as CONFIG, never literals.

`.claude/rules/00-project-context.md` §Configuration Principles: *"an engine name,
model id, endpoint, credential, threshold, prompt, taxonomy or label set is NOT a
literal in code"*. TASK-735 moved model identity and label taxonomies onto the
registry row; this module does the same for the two things that were left behind —
the **criteria text** that decides a clinical verdict, and the **numeric floors** a
verdict must clear.

**Where it lives.** `AiModel._metadata.policy`, alongside the `labelTaxonomy` blob
TASK-735 established, so a policy value resolves through the *same* two-tier
`request tenant → SYSTEM` cascade as the selection it belongs to. Nothing new is
invented: a platform admin edits the SYSTEM row, a tenant may carry its own, and the
resolver's existing veto / fail-closed semantics apply unchanged.

**Fail posture is DECLARED per key, in one table, not decided at the call site**
(rule 09 §Configuration Tiers — `failMode`):

* ``FAIL_CLOSED`` — the key DECIDES a verdict. Absence raises; nothing is
  substituted. The criteria text is the clearest case: a judge with no criteria is
  not a lenient judge, it is no judge at all.
* ``FAIL_OPEN_TO_DEFAULT`` — pure tuning. Absence (or an out-of-range value) uses
  the declared default, which is a property of THIS table rather than a number
  sprinkled through the services.

A malformed *tuning* value is treated as absence rather than as an error: the
declared posture for those keys is open-to-default, and honouring a nonsensical
threshold is the one outcome that silently corrupts the gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from guardrail.core.config import JudgePolicy
from guardrail.core.errors import REASON_UNSUPPORTED, GuardrailUndeterminedError

FAIL_CLOSED: Final = "closed"
FAIL_OPEN_TO_DEFAULT: Final = "open-to-default"


@dataclass(frozen=True)
class _KeySpec:
    """One governed policy key: its posture and, for tuning keys, its bounds."""

    fail_mode: str
    default: float | None = None
    minimum: float | None = None
    maximum: float | None = None


#: The whole governed surface. Adding a key here is the ONLY step needed to make it
#: readable, bounded and declared — there is no second allow-list.
_SPECS: Final[dict[str, _KeySpec]] = {
    # --- verdict-deciding criteria (FAIL-CLOSED, no default by construction) ---
    "medicalValidationCriteria": _KeySpec(FAIL_CLOSED),
    "injectionScreeningCriteria": _KeySpec(FAIL_CLOSED),
    # --- tuning (open-to-default, bounded) ---
    #
    # The default is DERIVED from `JudgePolicy`, not restated. Two literals for
    # one number is how they drift: the judge would truncate at its own value
    # while the registry advertised another.
    #
    # `judgeTemperature` and `judgeMaxInputChars` were declared here with ZERO
    # readers anywhere in the tree, while the live values came from
    # `AiRuntimeProfile.temperature` and `JudgePolicy.max_input_chars`
    # respectively. A declared-but-unread knob is worse than an absent one — it
    # advertises a control that cannot move the value, so an admin who sets it
    # sees neither an effect nor an error. Removed rather than wired: the two
    # sources that DO serve those values are the correct ones (§D.2b).
    "judgeMinConfidence": _KeySpec(FAIL_OPEN_TO_DEFAULT, JudgePolicy().min_confidence, 0.0, 1.0),
    "piiLeakMinScore": _KeySpec(FAIL_OPEN_TO_DEFAULT, 0.5, 0.0, 1.0),
    "maxUntrustedChars": _KeySpec(FAIL_OPEN_TO_DEFAULT, 100_000.0, 1.0, 10_000_000.0),
    # --- groundedness (TASK-799 lane D) ---
    #
    # The VERDICT-DECIDING threshold for the clinical groundedness gate. It was a
    # pydantic default (`GUARDRAIL_V2_GROUNDEDNESS_ENTAILMENT_THRESHOLD`), so a
    # platform admin could not move it without a redeploy.
    #
    # It belongs on the MODEL row rather than the control plane because it is
    # model-coupled: it thresholds the scores of the specific NLI checkpoint the
    # `guardrail.groundedness` selection resolved, and a threshold calibrated for
    # one checkpoint is meaningless against another. Resolving it through the same
    # cascade that chose the model keeps the two in step by construction.
    "groundednessEntailmentThreshold": _KeySpec(FAIL_OPEN_TO_DEFAULT, 0.5, 0.0, 1.0),
}


@dataclass(frozen=True)
class GuardrailPolicy:
    """One tenant's resolved policy blob, plus the tier that supplied it."""

    #: Raw blob from `AiModel._metadata.policy` (`{}` when the row has no opinion).
    blob: dict[str, Any]
    #: WHICH tier answered — part of every attributable verdict.
    source_tenant_id: str | None = None

    DECLARED_KEYS: Final[tuple[str, ...]] = tuple(_SPECS)

    # -- construction -------------------------------------------------------

    @classmethod
    def from_blob(
        cls, blob: dict[str, Any] | None, *, source_tenant_id: str | None = None
    ) -> GuardrailPolicy:
        return cls(
            blob=dict(blob) if isinstance(blob, dict) else {},
            source_tenant_id=source_tenant_id,
        )

    # -- declaration --------------------------------------------------------

    @classmethod
    def fail_mode(cls, key: str) -> str:
        """The DECLARED posture for ``key``. Unknown keys are fail-closed."""
        spec = _SPECS.get(key)
        return spec.fail_mode if spec is not None else FAIL_CLOSED

    # -- reads --------------------------------------------------------------

    def require_criteria(self, key: str) -> str:
        """A fail-CLOSED criteria string. Raises rather than substituting a literal."""
        value = self.blob.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        raise GuardrailUndeterminedError(
            REASON_UNSUPPORTED,
            f"policy key {key!r} is unresolved (failMode=closed): the criteria that "
            "decides this verdict is configuration and has no code default — seed it "
            "on the SYSTEM AiModel row's `_metadata.policy`",
        )

    def number(self, key: str) -> float:
        """A bounded tuning value; absent or out-of-range ⇒ the declared default."""
        spec = _SPECS.get(key)
        if spec is None or spec.default is None:
            raise KeyError(f"{key!r} is not a declared tuning key")
        value = self.blob.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return spec.default
        as_float = float(value)
        if spec.minimum is not None and as_float < spec.minimum:
            return spec.default
        if spec.maximum is not None and as_float > spec.maximum:
            return spec.default
        return as_float

    # Named accessors so call sites never spell a key by hand.

    @property
    def judge_min_confidence(self) -> float:
        return self.number("judgeMinConfidence")

    @property
    def groundedness_entailment_threshold(self) -> float:
        return self.number("groundednessEntailmentThreshold")

    @property
    def pii_leak_min_score(self) -> float:
        return self.number("piiLeakMinScore")

    @property
    def max_untrusted_chars(self) -> int:
        return int(self.number("maxUntrustedChars"))
