"""The guard.* node types — lane A, item 17.

A guard is the thing ``WorkflowNodeDescriptor.requires`` names: a node type that must be wired to
EVERY INSTANCE of the node that requires it before a graph containing it can be published
(``workflowPublishProblems``). Until these existed, ``requires`` was ``[]`` on all 36 node types
and the mechanism gated nothing.

Three guards, and each delegates to a check this platform already performs:

* ``guard.phi`` — the PHI redaction hop (``interpreter.consultation_phi_hop``).
* ``guard.moderation`` — content safety (``interpreter.guardrail_check``).
* ``guard.groundedness`` — the groundedness sensor pass (``interpreter.consultation_sensors``).
  ``realtime-lane.ts`` records the gap this closes verbatim: *"There is no groundedness NODE
  because the registry has no groundedness node type; the gate is a GUARD attached to the
  generation node"*.

## Why a guard's product is a VERDICT

A guard says whether something is acceptable; a transformer changes it. Declaring `verdict` as the
guard's primary output is what keeps the two apart, and it is also what lets ``requires`` be
satisfied by an edge in EITHER direction — a pre-guard reads what a node will produce FROM, a
post-guard reads what it produced.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.guards.phi.redactor import PhiEgressBlocked
from harness.services.text_client import TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import bound_value
from harness.temporal.interpreter.nodes._llm_policy import (
    InstructionUnavailable,
    LlmJudgement,
    generate_json,
    resolve_instruction,
    resolve_text_selection,
)
from harness.temporal.interpreter.nodes.consultation import interpreter_consultation_phi_hop
from harness.temporal.interpreter.nodes.consultation_verify import interpreter_consultation_sensors
from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check

#: The THREE things the owner says grounding evaluates, and the only values a policy's
#: ``appliesTo`` may take. Mirrors ``GROUNDING_POLICY_TARGETS`` in
#: ``packages/workflow-contract/src/node-config-schemas.ts`` — the TS side is where an author is
#: validated, this is where a policy is dispatched, and
#: ``test_grounding_policies.py`` asserts the two agree.
#:
#: ``summary`` is the node's required ``in`` socket. The socket kept its name because renaming a
#: published port is the reshape ``schemaVersion`` exists to forbid; ``summary`` is what an ADMIN
#: reads, which is why the taxonomy uses it and the port table does not.
GROUNDING_POLICY_TARGETS = ("transcript", "summary", "findings")

#: ``appliesTo`` -> the bound-input port that carries it.
_TARGET_PORT = {"transcript": "transcript", "summary": "in", "findings": "findings"}


@activity.defn(name="interpreter.guard_phi")
async def interpreter_guard_phi(payload: NodeActivityInput) -> NodeActivityResult:
    """PHI guard — redacts, and reports WHAT it redacted as a verdict.

    The redactor engine publishes ``{text, mode, entityCount}``. A guard has to answer a question,
    so this wrapper projects those same values into a ``verdict`` object rather than leaving the
    declared ``out: verdict`` socket naming a key its engine never emits. Nothing is recomputed —
    the verdict is a view of the redactor's own report.

    The fail-CLOSED property of PHI handling does NOT live here and must not be re-implemented
    here: ``ensure_egress_safe`` raises before any cloud call, and the redactor hop DEGRADES rather
    than passing unredacted text through (``consultation.py``'s own rule: "fail loudly, never pass
    through while claiming the hop ran").
    """
    result = await interpreter_consultation_phi_hop(payload)
    output: dict[str, Any] = dict(result.output or {})
    if result.status == "SUCCEEDED":
        output["verdict"] = {
            "guard": "phi",
            "mode": output.get("mode"),
            "entityCount": output.get("entityCount"),
            "redacted": bool(output.get("entityCount")),
        }
    return NodeActivityResult(status=result.status, reason=result.reason, output=output or None)


@activity.defn(name="interpreter.guard_moderation")
async def interpreter_guard_moderation(payload: NodeActivityInput) -> NodeActivityResult:
    """Content-safety guard. Delegates verbatim to the guardrail engine, which already publishes
    its decision under ``verdict`` — the key this node's ``out`` socket declares."""
    return await interpreter_guardrail_check(payload)


def _declared_policies(config: dict[str, Any]) -> list[dict[str, Any]]:
    """The ENABLED policies this node instance declares, in authored order.

    ``enabled`` absent means ENABLED: a declared policy that silently did nothing would be worse
    than no policy at all. A policy naming a target outside {@link GROUNDING_POLICY_TARGETS} is
    dropped here rather than raising — the TS config schema refuses it at publish time, so one
    reaching this far means an older graph, and one bad policy must not cost the other three.
    """
    raw = config.get("policies")
    if not isinstance(raw, list):
        return []
    return [
        policy
        for policy in raw
        if isinstance(policy, dict)
        and policy.get("enabled") is not False
        and policy.get("appliesTo") in GROUNDING_POLICY_TARGETS
    ]


async def _evaluate_policy(
    payload: NodeActivityInput, policy: dict[str, Any], judgement: LlmJudgement, subject: Any
) -> dict[str, Any]:
    """One policy, evaluated by the model against the input it is scoped to.

    The returned row always names the policy ``key`` and its ``appliesTo`` so a verdict can be
    traced back to the tenant rule that produced it. A policy that could not run reports WHY —
    it never reports "passed", because an unevaluated policy silently reading as satisfied is how
    a grounding gate becomes decorative.
    """
    row: dict[str, Any] = {"key": policy.get("key"), "appliesTo": policy.get("appliesTo")}
    try:
        instruction = await resolve_instruction(
            policy.get("promptTemplateId"),
            payload.tenant_id,
            missing_code="no_policy_instruction_bound",
        )
    except InstructionUnavailable as exc:
        return {**row, "status": "UNEVALUATED", "reason": exc.reason, "errorCode": exc.error_code}

    try:
        parsed = await generate_json(
            tenant_id=payload.tenant_id,
            judgement=judgement,
            system_prompt=instruction,
            user_payload={"appliesTo": policy.get("appliesTo"), "subject": subject},
        )
    except PhiEgressBlocked as exc:
        return {
            **row,
            "status": "UNEVALUATED",
            "reason": f"phi egress blocked: {exc}",
            "errorCode": "phi_egress_blocked",
        }
    except TextServiceError as exc:
        return {
            **row,
            "status": "UNEVALUATED",
            "reason": str(exc),
            "errorCode": "text_generate_failed",
        }

    if parsed is None:
        return {
            **row,
            "status": "UNEVALUATED",
            "reason": "the model did not return a parseable policy verdict",
            "errorCode": "unparseable_policy_verdict",
        }
    # The VERDICT SHAPE is the tenant's, not the platform's: whatever the policy's own instruction
    # told the model to return travels through under `result`. Nothing here scores, thresholds or
    # re-labels it — a rubric in this file would be the platform deciding what "grounded" means.
    return {**row, "status": "EVALUATED", "result": parsed}


@activity.defn(name="interpreter.guard_groundedness")
async def interpreter_guard_groundedness(payload: NodeActivityInput) -> NodeActivityResult:
    """Groundedness guard over a GENERATED document, and — — over the tenant's own
    grounding POLICIES.

    Its ``in`` input is typed ``document`` rather than ``text``, and that is load-bearing:
    groundedness is a claim about generated prose against its sources, so scoring a raw transcript
    is a category error — the transcript IS the ground. ``transcript`` does not satisfy
    ``document`` in the port lattice, so that wiring is refused rather than relying on anyone
    remembering the distinction. The transcript instead arrives on its OWN optional socket, which
    is what keeps the two apart while letting one guard see both.

    ## The owner's specification, and what it does NOT contain

    > "Grounding is a set of policies defined/declared/overwriten by tenant admin where LLM will
    > follow and evaluate the: redacted transcript (errors fixes including grammar, spellings,
    > etc), redacted summary (especially grammar, spelling, medical terms, concepts, detected
    > named entities, etc.), highlighted important information/findings."

    No rubric, no score formula and no pass mark appear in this module, because the sentence
    assigns all three to the tenant admin. Each policy's instruction is an APPROVED
    ``PromptTemplate``; this activity resolves it, hands the model the input the policy is scoped
    to, and passes the model's own answer through under ``result``.

    ## Ordering: redaction runs BEFORE this node

    The owner names the transcript and the summary as *redacted*. That fixes the chain —
    ``agent.dna_redaction -> guard.groundedness``, never the reverse — and the port lattice makes
    it structural: the redactor emits a ``document`` this guard consumes, while this guard emits a
    ``verdict``, which the redactor cannot consume. (Earlier programme notes had this order the
    other way round; they were wrong.)

    ## Absent policies is a SUPPORTED state

    A ``guard.groundedness`` node authored before this ticket declares none, and then this
    delegates to the computational sensor pass exactly as it always did. That is what makes the
    addition safe for every graph already published with one in it.
    """
    policies = _declared_policies(payload.config)
    if not policies:
        return await interpreter_consultation_sensors(payload)

    result = await interpreter_consultation_sensors(payload)
    output: dict[str, Any] = dict(result.output or {})

    task_key = payload.config.get("taskKey") or "text.finalize"
    judgement, error_code = await resolve_text_selection(payload.tenant_id, task_key)
    if judgement is None:
        # Selection is fail-CLOSED: no judge, no policy verdicts — and the guard says so rather
        # than reporting the policies as satisfied.
        output["policyVerdicts"] = [
            {
                "key": policy.get("key"),
                "appliesTo": policy.get("appliesTo"),
                "status": "UNEVALUATED",
                "reason": "no text provider/model resolved for this tenant",
                "errorCode": error_code,
            }
            for policy in policies
        ]
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"grounding policies unevaluated ({error_code})",
            output=output,
        )

    verdicts: list[dict[str, Any]] = []
    for policy in policies:
        port = _TARGET_PORT[str(policy.get("appliesTo"))]
        subject = bound_value(payload.bound_inputs, port)
        if subject is None:
            # The policy names an input this graph never wired. Reported, never silently skipped:
            # a tenant that declared a transcript policy and wired no transcript has a graph
            # problem, and an empty verdict list would hide it.
            verdicts.append(
                {
                    "key": policy.get("key"),
                    "appliesTo": policy.get("appliesTo"),
                    "status": "UNEVALUATED",
                    "reason": f"no {policy.get('appliesTo')} is bound to this guard",
                    "errorCode": "policy_input_unbound",
                }
            )
            continue
        verdicts.append(await _evaluate_policy(payload, policy, judgement, subject))

    output["policyVerdicts"] = verdicts
    unevaluated = [v for v in verdicts if v.get("status") == "UNEVALUATED"]
    if unevaluated:
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"{len(unevaluated)} of {len(verdicts)} grounding policies could not be evaluated",
            output=output,
        )
    return NodeActivityResult(status=result.status, reason=result.reason, output=output or None)


GUARD_ACTIVITIES = [
    interpreter_guard_phi,
    interpreter_guard_moderation,
    interpreter_guard_groundedness,
]
