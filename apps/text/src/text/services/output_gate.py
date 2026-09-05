"""The post-receive moderation gate — the OUTPUT half of guardrail (TASK-871).

Owner decision (TASK-870 items 5 and 7): guardrail checks every text-generation
request BEFORE it is sent to the provider AND every response AFTER it is
received, for built-in and BYO providers alike. The input half is
``api/endpoints/generate._apply_guardrail_gate``; this module is the output half,
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
422-equivalent, a sustained outage is a retryable 503-equivalent, a malformed
verdict fails closed, and the dev/CI bypass (client absent AND posture off) is
preserved. Raising — rather than returning a verdict a caller might forget to
check — is what makes the gate fail closed by construction: a call site that
does not handle the exception fails its generation instead of shipping it.

The cycle tripwire holds here too. Guardrail delegates its LLM judgement to
this service, so gating a JUDGE call would close ``text -> guardrail -> text``;
:func:`assert_not_in_judge_scope` raises before any guardrail call is made.
"""

from __future__ import annotations

from typing import Any

from text.core.guardrail_posture import platform_moderation_enabled
from text.models.usage import UsageDetail, guardrail_usage_from_verdict
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)
from text.services.judge_guard import assert_not_in_judge_scope

__all__ = [
    "REJECTED_CODE",
    "UNAVAILABLE_CODE",
    "OutputRejectedError",
    "assemble_completion",
    "gate_completion",
    "source_context_of",
]

#: ``code`` on the terminal ``error`` frame and the audit trail: guardrail
#: answered and refused the completion.
REJECTED_CODE = "GUARDRAIL_REJECTED"
#: ``code`` when no verdict could be obtained (sustained outage, or the enforce
#: posture with no client wired). Retryable — nothing about the content was
#: judged, and telling a clinician their note was rejected would be a lie.
UNAVAILABLE_CODE = "GUARDRAIL_UNAVAILABLE"
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
    ) -> None:
        super().__init__(f"Response rejected by guardrail: {reason}")
        self.reason = reason
        self.retryable = retryable
        self.decision = decision
        self.guardrail_usage = guardrail_usage

    @property
    def status_code(self) -> int:
        """503 for an outage (retryable), 422 for a content rejection."""
        return 503 if self.retryable else 422

    @property
    def code(self) -> str:
        return UNAVAILABLE_CODE if self.retryable else REJECTED_CODE

    @property
    def detail(self) -> str:
        """The HTTP ``detail`` / frame ``error`` text — a reason label, never content."""
        return f"Response rejected by guardrail: {self.reason}"

    @property
    def task_error(self) -> str:
        """What the task record says. Same string on both call sites."""
        return f"{_TASK_ERROR_PREFIX}{self.reason}"

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


def source_context_of(request_body: Any) -> str:
    """The source the response was generated FROM, for guardrail's PII-leak check.

    Identical to the text the input gate screened, so a response that repeats
    the consultation's own identifiers is not a leak, and one that introduces
    identifiers absent from it is.
    """
    prompt = str(getattr(request_body, "prompt", "") or "")
    system_prompt = getattr(request_body, "system_prompt", None)
    return f"{system_prompt}\n\n{prompt}" if system_prompt else prompt


async def gate_completion(
    guardrail_client: ExternalGuardrailClient | None,
    *,
    completion: str,
    source_context: str | None,
    tenant_id: str | None,
    tenant_policy: Any,
    app_state: Any,
    where: str,
) -> UsageDetail | None:
    """Screen ``completion``; return guardrail's own usage, or raise.

    Branches mirror ``_apply_guardrail_gate`` one for one:

    * client wired ⇒ screen; ``allowed`` missing or false ⇒ raise (outage
      reason ⇒ retryable, anything else ⇒ content rejection);
    * client absent AND the platform posture enforces ⇒ raise, retryable — a
      misconfiguration must not ship an unscreened response;
    * client absent AND posture off ⇒ ``None``, the dev/CI bypass.

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
            source_context=source_context,
            tenant_id=tenant_id,
            tenant_policy=tenant_policy,
        )
        # Lifted BEFORE the allow/deny branch, as on the input side: a rejected
        # response still burned guardrail tokens. (Guardrail's outbound screen
        # carries no usage block yet — this is ``None`` until it does.)
        guardrail_usage = guardrail_usage_from_verdict(verdict)
        if not verdict.get("allowed", False):  # fail-closed default (missing key → reject)
            reason = str(verdict.get("reason", "not_allowed"))
            raw = verdict.get("raw")
            raise OutputRejectedError(
                reason=reason,
                retryable=reason == GUARDRAIL_UNAVAILABLE_REASON,
                decision=raw if isinstance(raw, dict) else None,
                guardrail_usage=guardrail_usage,
            )
        return guardrail_usage
    if platform_moderation_enabled(app_state):
        raise OutputRejectedError(reason=GUARDRAIL_UNAVAILABLE_REASON, retryable=True)
    return None
