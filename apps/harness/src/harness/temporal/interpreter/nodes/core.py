"""The `core` vocabulary's activities — TASK-864 §3.1, the Python half.

One activity per `core.*` node type, mirroring `packages/workflow-contract/src/node-registry.ts`.
Three of them are REAL work (`core.agent`, `core.classify`, `core.output`), five are pure
functions of their input (`core.trigger`, `core.variable`, `core.condition`, `core.data`,
`core.note`), one is a DELEGATION table (`core.action` → the legacy node's own activity, by
`actionKey`), and two are OBSERVABLE non-execution placeholders whose real dispatch is a CHILD
WORKFLOW in the interpreter (`core.loop` → `LoopWorkflow`, `core.humanReview` →
`ReviewGateWorkflow`): they exist because compile() refuses an unimplemented type and the S-4
cross-check needs an activity NAME per type, and they degrade loudly if a history ever routes
them as activities (a pre-patch replay cannot, since no such history exists).

## Routing is a RESULT, not a side effect

A router node (`core.classify`, `core.condition`) and the review gate report which handle they
took on ``NodeActivityResult.taken_handle``. The WORKFLOW records it and skips every node whose
``branchGuards`` name no taken handle — the activity never reaches into the graph.

## What is NOT here, and must not be added

**No resolution of any reference from graph data.** An Agent slug is resolved by the gateway
(``/internal/agents/resolve`` — ONE resolution in the platform, TASK-863 §3.4), a classification
model slug likewise; this module receives references and asks. An adapter here that built its
own client from a graph value would be the cascade bypass rule 16 forbids — and BYOK funding is
derived from ``row.tenantId``, so it would mis-bill silently rather than fail.
"""

from __future__ import annotations

import json
import re
from typing import Any

import jsonschema
from temporalio import activity

from harness.core.config import get_settings
from harness.guards.phi.egress import ensure_egress_safe
from harness.guards.phi.redactor import PhiEgressBlocked
from harness.services.api_client import ApiServiceError
from harness.services.nlp_client import NlpServiceError
from harness.services.text_client import TextServiceError
from harness.temporal.activities import _api_client, _nlp_client, _phi_redactor, _text_client
from harness.temporal.claim_check import open_store, should_offload, store_blob
from harness.temporal.interpreter.expressions import evaluate_condition, evaluate_expression
from harness.temporal.interpreter.models import (
    EvaluateExpressionInput,
    EvaluateExpressionResult,
    NodeActivityInput,
    NodeActivityResult,
    ResolvedAgent,
    ResolvedClassificationModel,
)
from harness.temporal.interpreter.nodes._shared import (
    MISSING,
    STATUS_DEGRADED,
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
    resolve_dotted_path,
)
from harness.temporal.interpreter.nodes.agentic import interpreter_agentic_data
from harness.temporal.models import HarnessPolicy

# The `core.action` catalogue — the legacy node types that survive as ACTIONS, keyed by their
# own key. MUST stay byte-identical to `ACTION_KEYS` in
# `packages/workflow-contract/src/core-contract.ts`; `test_core_nodes.py` pins the list.
ACTION_KEYS: tuple[str, ...] = (
    "consultation.consentGate",
    "consultation.captureBinding",
    "consultation.extractEntities",
    "consultation.bindTerminology",
    "consultation.phiHop",
    "consultation.retrieveEvidence",
    "consultation.assemblePrompt",
    "consultation.sensors",
    "consultation.inferentialSensors",
    "consultation.persistDraft",
    "consultation.finalizeAssurance",
    "consultation.realtimeSummary",
    "consultation.suggestions",
    "consultation.proposeCorrections",
    "agent.transcription",
    "agent.normalization",
    "agent.ner",
    "agent.grammar",
    "agent.important_findings",
    "agent.retrieval",
    "agent.feedback",
    "agent.dna_redaction",
    "guard.phi",
    "guard.moderation",
    "guard.groundedness",
    "guardrail.check",
    "agentic.guardrail",
    "session.timeout",
    "summary.finalize",
    "feedback.capture",
    "prompt.template_ref",
)

_TEMPLATE_VARIABLE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")


def _config(payload: NodeActivityInput) -> dict[str, Any]:
    config = getattr(payload, "config", None)
    return config if isinstance(config, dict) else {}


def _bound(payload: NodeActivityInput) -> dict[str, Any]:
    bound = getattr(payload, "bound_inputs", None)
    return bound if isinstance(bound, dict) else {}


