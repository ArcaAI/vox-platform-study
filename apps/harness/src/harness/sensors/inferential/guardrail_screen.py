"""Content-safety screen DELEGATED to ``apps/guardrail`` (TASK-799 A.1, F-02).

`06-python-services.md`: *"Do not grow a second inference stack."* This module is what
makes that true of harness. It replaces ``granite_client.GraniteGuardianClient``, which
built an IBM Granite Guardian client from a complete engine plane in environment —
provider (``lm-studio`` | ``ollama`` | ``azure`` | ``bedrock``), ``base_url``, a hardcoded
``granite-guardian-4.1-8b`` model id, and a **7-item clinical risk taxonomy in a JSON env
array** — and posted straight at an OpenAI-compatible endpoint. That is five of the eight
categories rule 00 names as config-not-code (engine, model id, endpoint, threshold,
taxonomy), none of which a tenant could express.

``apps/guardrail`` already owns all of it: the tenant → SYSTEM policy cascade, the label
taxonomy (on ``AiModel._metadata.labelTaxonomy``, resolved by the same cascade that chose
the model), and the delegation of the ENGINE to ``apps/text`` / ``apps/nlp``. The harness
interpreter lane already called it (``temporal/interpreter/nodes/guardrail_check.py``);
only the Temporal ACTIVITY lane bypassed it. This closes that gap with the SAME client.

**The three properties this adapter preserves exactly**

* **Interface.** :meth:`screen` returns ``{dimension: is_unsafe}``, which is what
  :class:`~harness.sensors.inferential.safety.SafetySensor` consumes — so the sensor's
  scoring, its ``details`` payload and therefore the persisted
  ``guardrail_decisions["safety"]`` map are unchanged.
* **Degrade, never guess.** Every failure raises :class:`SafetyScreenError`, which the
  sensor turns into a ``degraded_result`` — a backend outage degrades THAT SENSOR and
  never raises into the durable loop, exactly as ``GraniteServiceError`` did.
* **Never auto-PASS.** Two cases are deliberately errors rather than "safe": an
  ``undetermined`` check (the analogue of the old unparseable ``<score>`` verdict — the
  check COULD NOT run), and a screen where no check produced a verdict at all.

**``skipped`` is excluded, not counted safe.** Guardrail reports ``skipped`` for a check
that DELIBERATELY did not run because its input was absent — ``pii_leak`` without a
``source_context``, ``containment_echo`` without a nonce. Folding those in as passes would
inflate the sensor's safe fraction with checks that never happened, which is the failure
mode guardrail's own ``_check_pii_leak`` docstring calls out ("a check that silently
passes when its input is missing is worse than no check").

**No content-addressed fast path.** The adapter deliberately does NOT expose ``criteria``.
The dimension names are guardrail's tenant-resolved taxonomy, not a harness constant, so
harness cannot enumerate them before the call — and re-deriving them locally would
reintroduce the very taxonomy this ticket deletes. ``SafetySensor`` already handles a
client that cannot enumerate its criteria by screening directly, its documented
pre-cache path; the cost is one bounded HTTP call per regen pass instead of a cache hit.
"""

from __future__ import annotations

from harness.services.guardrail_client import GuardrailClient, GuardrailServiceError

#: Outcomes that produced a real verdict, and what each means for "is this unsafe?".
_VERDICTS = {"flag": True, "pass": False}

#: The check could not RUN (guardrail's backend was unavailable). Fail-closed on
#: guardrail's side (decision = block); here it degrades the sensor, because the harness
#: contract for an unverifiable screen is DEGRADED, not FLAG.
_UNDETERMINED = "undetermined"


class SafetyScreenError(RuntimeError):
    """The safety screen could not be completed — the sensor must degrade, not guess."""


class SafetyScreenTenantMissing(SafetyScreenError, ValueError):
    """No tenant was supplied for a tenant-scoped safety screen (a CALLER defect).

    Both bases are deliberate: it is a ``ValueError`` because it is a programming error at
    a construction site, and a :class:`SafetyScreenError` so a call site that only guards
    the screen contract still degrades rather than crashing the durable loop.
    """


class GuardrailSafetyScreen:
    """Screens a generated note through ``POST /guardrail/screen/outbound``."""

    def __init__(self, client: GuardrailClient, *, tenant_id: str) -> None:
        if not (tenant_id or "").strip():
            # TASK-737 / rule 00: an absent tenant on an internal tenant-scoped call is a
            # bug in the CALLER. Refusing at construction turns it into a loud local
            # error instead of a 428 from guardrail that reads like an outage.
            raise SafetyScreenTenantMissing(
                "GuardrailSafetyScreen requires a tenant: a safety decision must be attributable"
            )
        self._client = client
        self._tenant_id = tenant_id
        #: The model(s) that actually answered, populated by :meth:`screen`. `None` until
        #: the first screen — the sensor reads it only AFTER the screen returns.
        self.model: str | None = None

    async def screen(self, text: str) -> dict[str, bool]:
        """Screen ``text``; return ``{check name: is_unsafe}`` for the checks that ran."""
        self.model = None
        try:
            result = await self._client.screen_outbound(response=text, tenant_id=self._tenant_id)
        except GuardrailServiceError as exc:
            raise SafetyScreenError(str(exc)) from exc

        undetermined = [c.name for c in result.checks if c.outcome == _UNDETERMINED]
        if undetermined:
            raise SafetyScreenError(
                f"guardrail could not determine {', '.join(sorted(undetermined))}"
            )

        dimensions = {c.name: _VERDICTS[c.outcome] for c in result.checks if c.outcome in _VERDICTS}
        if not dimensions:
            raise SafetyScreenError("guardrail returned no safety verdict")

        models = sorted({c.model for c in result.checks if c.outcome in _VERDICTS and c.model})
        self.model = ",".join(models) if models else None
        return dimensions

