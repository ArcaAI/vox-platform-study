"""The post-receive moderation gate — the OUTPUT half of guardrail (TASK-871).

Owner decision (TASK-870 items 5 and 7): guardrail checks every text-generation
request BEFORE it is sent to the provider AND every response AFTER it is
received, for built-in and BYO providers alike. The input half is
``services/egress.run_inbound_gate``; this module is the output half,
and it is called from exactly two places:

* the non-streaming ``/generate`` body, after ``provider.generate`` returns and
  BEFORE the task is marked completed, audited, returned or cached;
* the streaming producer (``routing/streaming.py``), after the provider stream
  ends and BEFORE the terminal frame — on the ASSEMBLED completion, since a
  delivered token cannot be recalled and a verdict on a partial text would be a
  different safety semantics.

Both call sites treat :class:`OutputRejectedError` as "this completion never
reaches a persisted or returned state": the non-streaming path answers 422/503,
the streaming path emits a terminal ``error`` frame every consumer already
discards on. The exception carries everything either site needs so neither
re-derives the rejection contract.

Fail posture is the input gate's, verbatim: a genuine rejection is a
422-equivalent, a sustained outage is a retryable 503-equivalent and a malformed
verdict fails closed. There is no posture switch and no tenant opt-out any more
(TASK-1035 OD-1/OD-4); the only unscreened path is a process with NO client wired
at all, which the service lifespan never builds (it is how the hermetic unit
harness constructs an app).

``pii_leak`` depends on provider LOCALITY (TASK-1035 §3.1). On a CLOUD call the
completion is screened BEFORE re-identification against the pseudonymized source,
so any real identifier in it was leaked or hallucinated, and the response is
blocked (``PII_LEAK_BLOCKED``). On a LOCAL call it is detect-only: a clinical note
legitimately names the patient, so a verdict whose ONLY blocking reason is
``pii_leak`` is audited and allowed. Raising — rather than returning a verdict a caller might forget to
check — is what makes the gate fail closed by construction: a call site that
does not handle the exception fails its generation instead of shipping it.

The cycle tripwire holds here too. Guardrail delegates its LLM judgement to
this service, so gating a JUDGE call would close ``text -> guardrail -> text``;
:func:`assert_not_in_judge_scope` raises before any guardrail call is made.
"""

from __future__ import annotations

from typing import Any

from text.core.exceptions import ContentBlockedError, GuardrailUnavailableError, TextError
from text.core.locality import CLOUD, LOCAL
from text.core.logging import get_logger
from text.models.usage import UsageDetail, guardrail_usage_from_verdict
from text.services.egress import (
    record_outbound_data_findings,
    request_segments,
    system_prompt_is_governed,
)
from text.services.egress import source_regions as _regions_of_segments
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)
from text.services.judge_guard import assert_not_in_judge_scope

logger = get_logger(__name__)

__all__ = [
    "PII_LEAK_CODE",
    "REJECTED_CODE",
    "UNAVAILABLE_CODE",
    "OutputRejectedError",
    "assemble_completion",
    "gate_completion",
    "source_regions_of",
]

#: ``code`` on the terminal ``error`` frame and the audit trail: guardrail
#: answered and refused the completion.
REJECTED_CODE = "GUARDRAIL_REJECTED"
#: ``code`` when no verdict could be obtained (sustained outage, or the enforce
#: posture with no client wired). Retryable — nothing about the content was
#: judged, and telling a clinician their note was rejected would be a lie.
UNAVAILABLE_CODE = "GUARDRAIL_UNAVAILABLE"
#: ``code`` when a CLOUD completion carried a real identifier before
#: re-identification (TASK-1035). Not retryable as-is: the same prompt can leak again.
PII_LEAK_CODE = "PII_LEAK_BLOCKED"
#: The outbound check whose meaning depends on locality.
_PII_LEAK_CHECK = "pii_leak"
#: Prefix of the persisted task ``error`` for a rejected generation. The task
#: status is ``FAILED`` (the value every consumer already discards on — a new
#: enum value would cross into the gateway's contract); this prefix is what
#: distinguishes a rejection from a provider failure in the record.
_TASK_ERROR_PREFIX = "guardrail_rejected:"