def _run_context(payload: NodeActivityInput) -> dict[str, Any]:
    context = getattr(payload, "run_context", None)
    return context if isinstance(context, dict) else {}


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _texts(value: Any) -> list[str]:
    """Every non-empty string reachable from a bound value (a string, a list of strings, or a
    dict carrying `text`)."""
    out: list[str] = []
    for item in _as_list(value):
        if isinstance(item, str) and item:
            out.append(item)
        elif isinstance(item, dict):
            text = item.get("text")
            if isinstance(text, str) and text:
                out.append(text)
    return out


def interpolate_template(template: str, context: dict[str, Any]) -> str:
    """Replace every ``{{path}}`` with the run-context value at that dotted path (pure).

    A path that does not resolve is left VERBATIM rather than blanked: a prompt that silently
    lost a variable is worse than one that shows the author which one is missing.
    """

    def _replace(match: re.Match[str]) -> str:
        value = resolve_dotted_path(context, match.group(1))
        if value is MISSING:
            return match.group(0)
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, sort_keys=True)

    return _TEMPLATE_VARIABLE.sub(_replace, template)


def _schema_violation(schema: Any, value: Any) -> str | None:
    """Validate ``value`` against a tenant-authored JSON Schema (TIER 3). Never raises."""
    if not isinstance(schema, dict) or not schema:
        return None
    try:
        jsonschema.validate(instance=value, schema=schema)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(part) for part in exc.absolute_path) or "(root)"
        return f"{path}: {exc.message}"
    except jsonschema.SchemaError as exc:
        return f"declared schema is not a valid JSON Schema: {exc.message}"
    return None


# ---------------------------------------------------------------------------------------------
# core.trigger — the ONE entry point
# ---------------------------------------------------------------------------------------------


@activity.defn(name="interpreter.core_trigger")
async def interpreter_core_trigger(payload: NodeActivityInput) -> NodeActivityResult:
    """Validate the run payload against the declared context schema and publish it as
    ``context`` — the consultation-context object every node reads.

    `critical: true` in the registry: a payload that does not match the schema its author
    declared is a run that cannot honestly proceed, so the violation is RAISED (an activity
    error), which the interpreter promotes to a run-level FAILED. Only an INLINE schema can be
    checked here; a row-referenced `contextSchemaId` is validated by the gateway before the run
    is dispatched (TASK-864 A6), so absence of an inline schema is not a missing check.
    """
    started = now()
    config = _config(payload)
    context = payload.run_payload if isinstance(payload.run_payload, dict) else {}
    schema = config.get("contextSchema")
    inline = schema.get("inline") if isinstance(schema, dict) else None
    violation = _schema_violation(inline, context)
    if violation is not None:
        await record_and_flush(payload, status=STATUS_ERROR, started=started)
        raise RuntimeError(
            f"core.trigger: run payload violates the declared context schema: {violation}"
        )
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output={"context": context})


# ---------------------------------------------------------------------------------------------
# core.variable — declare run variables
# ---------------------------------------------------------------------------------------------


@activity.defn(name="interpreter.core_variables")
async def interpreter_core_variables(payload: NodeActivityInput) -> NodeActivityResult:
    """Declared defaults, overlaid by whatever was bound into ``set`` (a dict per edge)."""
    started = now()
    config = _config(payload)
    variables: dict[str, Any] = {}
    for declared in config.get("variables") or []:
        if isinstance(declared, dict) and isinstance(declared.get("key"), str):
            variables[declared["key"]] = declared.get("default")
    for value in _as_list(_bound(payload).get("set")):
        if isinstance(value, dict):
            variables.update(value)
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output={"vars": variables})


# ---------------------------------------------------------------------------------------------
# core.condition — If/Else over CEL
# ---------------------------------------------------------------------------------------------


@activity.defn(name="interpreter.core_condition")
async def interpreter_core_condition(payload: NodeActivityInput) -> NodeActivityResult:
    """Evaluate the branches IN ORDER against the run context; the first `true` wins, else
    `else`. An expression error never routes a branch — it is recorded on the evaluation and the
    branch is treated as not taken, so a broken condition falls through to `else` observably."""
    started = now()
    config = _config(payload)
    context = _run_context(payload)
    errors: list[dict[str, str]] = []
    taken = "else"
    for branch in config.get("branches") or []:
        if not isinstance(branch, dict):
            continue
        key, when = branch.get("key"), branch.get("when")
        if not isinstance(key, str) or not isinstance(when, str):
            continue
        matched, error = evaluate_condition(when, context)
        if error is not None:
            errors.append({"branch": key, "error": error})
            continue
        if matched:
            taken = key
            break
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"evaluation": {"branch": taken, "matched": taken != "else", "errors": errors}},
        taken_handle=taken,
    )


@activity.defn(name="interpreter.core_evaluate")
async def interpreter_core_evaluate(payload: EvaluateExpressionInput) -> EvaluateExpressionResult:
    """Evaluate ONE condition — the `LoopWorkflow`'s `until` check. Pure and idempotent: a
    retry re-evaluates the same expression against the same context."""
    taken, error = evaluate_condition(payload.expression, payload.context)
    return EvaluateExpressionResult(taken=taken, error=error)


# ---------------------------------------------------------------------------------------------
# core.classify — route text into a declared class
# ---------------------------------------------------------------------------------------------


def _pick_class(
    classes: list[dict[str, Any]], probabilities: dict[str, float], threshold: float | None
) -> tuple[str | None, dict[str, float]]:
    """Map the model's OWN labels onto the declared classes (pure).

    Each class scores the MAX probability of the labels it claims (`labels[]`, or its own key);
    the winner must clear `threshold` or `otherwise` fires. Never invents a label the model did
    not emit.
    """
    scores: dict[str, float] = {}
    for declared in classes:
        key = declared.get("key")
        if not isinstance(key, str):
            continue
        labels = declared.get("labels") if isinstance(declared.get("labels"), list) else [key]
        best = 0.0
        for label in labels:
            if isinstance(label, str) and isinstance(probabilities.get(label), (int, float)):
                best = max(best, float(probabilities[label]))
        scores[key] = best
    if not scores:
        return None, scores
    winner = max(scores, key=lambda k: scores[k])
    if scores[winner] <= 0.0:
        return None, scores
    if threshold is not None and scores[winner] < threshold:
        return None, scores
    return winner, scores


@activity.defn(name="interpreter.core_classify")
async def interpreter_core_classify(payload: NodeActivityInput) -> NodeActivityResult:
    """Classify the bound text with the declared registry model and TAKE one class handle."""
    started = now()
    config = _config(payload)
    text = " ".join(_texts(_bound(payload).get("in")))
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="core.classify: no text arrived on the `in` port"
        )

    slug = config.get("modelSlug")
    if not isinstance(slug, str) or not slug:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_model_slug"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="core.classify: `modelSlug` is required"
        )

    settings = get_settings()
    try:
        raw_model = await _api_client(settings).resolve_model(
            slug=slug, tenant_id=payload.tenant_id, task_type="TEXT_CLASSIFICATION"
        )
        model = ResolvedClassificationModel.model_validate(raw_model)
    except (ApiServiceError, ValueError) as exc:
        # Selection fails CLOSED — nothing is substituted for an unresolvable model.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="model_unresolvable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"core.classify: model `{slug}` did not resolve: {exc}"
        )
    if not model.source_uri:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="model_unresolvable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"core.classify: model `{slug}` resolved with no sourceUri"
        )

    try:
        response = await _nlp_client(settings).classify_text(
            text,
            tenant_id=payload.tenant_id,
            model_name=model.source_uri,
            model_path=model.local_path,
        )
    except NlpServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="classify_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"core.classify: {exc}")

    probabilities = response.get("probabilities") if isinstance(response, dict) else None
    probabilities = probabilities if isinstance(probabilities, dict) else {}
    classes = [c for c in (config.get("classes") or []) if isinstance(c, dict)]
    threshold = config.get("threshold")
    category, scores = _pick_class(
        classes, probabilities, threshold if isinstance(threshold, (int, float)) else None
    )
    taken = category or "otherwise"

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "classification": {
                "category": category,
                "scores": scores,
                "label": response.get("predicted_label") if isinstance(response, dict) else None,
                "confidence": response.get("confidence") if isinstance(response, dict) else None,
            }
        },
        taken_handle=taken,
    )


# ---------------------------------------------------------------------------------------------
# core.agent — ONE task, by reference to a published Agent
# ---------------------------------------------------------------------------------------------