class OutputRejectedError(Exception):
    """The completion did not pass the post-receive guardrail gate."""

    def __init__(
        self,
        *,
        reason: str,
        retryable: bool,
        decision: dict[str, Any] | None = None,
        guardrail_usage: UsageDetail | None = None,
        pii_leak: bool = False,
    ) -> None:
        super().__init__(f"Response rejected by guardrail: {reason}")
        self.reason = reason
        self.retryable = retryable
        self.decision = decision
        self.guardrail_usage = guardrail_usage
        #: A CLOUD completion carried a real identifier (TASK-1035).
        self.pii_leak = pii_leak

    @property
    def status_code(self) -> int:
        """503 for an outage (retryable), 422 for a content rejection."""
        return 503 if self.retryable else 422

    @property
    def code(self) -> str:
        if self.retryable:
            return UNAVAILABLE_CODE
        return PII_LEAK_CODE if self.pii_leak else REJECTED_CODE

    @property
    def detail(self) -> str:
        """The HTTP ``detail`` / frame ``error`` text — a reason label, never content."""
        return f"Response rejected by guardrail: {self.reason}"

    @property
    def task_error(self) -> str:
        """What the task record says. Same string on both call sites."""
        return f"{_TASK_ERROR_PREFIX}{self.reason}"

    def as_text_error(self) -> TextError:
        """The FIXED, non-PHI error this rejection becomes on the HTTP surface.

        Mirrors the input gate (TASK-969 WS-3): the non-streaming ``/generate``
        body converts this into an HTTP response via ``raise self.as_text_error()``
        rather than a bare ``HTTPException`` — ``detail`` becomes a fixed
        sentence and ``error_code`` a closed-vocabulary token, never
        ``self.reason``. Guardrail's outbound screen restricts ``reason`` to
        check names/labels (never raw text), but this keeps the HTTP contract
        of both gate halves identical and PHI-safe BY CONSTRUCTION rather than
        by that label happening to be safe today. The SSE terminal frame
        (``terminal_data`` below) and structured logs are unaffected — they keep
        carrying ``self.reason`` for operators, exactly as before.
        """
        if self.retryable:
            return GuardrailUnavailableError()
        if self.pii_leak:
            return ContentBlockedError(
                "The response was blocked because it contained an identifier that was "
                "not sent to the provider.",
                error_code=PII_LEAK_CODE,
            )
        return ContentBlockedError("The response was blocked by the safety guardrail.")

    def terminal_data(self, *, usage: dict[str, Any]) -> dict[str, Any]:
        """The ``data`` of the terminal ``error`` frame on the streaming path.

        Carries the usage block the gateway meters from (the tokens were burned
        whether or not the text was deliverable) and guardrail's decision summary
        — ``decision`` and ``reasons`` only, which by guardrail's own construction
        hold check names and labels, never the analysed text.
        """
        summary: dict[str, Any] | None = None
        if isinstance(self.decision, dict):
            summary = {
                "decision": self.decision.get("decision"),
                "reasons": list(self.decision.get("reasons") or []),
            }
        return {
            "error": self.detail,
            "code": self.code,
            "retryable": self.retryable,
            "guardrail": summary,
            "usage": usage,
        }


def assemble_completion(content: str | None, reasoning: str | None) -> str:
    """Everything the model produced that a consumer can see, as one text.

    Reasoning is screened alongside content: both reach consumers (``chunk`` and
    ``reasoning`` frames, ``content`` and ``reasoning`` fields), and a jailbroken
    model can put the payload in either. Joined the way the input gate joins
    ``system_prompt`` and ``prompt``.
    """
    body = content or ""
    if reasoning:
        return f"{reasoning}\n\n{body}"
    return body


def source_regions_of(request_body: Any) -> list[dict[str, str]]:
    """The regions the response was generated FROM, for guardrail's PII-leak check.

    The untrusted regions the input gate screened (TASK-1047 FC-5) — block bodies
    by name, caller text outside blocks as ``user``, an untrusted system prompt as
    ``system`` — so a response that repeats the consultation's own identifiers is
    not a leak, and one that introduces identifiers absent from them is. A system
    prompt whose governance digest verifies carries no runtime value and is not a
    source.
    """
    governed = system_prompt_is_governed(request_body)
    return _regions_of_segments(
        request_segments(request_body), system="governed" if governed else "untrusted"
    )


async def gate_completion(
    guardrail_client: ExternalGuardrailClient | None,
    *,
    completion: str,
    source_regions: list[dict[str, str]] | None,
    tenant_id: str | None,
    tenant_policy: Any,
    app_state: Any,
    where: str,
    locality: str = CLOUD,
) -> UsageDetail | None:
    """Screen ``completion``; return guardrail's own usage, or raise.

    * client wired ⇒ screen; ``allowed`` missing or false ⇒ raise (outage
      reason ⇒ retryable, anything else ⇒ content rejection), EXCEPT a LOCAL call
      whose only blocking reason is ``pii_leak``, which is detect-only;
    * client absent ⇒ ``None`` — only a process the lifespan never wired.

    ``locality`` defaults to CLOUD, the strict reading of ``pii_leak``.

    An EMPTY completion is not sent: there is nothing to screen, and guardrail
    would 422 a blank ``response``, which this side would then misread as an
    outage.
    """
    if guardrail_client is not None:
        assert_not_in_judge_scope(where)
        if not completion.strip():
            return None
        verdict = await guardrail_client.screen_output(
            response=completion,
            source_regions=source_regions,
            tenant_id=tenant_id,
            tenant_policy=tenant_policy,
        )
        # Lifted BEFORE the allow/deny branch, as on the input side: a rejected
        # response still burned guardrail tokens. (Guardrail's outbound screen
        # carries no usage block yet — this is ``None`` until it does.)
        guardrail_usage = guardrail_usage_from_verdict(verdict)
        # TASK-1047 FC-5c: record-only checks that flagged are findings, recorded
        # PHI-safely whatever the decision. Advisory — never consulted for `allowed`.
        record_outbound_data_findings(verdict, where=where)
        if not verdict.get("allowed", False):  # fail-closed default (missing key → reject)
            reason = str(verdict.get("reason", "not_allowed"))
            raw = verdict.get("raw")
            reasons = raw.get("reasons") if isinstance(raw, dict) else None
            blocking = {str(r) for r in reasons} if isinstance(reasons, list) else set()
            if locality == LOCAL and blocking == {_PII_LEAK_CHECK}:
                # OD-2: detect-only on a local provider. Counts only — never the text.
                logger.info("text.egress.pii_leak_detected_local", where=where)
                return guardrail_usage
            raise OutputRejectedError(
                reason=reason,
                retryable=reason == GUARDRAIL_UNAVAILABLE_REASON,
                decision=raw if isinstance(raw, dict) else None,
                guardrail_usage=guardrail_usage,
                pii_leak=_PII_LEAK_CHECK in blocking,
            )
        return guardrail_usage
    return None