def _generation_params(resolved: ResolvedAgent, config: dict[str, Any]) -> dict[str, Any]:
    """The agent's own generation parameters, overlaid by the node's overrides. The RANGE check
    (overrides ⊆ the agent's declared ranges) is a publish-time gate on the TS side; here the
    merge is mechanical."""
    params = (
        resolved.parameters.get("generation") if isinstance(resolved.parameters, dict) else None
    )
    merged: dict[str, Any] = dict(params) if isinstance(params, dict) else {}
    overrides = config.get("overrides")
    if isinstance(overrides, dict) and isinstance(overrides.get("generation"), dict):
        merged.update(overrides["generation"])
    return merged


def _system_prompt(
    resolved: ResolvedAgent, config: dict[str, Any], context: dict[str, Any]
) -> str | None:
    """The agent's instruction, interpolated with `{{path}}` variables from the run context and
    the node's `overrides.promptVariables` (node wins)."""
    instruction = resolved.instruction if isinstance(resolved.instruction, dict) else {}
    compiled = resolved.compiled_config if isinstance(resolved.compiled_config, dict) else {}
    template = next(
        (
            value
            for value in (
                # TASK-863 resolves the instruction (a pinned template version's content, or
                # the inline prompt) once, gateway-side — that text wins over re-reading the
                # raw instruction here.
                resolved.resolved_prompt.content if resolved.resolved_prompt is not None else None,
                instruction.get("systemPrompt"),
                instruction.get("resolvedPrompt"),
                instruction.get("content"),
                compiled.get("systemPrompt"),
                compiled.get("resolvedPrompt"),
            )
            if isinstance(value, str) and value
        ),
        None,
    )
    if template is None:
        return None
    variables: dict[str, Any] = {}
    declared = instruction.get("variables")
    if isinstance(declared, dict):
        variables.update(declared)
    overrides = config.get("overrides")
    if isinstance(overrides, dict) and isinstance(overrides.get("promptVariables"), dict):
        variables.update(overrides["promptVariables"])
    scope = {**context, **variables, "variables": variables}
    return interpolate_template(template, scope)


async def _run_text_generation(
    payload: NodeActivityInput, resolved: ResolvedAgent, started: Any
) -> NodeActivityResult:
    config = _config(payload)
    bound = _bound(payload)
    prompt_parts = _texts(bound.get("in"))
    context_values = [value for value in _as_list(bound.get("context")) if value is not None]
    if context_values:
        prompt_parts.append(
            "Context:\n"
            + json.dumps(
                context_values if len(context_values) > 1 else context_values[0],
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
            )
        )
    user_prompt = "\n\n".join(prompt_parts)
    if not user_prompt:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="core.agent: nothing bound on `in`/`context` to generate from"
        )

    settings = get_settings()
    provider = resolved.model.provider
    model = resolved.model.source_uri or resolved.model.slug
    if not provider or not model:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_text_selection"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="core.agent: the resolved agent names no provider/model"
        )

    # PHI egress — the SAME fail-closed guard `generate.text` uses, with the tenant's own flags.
    try:
        raw_policy = await _api_client(settings).get_policy(payload.tenant_id)
        policy = HarnessPolicy.from_api(raw_policy)
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="policy_fetch_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"core.agent: effective policy fetch unreachable: {exc}"
        )

    system_prompt = _system_prompt(resolved, config, _run_context(payload))
    redactor = _phi_redactor()
    try:
        safe_prompt = ensure_egress_safe(
            user_prompt,
            provider=provider,
            settings=settings,
            phi_enabled=policy.phi_enabled,
            phi_fail_closed=policy.phi_fail_closed,
            redactor=redactor,
        )
        safe_system = (
            ensure_egress_safe(
                system_prompt,
                provider=provider,
                settings=settings,
                phi_enabled=policy.phi_enabled,
                phi_fail_closed=policy.phi_fail_closed,
                redactor=redactor,
            )
            if system_prompt
            else None
        )
    except PhiEgressBlocked as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="phi_egress_blocked"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"core.agent: phi egress blocked: {exc}"
        )

    generation = _generation_params(resolved, config)
    response_format = (
        resolved.parameters.get("responseFormat") if isinstance(resolved.parameters, dict) else None
    )
    response_schema = (
        resolved.parameters.get("responseSchema") if isinstance(resolved.parameters, dict) else None
    )
    wire_format: dict[str, Any] | None = None
    if response_format == "json_schema" and isinstance(response_schema, dict):
        wire_format = {"type": "json_schema", "json_schema": response_schema}
    elif response_format == "json":
        wire_format = {"type": "json_object"}

    try:
        result = await _text_client(settings).generate(
            tenant_id=payload.tenant_id,
            prompt=safe_prompt,
            system_prompt=safe_system,
            provider=provider,
            model=model,
            temperature=generation.get("temperature"),
            max_tokens=generation.get("maxTokens"),
            top_p=generation.get("topP"),
            response_format=wire_format,
        )
    except TextServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"core.agent: text generate failed: {exc}"
        )

    output: dict[str, Any] = {
        "text": result.content,
        "provider": result.provider or provider,
        "model": result.model or model,
        "usage": result.usage,
        "agent": {"slug": resolved.slug, "versionNumber": resolved.version_number},
    }
    if wire_format is not None:
        try:
            output["data"] = json.loads(result.content)
        except (TypeError, ValueError):
            output["data"] = None
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=output)


async def _run_transcription(
    payload: NodeActivityInput, resolved: ResolvedAgent, started: Any
) -> NodeActivityResult:
    # Imported inside the function: `activities.py` imports this module for `NODE_ACTIVITIES`,
    # so a module-level import of the legacy activities module here would be circular.
    from harness.temporal.activities import dispatch_batch_transcription  # noqa: PLC0415
    from harness.temporal.models import DispatchBatchTranscriptionInput  # noqa: PLC0415

    bound = _bound(payload)
    audio = bound.get("audio")
    audio_uri = None
    for candidate in _as_list(audio):
        if isinstance(candidate, str) and candidate:
            audio_uri = candidate
            break
        if isinstance(candidate, dict):
            for key in ("uri", "key", "url"):
                if isinstance(candidate.get(key), str) and candidate[key]:
                    audio_uri = candidate[key]
                    break
        if audio_uri:
            break
    if audio_uri is None:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_audio"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="core.agent: no audio artifact reference arrived on the `audio` port",
        )

    config = _config(payload)
    language = None
    decoding = (
        resolved.parameters.get("decoding") if isinstance(resolved.parameters, dict) else None
    )
    if isinstance(decoding, dict) and isinstance(decoding.get("language"), str):
        language = decoding["language"]
    result = await dispatch_batch_transcription(
        DispatchBatchTranscriptionInput(
            tenant_id=payload.tenant_id,
            # TODO(TASK-861): pass the agent's `resolvedSpec` once the batch path accepts one.
            # Until then the batch dispatcher is keyed by the resolved ASR model's slug.
            pipeline_id=resolved.model.slug,
            audio_uri=audio_uri,
            language=language,
            poll_timeout_seconds=int(config.get("timeoutSeconds") or 900),
        )
    )
    await record_and_flush(payload, status=STATUS_OK, started=started)
    output = {
        "transcript": getattr(result, "transcript", None),
        "jobId": result.job_id,
        "agent": {"slug": resolved.slug, "versionNumber": resolved.version_number},
    }
    if result.timed_out or result.status != "COMPLETED":
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"core.agent: batch transcription job {result.job_id} is {result.status}"
            + (" (poll timed out; the job is still running)" if result.timed_out else ""),
            output=output,
        )
    return NodeActivityResult(status="SUCCEEDED", output=output)


async def _run_speech(
    payload: NodeActivityInput, resolved: ResolvedAgent, started: Any
) -> NodeActivityResult:
    from harness.temporal.activities import dispatch_speech_synthesis  # noqa: PLC0415
    from harness.temporal.claim_check import store_bytes  # noqa: PLC0415
    from harness.temporal.models import SpeechSynthesisInput  # noqa: PLC0415

    text = " ".join(_texts(_bound(payload).get("in")))
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="core.agent: no text arrived on the `in` port — nothing to synthesize",
        )
    if payload.sandbox:
        # `core.agent` is not `external_write` on the TYPE (an LLM agent must run in a sandbox);
        # the artifact write of a TTS agent is suppressed HERE instead.
        return NodeActivityResult(status="SKIPPED", reason="sandbox")

    params = resolved.parameters if isinstance(resolved.parameters, dict) else {}
    voice = params.get("voice")
    if not isinstance(voice, str) or not voice:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_voice"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="core.agent: the resolved TTS agent names no `voice`"
        )
    try:
        synthesis = await dispatch_speech_synthesis(
            SpeechSynthesisInput(
                tenant_id=payload.tenant_id,
                text=text,
                voice=voice,
                audio_format=(
                    params.get("format") if isinstance(params.get("format"), str) else None
                ),
                speed=(
                    float(params["speed"])
                    if isinstance(params.get("speed"), (int, float))
                    else None
                ),
                language=(
                    params.get("language") if isinstance(params.get("language"), str) else None
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 — degrade, never raise; the reason stays on the node
        await record_and_flush(payload, status=STATUS_ERROR, started=started)
        return NodeActivityResult(status="DEGRADED", reason=f"core.agent: synthesis failed: {exc}")
    if not synthesis.audio:
        await record_and_flush(payload, status=STATUS_ERROR, started=started)
        return NodeActivityResult(
            status="DEGRADED", reason="core.agent: synthesis returned no audio"
        )
    settings = get_settings()
    store, location = await open_store(settings.claim_check)
    ref = await store_bytes(
        synthesis.audio, store=store, bucket=location.bucket, content_type=synthesis.content_type
    )
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "audio": ref.model_dump(),
            "agent": {"slug": resolved.slug, "versionNumber": resolved.version_number},
        },
    )


@activity.defn(name="interpreter.core_agent")
async def interpreter_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    """Resolve the referenced Agent through the gateway and dispatch by its TASK."""
    started = now()
    config = _config(payload)
    ref = config.get("agentRef")
    slug = ref.get("slug") if isinstance(ref, dict) else None
    if not isinstance(slug, str) or not slug:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_agent_ref"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="core.agent: `agentRef.slug` is required"
        )
    version = ref.get("versionNumber") if isinstance(ref, dict) else None

    try:
        raw = await _api_client(get_settings()).resolve_agent(
            slug=slug, tenant_id=payload.tenant_id
        )
        resolved = ResolvedAgent.model_validate(raw)
    except (ApiServiceError, ValueError) as exc:
        # Fails CLOSED: an unresolvable agent is never substituted with a default.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="agent_unresolvable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"core.agent: agent `{slug}` did not resolve: {exc}"
        )
    if isinstance(version, int) and resolved.version_number != version:
        # The gateway resolves the ACTIVE published version and takes no pin (TASK-863 §3.4), so
        # honouring `agentRef.versionNumber` means REFUSING a different one — a pin that ran
        # whatever is active would be no pin at all. Fails CLOSED, like every other selection.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="agent_version_drift"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=(
                f"core.agent: `{slug}` is pinned to v{version} but the gateway resolved "
                f"v{resolved.version_number}"
            ),
        )

    if resolved.task == "TEXT_GENERATION":
        return await _run_text_generation(payload, resolved, started)
    if resolved.task == "SPEECH_TO_TEXT":
        return await _run_transcription(payload, resolved, started)
    return await _run_speech(payload, resolved, started)


# ---------------------------------------------------------------------------------------------
# core.output — the end point
# ---------------------------------------------------------------------------------------------


def _output_payload(bound: dict[str, Any]) -> Any:
    """The run's result: the ONE bound value when one edge arrives, the bound map otherwise."""
    values = [value for key, value in bound.items() if key != "after"]
    if len(values) == 1:
        return values[0]
    return {key: value for key, value in bound.items() if key != "after"}


@activity.defn(name="interpreter.core_output")
async def interpreter_core_output(payload: NodeActivityInput) -> NodeActivityResult:
    """Validate the result against `outputSchema`, claim-check it per `claimCheck`, publish it.

    `onSchemaViolation: fail` (the default) RAISES so the run is FAILED (the node is
    `critical`); `degrade` publishes the mismatching payload marked DEGRADED. Never silently
    reshapes. `external_write` in the registry — a sandbox run is skipped by the interpreter.
    """
    started = now()
    config = _config(payload)
    result = _output_payload(_bound(payload))
    violation = _schema_violation(config.get("outputSchema"), result)
    if violation is not None:
        mode = config.get("onSchemaViolation") or "fail"
        await record_and_flush(payload, status=STATUS_ERROR, started=started)
        if mode == "fail":
            raise RuntimeError(
                f"core.output: result violates the declared output schema: {violation}"
            )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"io_schema_violation: {violation}",
            output={"payload": result},
        )

    settings = get_settings()
    mode = config.get("claimCheck") or "auto"
    serialized = json.dumps(result, sort_keys=True, ensure_ascii=False, default=str)
    output: dict[str, Any] = {}
    offload = mode == "always" or (
        mode == "auto"
        and settings.claim_check.enabled
        and should_offload(serialized, min_bytes=settings.claim_check.min_bytes)
    )
    if offload and settings.claim_check.enabled:
        store, location = await open_store(settings.claim_check)
        ref = await store_blob(serialized, store=store, bucket=location.bucket)
        output["resultRef"] = ref.model_dump()
    else:
        output["payload"] = result
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=output)


# ---------------------------------------------------------------------------------------------
# core.data / core.note / core.action / placeholders
# ---------------------------------------------------------------------------------------------


@activity.defn(name="interpreter.core_data")
async def interpreter_core_data(payload: NodeActivityInput) -> NodeActivityResult:
    """The Data node under its `core` key — the SAME deterministic reshape as `agentic.data`."""
    return await interpreter_agentic_data(payload)


@activity.defn(name="interpreter.core_note")
async def interpreter_core_note(payload: NodeActivityInput) -> NodeActivityResult:
    """A canvas comment. `compile()` strips it; if a compiled artifact ever carries one, it is an
    observable skip, never work."""
    return NodeActivityResult(status="SKIPPED", reason="annotation")


@activity.defn(name="interpreter.core_action")
async def interpreter_core_action(payload: NodeActivityInput) -> NodeActivityResult:
    """Delegate to the legacy node type named by `actionKey`, with the action's own config.

    The delegate's activity is called DIRECTLY (a plain coroutine — `agentic.agent` does the
    same for `generate.text`), under a payload whose `node_type` is the action key so every
    trajectory row still names the capability that ran. `record_and_flush` is the delegate's.
    """
    # Imported here rather than at module scope: `registry.py` imports this module.
    from harness.temporal.interpreter.registry import ACTION_CATALOGUE  # noqa: PLC0415

    config = _config(payload)
    key = config.get("actionKey")
    spec = ACTION_CATALOGUE.get(key) if isinstance(key, str) else None
    if spec is None:
        started = now()
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="unknown_action"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"core.action: `actionKey` {key!r} is not in the action catalogue",
        )
    action_config = config.get("action") if isinstance(config.get("action"), dict) else {}
    # The runtime knobs travel with the action; `enabled` was already honoured by the walk.
    merged = {**action_config}
    for knob in ("timeoutSeconds", "retry", "onError"):
        if knob in config and knob not in merged:
            merged[knob] = config[knob]
    delegated = payload.model_copy(update={"node_type": spec.key, "config": merged})
    return await spec.activity(delegated)


_CHILD_WORKFLOW_ONLY = (
    "{node} is dispatched by the interpreter as a CHILD WORKFLOW ({workflow}) behind the "
    "`task-864-core-vocabulary` patch; running it as an activity is an observable non-execution."
)


@activity.defn(name="interpreter.core_loop")
async def interpreter_core_loop(payload: NodeActivityInput) -> NodeActivityResult:
    return NodeActivityResult(
        status="DEGRADED",
        reason=_CHILD_WORKFLOW_ONLY.format(node="core.loop", workflow="LoopWorkflow"),
    )


@activity.defn(name="interpreter.core_human_review")
async def interpreter_core_human_review(payload: NodeActivityInput) -> NodeActivityResult:
    return NodeActivityResult(
        status="DEGRADED",
        reason=_CHILD_WORKFLOW_ONLY.format(node="core.humanReview", workflow="ReviewGateWorkflow"),
    )


def evaluate_over_path(context: dict[str, Any], path: str) -> list[Any] | None:
    """Read a `foreach` loop's `over` path off the run context (pure). `None` when the path does
    not resolve to a list — the parent degrades the loop rather than iterating nothing."""
    value = resolve_dotted_path(context, path)
    if value is MISSING:
        result = evaluate_expression(path, context)
        value = result.value if result.error is None else MISSING
    return value if isinstance(value, list) else None


# Spread into `activities.NODE_ACTIVITIES` — see that list's note on the two hand-kept lists.
CORE_ACTIVITIES = [
    interpreter_core_trigger,
    interpreter_core_variables,
    interpreter_core_condition,
    interpreter_core_evaluate,
    interpreter_core_classify,
    interpreter_core_agent,
    interpreter_core_output,
    interpreter_core_data,
    interpreter_core_note,
    interpreter_core_action,
    interpreter_core_loop,
    interpreter_core_human_review,
]
