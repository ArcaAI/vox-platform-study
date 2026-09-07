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
from collections.abc import Callable
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
from harness.temporal.interpreter.guardrail_optout import (
    GuardrailDecision,
    guardrail_opt_out_of,
    resolve_guardrail_decision,
)
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
    record_generation_and_flush,
    resolve_dotted_path,
)
from harness.temporal.interpreter.nodes._text_fallback import (
    ActivityBudget,
    TextFallbackBlock,
    TextFallbackCandidate,
    candidate_as_resolved_agent,
    chain_candidates,
    read_text_fallback,
    read_text_primary,
    wire_provider,
)
from harness.temporal.interpreter.nodes.agentic import interpreter_agentic_data
from harness.temporal.interpreter.templating import PromptVariableUnresolved, render_template
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
    "agent.dna_style",
    "guard.phi",
    "guard.moderation",
    "guard.groundedness",
    "guardrail.check",
    "agentic.guardrail",
    "session.timeout",
    "summary.finalize",
    "feedback.capture",
    # TASK-882 — the whole endpoint stage is authorable through `core.action`.
    "livedoc.stop",
    "harness.finalize",
    "prompt.template_ref",
)


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
    error), which the interpreter promotes to a run-level FAILED.

    TASK-890 §3.4 — two authoring shapes, ONE check here. A BY-REFERENCE `contextSchemaId` is
    resolved at PUBLISH time by the gateway, which freezes the derived payload schema onto the
    compiled trigger as `contextSchema.resolved` (`compiler.ts`); an ad-hoc graph carries
    `contextSchema.inline`. The frozen one wins — it is the version the graph was published
    against — and neither costs this activity a database read (invariant 4). Absence of both is
    an unbound trigger, not a missing check.
    """
    started = now()
    config = _config(payload)
    context = payload.run_payload if isinstance(payload.run_payload, dict) else {}
    schema = config.get("contextSchema") if isinstance(config.get("contextSchema"), dict) else {}
    declared = schema.get("resolved") if isinstance(schema, dict) else None
    if not isinstance(declared, dict):
        declared = schema.get("inline") if isinstance(schema, dict) else None
    violation = _schema_violation(declared, context)
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


#: The registry task whose models emit SPANS rather than a class distribution. The other
#: accepted task (TEXT_CLASSIFICATION) is a sequence classifier; `core.classify`'s own config
#: schema accepts either, and the ROUTE must follow the row's own task — nlp answers 503
#: "Text classification model not available" for a token checkpoint on `/classify/text`.
TOKEN_CLASSIFICATION = "TOKEN_CLASSIFICATION"


def _confidence_of(entity: dict[str, Any]) -> float:
    value = entity.get("confidence")
    return float(value) if isinstance(value, (int, float)) else 0.0


def _kept_entities(entities: Any, threshold: float | None) -> list[dict[str, Any]]:
    """The spans that clear the node's threshold (absent threshold ⇒ every span). Pure."""
    kept: list[dict[str, Any]] = []
    for entity in _as_list(entities):
        if not isinstance(entity, dict):
            continue
        if threshold is not None and _confidence_of(entity) < threshold:
            continue
        kept.append(entity)
    return kept


def _entity_type_scores(kept: list[dict[str, Any]]) -> dict[str, float]:
    """Per ENTITY TYPE, the best confidence the model reported — the token model's answer in
    the same shape `_pick_class` reads for a sequence model's `probabilities`. Pure."""
    scores: dict[str, float] = {}
    for entity in kept:
        entity_type = entity.get("entity_type")
        if not isinstance(entity_type, str) or not entity_type:
            continue
        scores[entity_type] = max(scores.get(entity_type, 0.0), _confidence_of(entity))
    return scores


def _catch_all_class(classes: list[dict[str, Any]]) -> str | None:
    """The first declared class that names NO model labels of its own, or ``None``.

    A token classifier's labels ARE entity types, so a class that names some (`labels: [...]`)
    is scored by label exactly like a sequence model's class. A class that names NONE cannot be
    scored that way — for a sequence model it falls back to "the key IS the label", which for a
    token model would never match anything. It is read here as the author's other honest
    intent: *did the model find anything at all?* Absence stays absence — when nothing clears
    the threshold no class is taken and `otherwise` fires, which is the handle that means it.
    """
    for declared in classes:
        key = declared.get("key")
        labels = declared.get("labels")
        if isinstance(key, str) and key and not (isinstance(labels, list) and labels):
            return key
    return None


def _extractor_labels(
    classes: list[dict[str, Any]], label_taxonomy: dict[str, Any] | None
) -> list[str]:
    """The label set an OPEN-taxonomy extractor is asked to look for (pure).

    F14 — a `gliner2` checkpoint carries no labels of its own, so `apps/nlp` fails closed
    without them. Two honest sources, in order:

    1. the node's OWN ``classes[].labels`` — the author naming the MODEL labels each declared
       class claims (the same field `_pick_class` scores by);
    2. the registry row's ``_metadata.labelTaxonomy.labels``, gateway-resolved on the same
       tenant -> SYSTEM cascade that chose the model.

    A class KEY is deliberately NOT a fallback: `pii_present` is the author's semantic bucket,
    not an entity type the model was trained on, and asking an extractor for it would return
    nothing forever. That is what `_catch_all_class` reads on the way back. Neither source ⇒
    an EMPTY list, which the caller omits — a closed-taxonomy checkpoint needs none, and for
    an extractor "nobody configured a taxonomy" must surface as nlp's 503, not as an invented
    list from here.
    """
    labels: list[str] = []
    for declared in classes:
        raw_labels = declared.get("labels")
        if not isinstance(raw_labels, list):
            continue
        for label in raw_labels:
            if isinstance(label, str) and label and label not in labels:
                labels.append(label)
    if labels:
        return labels
    taxonomy_labels = (label_taxonomy or {}).get("labels")
    if not isinstance(taxonomy_labels, list):
        return []
    return [
        label
        for index, label in enumerate(taxonomy_labels)
        if isinstance(label, str) and label and label not in taxonomy_labels[:index]
    ]


def _class_of_label(classes: list[dict[str, Any]]) -> dict[str, str]:
    """model label → the FIRST declared class claiming it (pure)."""
    owner: dict[str, str] = {}
    for declared in classes:
        key = declared.get("key")
        if not isinstance(key, str) or not key:
            continue
        raw_labels = declared.get("labels")
        labels = raw_labels if isinstance(raw_labels, list) else [key]
        for label in labels:
            if isinstance(label, str) and label:
                owner.setdefault(label, key)
    return owner


def _spans_of(kept: list[dict[str, Any]], classes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The matched spans, each tagged with the class that claims it (pure)."""
    owner = _class_of_label(classes)
    catch_all = _catch_all_class(classes)
    spans: list[dict[str, Any]] = []
    for entity in kept:
        entity_type = entity.get("entity_type")
        raw_position = entity.get("position")
        position: dict[str, Any] = raw_position if isinstance(raw_position, dict) else {}
        claimed = owner.get(entity_type) if isinstance(entity_type, str) else None
        spans.append(
            {
                "text": entity.get("text"),
                "type": entity_type,
                "start": position.get("start"),
                "end": position.get("end"),
                "confidence": entity.get("confidence"),
                "class": claimed if claimed is not None else catch_all,
            }
        )
    return spans


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
        raw_labels = declared.get("labels")
        labels = raw_labels if isinstance(raw_labels, list) else [key]
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
        # NO task pin, deliberately (F11). `core.classify`'s own config schema
        # accepts a TEXT_CLASSIFICATION *or* TOKEN_CLASSIFICATION slug, and BOTH
        # classification-capable rows the platform seeds
        # (`gliner2-guardrails-pii-multi`, `medical-ner`) are TOKEN_CLASSIFICATION
        # — so the former hardcoded `task_type="TEXT_CLASSIFICATION"` 404'd the
        # very models this node is authored against. The gateway answers with the
        # row's OWN `taskType`; the node reads what it got rather than dictating it.
        raw_model = await _api_client(settings).resolve_model(
            slug=slug, tenant_id=payload.tenant_id
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

    classes = [c for c in (config.get("classes") or []) if isinstance(c, dict)]
    raw_threshold = config.get("threshold")
    threshold = float(raw_threshold) if isinstance(raw_threshold, (int, float)) else None
    is_token = model.task_type == TOKEN_CLASSIFICATION
    nlp = _nlp_client(settings)

    try:
        # F13 — the ROUTE follows the row's own task. A TOKEN_CLASSIFICATION checkpoint on
        # `/classify/text` is a 503 ("Text classification model not available"), which is what
        # both seeded classify rows hit; the registry facts are identical either way.
        if is_token:
            response = await nlp.classify_tokens_raw(
                text,
                tenant_id=payload.tenant_id,
                model_name=model.source_uri,
                model_path=model.local_path,
                # F14 — the OPEN taxonomy an extractor checkpoint needs, and the node's own
                # floor so the model's answer is filtered once, at the threshold the author
                # declared. Both omitted when absent (a closed-taxonomy checkpoint ignores them).
                labels=_extractor_labels(classes, model.label_taxonomy) or None,
                threshold=threshold,
            )
        else:
            response = await nlp.classify_text(
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
    response = response if isinstance(response, dict) else {}

    classification: dict[str, Any]
    if is_token:
        kept = _kept_entities(response.get("entities"), threshold)
        by_type = _entity_type_scores(kept)
        category, scores = _pick_class(classes, by_type, threshold)
        if category is None and kept:
            catch_all = _catch_all_class(classes)
            if catch_all is not None:
                scores[catch_all] = max(_confidence_of(entity) for entity in kept)
                category = catch_all
        top_label = max(by_type, key=lambda label: by_type[label]) if by_type else None
        classification = {
            "category": category,
            "scores": scores,
            "label": top_label,
            "confidence": by_type.get(top_label) if top_label is not None else None,
        }
        if config.get("spans") is True:
            # A possibly-EMPTY list when the node asked for spans: "the model found nothing"
            # and "nobody looked" are different answers and must read differently.
            classification["spans"] = _spans_of(kept, classes)
    else:
        probabilities = response.get("probabilities")
        category, scores = _pick_class(
            classes, probabilities if isinstance(probabilities, dict) else {}, threshold
        )
        classification = {
            "category": category,
            "scores": scores,
            "label": response.get("predicted_label"),
            "confidence": response.get("confidence"),
        }

    # The classified TEXT rides through on `out` beside the verdict. `out` is an `object` port
    # keyed `classification`, so without this a node bound downstream (another classify, or an
    # agent reading `context`) is handed a verdict with no text in it and degrades with "no text
    # arrived on the `in` port" — which is how a PII node quietly took the whole chain with it.
    classification["text"] = text

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"classification": classification},
        taken_handle=category or "otherwise",
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


#: The ``context.*`` / ``trigger.*`` namespace ROOT of the §3.3 render scope. Mirrors
#: ``CONTEXT_NAMESPACE_ROOT`` in
#: ``packages/applications/src/services/consultation-context-schema/context-schema-definition.ts``.
CONTEXT_NAMESPACE_ROOT = "context"


def _sole_context_kind(payload_schema: Any) -> dict[str, Any] | None:
    """The kind's own schema when the ENVELOPE adds nothing, else ``None`` (J3-5).

    ``payloadSchemaFromDefinition`` keys a declaration's payload under each declared kind, which
    is right whenever there are several — ``{"audio": …, "patient": …}`` is genuinely an envelope
    and the key is the only thing saying which kind a value belongs to. It is wrong for exactly
    one case, and that case is the one the platform SEEDS: ``consultation_legacy_v1`` declares a
    single kind keyed ``context``, so the envelope is ``{"context": {"safe_age", …}}`` while
    every seeded template reads ``{{context.safe_age}}``.

    Hand-written mirror of ``soleContextKindSchema``; the rule is narrow on purpose so the two
    implementations have almost nothing to disagree about.
    """
    if not isinstance(payload_schema, dict):
        return None
    properties = payload_schema.get("properties")
    if not isinstance(properties, dict) or list(properties) != [CONTEXT_NAMESPACE_ROOT]:
        return None
    kind = properties[CONTEXT_NAMESPACE_ROOT]
    return kind if isinstance(kind, dict) else None


def _unwrap_single_kind_context(payload_schema: Any, payload: Any) -> Any:
    """The object a ``context.*`` reference resolves against. Mirrors
    ``unwrapSingleKindContextPayload``.

    Both call shapes converge here: a standalone invocation supplies the flat kind object and a
    workflow run's validated trigger is the envelope. The envelope is recognised only when it is
    UNAMBIGUOUS — an object whose sole key is ``context`` and whose value is itself an object —
    so a flat payload that merely carries a ``context`` field alongside others is left alone
    rather than guessed at.
    """
    if _sole_context_kind(payload_schema) is None or not isinstance(payload, dict):
        return payload
    if list(payload) != [CONTEXT_NAMESPACE_ROOT]:
        return payload
    inner = payload[CONTEXT_NAMESPACE_ROOT]
    return inner if isinstance(inner, dict) else payload


def _bound_context_payload_schema(resolved: ResolvedAgent) -> Any:
    """The agent's FROZEN context payload schema, or ``None``. No database read (invariant 4)."""
    compiled = resolved.compiled_config if isinstance(resolved.compiled_config, dict) else {}
    schema = compiled.get("contextSchema")
    return schema.get("payloadSchema") if isinstance(schema, dict) else None


def _prompt_scope(
    variables: dict[str, Any],
    run_context: dict[str, Any],
    context_payload_schema: Any = None,
) -> dict[str, Any]:
    """The render scope of §3.3, built once so both call shapes agree.

    Roots: the run env's ``trigger`` / ``vars`` / ``nodes``, the bare names bound by the agent's
    ``instruction.variables`` (overlaid by the node's ``overrides.promptVariables``), and
    ``context`` as an ALIAS of ``trigger`` — unwrapped through ``_unwrap_single_kind_context``
    when the agent's frozen schema declares a single kind keyed ``context`` (J3-5).

    The alias is what makes ONE prompt portable between a workflow run — where the validated
    payload arrives as ``trigger`` — and a standalone ``POST /agents/:slug/invocations``, where
    the caller supplies it as ``context``. It is applied BEFORE the bare names, so an agent that
    genuinely declares a variable called ``context`` still wins; and it is skipped when the run
    published no trigger, because binding an empty object would turn "this run has no trigger"
    into "this field does not exist", which are different findings for the author.

    ``variables`` also stays reachable under its own key: the pre-890 scope exposed it that way
    and a seeded instruction may reference ``{{variables.x}}``.

    Each ``variables`` entry is a BINDING — ``{"value": …}`` is a literal, ``{"path": …}`` is a
    reference resolved against the roots — or a plain value (which is what an
    ``overrides.promptVariables`` entry supplies). Resolution happens BEFORE the bare names are
    assigned, so ``{{age}}`` and ``{{context.patientAge}}`` are the same value (§3.3) and a
    binding never sees another bare name. Mirrors ``buildAgentPromptScope``
    (``packages/applications/src/services/agent/agent-prompt-scope.ts``): the durable lane, the
    realtime lane, the invocation route and the draft bench must render one agent one way.
    """
    scope: dict[str, Any] = dict(run_context)
    trigger = run_context.get("trigger")
    if isinstance(trigger, dict):
        # J3-5 — the alias is the CONTEXT VIEW of the payload, which under the single-kind rule
        # is the kind itself rather than the envelope wrapping it. ``trigger`` stays the run
        # payload verbatim: on a workflow lane that root IS what ``core.trigger`` validated, and
        # the two roots being different views is the honest answer.
        scope["context"] = _unwrap_single_kind_context(context_payload_schema, trigger)
    resolved = {
        name: _resolve_binding(binding, scope, f"instruction.variables.{name}")
        for name, binding in variables.items()
    }
    scope.update(resolved)
    scope["variables"] = resolved
    return scope


def _resolve_binding(binding: Any, scope: dict[str, Any], template_ref: str) -> Any:
    """One ``instruction.variables`` entry, resolved against the roots.

    ``{"value": <str>}`` is a literal and ``{"path": <str>}`` a reference; anything else — a
    plain string an override supplied, a number, a shape nobody declared — is the value itself.
    A ``{"path"}`` that resolves to nothing raises ``PromptVariableUnresolved`` NAMING THE PATH,
    which the activity turns into a DEGRADED step: a binding that silently vanished is how a
    prompt loses a variable with nobody noticing.
    """
    if not isinstance(binding, dict):
        return binding
    if isinstance(binding.get("value"), str):
        return binding["value"]
    path = binding.get("path")
    if isinstance(path, str):
        return render_template("{{" + path + "}}", scope, template_ref=template_ref)
    return binding


def _system_prompt(
    resolved: ResolvedAgent, config: dict[str, Any], context: dict[str, Any]
) -> str | None:
    """The agent's instruction, rendered through the ONE grammar (§3.2) over the §3.3 scope: the
    run env's ``trigger`` / ``vars`` / ``nodes`` (plus the ``context`` alias) and the agent's own
    bound variables, overlaid by the node's ``overrides.promptVariables`` (node wins).

    Raises ``PromptVariableUnresolved`` when a placeholder resolves to nothing and declares no
    ``default("…")``. The caller degrades the step on it — a prompt that silently lost a
    variable, or that shipped a literal ``{{…}}`` to the model, is the failure this replaces.
    """
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
    return render_template(
        template,
        _prompt_scope(variables, context, _bound_context_payload_schema(resolved)),
        template_ref=f"agent:{resolved.slug}",
    )


#: OD-E's closed `trigger` vocabulary, mirrored from
#: `packages/applications/src/services/usageLedger/usage-attributes.ts` (`USAGE_TRIGGERS`). A
#: value outside that list is dropped by the ledger's attribute allow-list, so the two spellings
#: have to stay in step; every generation on this lane is caused by one product activity.
USAGE_TRIGGER_WORKFLOW_RUN = "WORKFLOW_RUN"

#: The screening dispositions the same file declares (`GUARDRAIL_DISPOSITIONS`). Only the two
#: this lane can honestly decide: `platform_off` is Text's own kill-switch state and is not
#: observable from here.
GUARDRAIL_DISPOSITION_SCREENED = "screened"
GUARDRAIL_DISPOSITION_OPTED_OUT = "opted_out"


def _generation_stats(
    result: Any,
    *,
    provider: str,
    model: str,
    funding_tier: str | None,
    guardrail: GuardrailDecision,
) -> dict[str, Any]:
    """The AD-1 ``GenerationStats`` block, plus the three dimensions this lane owns (pure).

    Mirrors ``activities.py::generate`` exactly on the first part: Text's own stats VERBATIM (so
    whatever cache/engine-native counters it reports reach the rollups untouched), with
    ``provider``/``model`` backfilled only when Text itself named none — a legacy cache hit
    returns no stats block at all, and the gateway's mapper refuses to bill a step it cannot
    attribute (``if (!rawProvider) return null``).

    The three additions are what a WORKFLOW-lane generation knows and the consultation lane does
    not:

    * ``trigger`` — OD-E's closed vocabulary. A ledger row without it cannot answer "why did
      this tenant's spend double".
    * ``funding_tier`` — the tier the GATEWAY derived for the candidate that actually served
      (``textPrimary.fundingTier`` / the fallback candidate's own). It is DERIVED, never stamped:
      absent stays absent, because a guessed tier converts tenant-funded spend into platform
      COGS with one wrong literal.
    * ``guardrail`` — the disposition the node folded ONCE for the whole fallback walk. Only the
      two levels this lane decides are expressible; ``platform_off`` is Text's own kill-switch
      state and is not observable from here, so it is never claimed.
    """
    stats: dict[str, Any] = dict(getattr(result, "stats", None) or {})
    if not stats.get("provider"):
        stats["provider"] = getattr(result, "provider", None) or provider
    if not stats.get("model"):
        stats["model"] = getattr(result, "model", None) or model
    stats["trigger"] = USAGE_TRIGGER_WORKFLOW_RUN
    if funding_tier:
        stats["funding_tier"] = funding_tier
    stats["guardrail"] = (
        GUARDRAIL_DISPOSITION_SCREENED if guardrail.enabled else GUARDRAIL_DISPOSITION_OPTED_OUT
    )
    return stats


async def _run_text_generation(
    payload: NodeActivityInput,
    resolved: ResolvedAgent,
    started: Any,
    fallback: TextFallbackBlock | None = None,
    primary: TextFallbackCandidate | None = None,
) -> NodeActivityResult:
    """Generate on the resolved agent, switching along its GATEWAY-RESOLVED fallback chain.

    TASK-876: ``fallback`` is the ``textFallback`` block of the resolve answer — the tenant's
    per-agent HA toggle and the ordered candidates the gateway already resolved (explicit fallback
    agent | the agent's own model chain, then the SYSTEM platform default), each with its own
    provider, model, prompt, parameters and DERIVED funding. On a ``TextServiceError`` the next
    candidate is tried while ``autoSwitch`` is on; the output names the row that SERVED
    (``agent`` / ``selectionSource`` / ``fundingTier``), so metering follows it. Activity-level
    semantics only — the workflow stays deterministic and sees one activity result.

    ``primary`` is the resolve answer's ``textPrimary`` — the PRIMARY candidate with the funding
    tier the gateway DERIVED from the row that serves it. It is what makes the primary attempt
    attributable on the same rule as every fallback: bare ``ResolvedAgent.fundingTier`` is set
    only for a cloud BYO override, so without it a self-hosted platform primary emits
    ``fundingTier: null`` while its own fallback emits ``"platform"``.
    """
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
    if not wire_provider(resolved.model.provider) or not (
        resolved.model.source_uri or resolved.model.slug
    ):
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

    # The PRIMARY carries the gateway-derived funding tier when the answer shipped one; the
    # agent row is otherwise unchanged (same model, prompt, parameters).
    primary_agent = (
        resolved
        if primary is None
        else resolved.model_copy(update={"funding_tier": primary.funding_tier})
    )
    candidates: list[tuple[str, ResolvedAgent]] = [("agent", primary_agent)]
    candidates.extend(
        ("agent-fallback", candidate_as_resolved_agent(candidate))
        for candidate in chain_candidates(fallback)
    )

    # TASK-890 §3.14 (OD-R) — fold the guardrail opt-out ONCE, before the walk: every candidate
    # of one node carries the same decision, because switching engines on a provider outage must
    # never change whether the call is screened.
    #
    # Two of the three levels are in scope here. The NODE's own `config.guardrail` is authored on
    # the graph and travels with the activity input; the AGENT's is the gateway-resolved
    # `compiledConfig.guardrail` (absent on any artifact published before this ticket, which
    # `resolve_guardrail_decision` reads as silence and therefore as ON). The WORKFLOW default
    # (`policyBindings.guardrail`) is NOT yet threaded into `NodeActivityInput` by `workflow.py`,
    # so a workflow-level opt-out is honoured on the realtime lane and inherited-as-ON here — a
    # lane divergence recorded as a follow-up rather than papered over with a second read.
    compiled_config = resolved.compiled_config if isinstance(resolved.compiled_config, dict) else {}
    agent_guardrail = compiled_config.get("guardrail")
    guardrail_decision = resolve_guardrail_decision(
        node=guardrail_opt_out_of(config),
        agent=agent_guardrail.get("enabled") if isinstance(agent_guardrail, dict) else None,
    )

    # The whole walk runs inside ONE activity budget: a switch started too late times the
    # activity out mid-call and Temporal re-runs it FROM THE PRIMARY, re-billing a generation
    # that already completed. Never start a candidate whose call cannot finish in what is left.
    budget = ActivityBudget.for_activity(settings.text_timeout_s)
    run_context = _run_context(payload)
    redactor = _phi_redactor()
    last_error: TextServiceError | None = None
    exhausted = False
    for index, (selection_source, candidate) in enumerate(candidates):
        if index > 0 and not budget.allows_another():
            exhausted = True
            break
        provider = wire_provider(candidate.model.provider)
        model = candidate.model.source_uri or candidate.model.slug
        if not provider or not model:
            continue

        # TASK-890 §3.2 — an unresolved, undefaulted placeholder is a NAMED failure of the
        # prompt, not of the provider, so it degrades the step immediately instead of walking
        # the fallback chain: every candidate renders the SAME template against the SAME scope,
        # so a switch would re-raise identically while billing nothing but latency.
        try:
            system_prompt = _system_prompt(candidate, config, run_context)
        except PromptVariableUnresolved as exc:
            await record_and_flush(
                payload,
                status=STATUS_DEGRADED,
                started=started,
                error_code="prompt_variable_unresolved",
            )
            return NodeActivityResult(
                status="DEGRADED",
                reason=f"core.agent: prompt_variable_unresolved: {exc}",
            )
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

        generation = _generation_params(candidate, config)
        parameters = candidate.parameters if isinstance(candidate.parameters, dict) else {}
        response_format = parameters.get("responseFormat")
        response_schema = parameters.get("responseSchema")
        wire_format: dict[str, Any] | None = None
        if response_format == "json_schema" and isinstance(response_schema, dict):
            wire_format = {"type": "json_schema", "json_schema": response_schema}
        elif response_format == "json":
            # F13 — `apps/text` declares its OWN vocabulary
            # (`ResponseFormat.type: Literal["text","json","json_schema"]`), so the OpenAI
            # spelling `json_object` was a 422 at the wire model before any provider was
            # reached. The gateway's contract is the one to speak here.
            wire_format = {"type": "json"}

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
                guardrail_policy={"enabled": guardrail_decision.enabled},
            )
        except TextServiceError as exc:
            # A provider outage: switch to the next resolved candidate (a DIFFERENT engine —
            # the after-send guard protects the SAME call from being re-issued, not the chain).
            last_error = exc
            continue

        output: dict[str, Any] = {
            "text": result.content,
            "provider": result.provider or provider,
            "model": result.model or model,
            "usage": result.usage,
            "agent": {"slug": candidate.slug, "versionNumber": candidate.version_number},
            "selectionSource": selection_source,
            "fundingTier": candidate.funding_tier,
            # §3.14 record (c): the step result says whether this generation was screened and
            # WHICH level decided, so a trajectory answers the question without re-deriving it.
            "guardrail": {
                "enabled": guardrail_decision.enabled,
                "source": guardrail_decision.source,
            },
        }
        if wire_format is not None:
            try:
                output["data"] = json.loads(result.content)
            except (TypeError, ValueError):
                output["data"] = None
        # F14 — the LLM_CALL step this generation is BILLED from. Before it, every
        # interpreter node persisted `stats = null` and the gateway's co-emission hook
        # (`buildHarnessUsageEvent`) had nothing to bill: a real generation, zero ledger rows.
        await record_generation_and_flush(
            payload,
            started=started,
            stats=_generation_stats(
                result,
                provider=provider,
                model=model,
                funding_tier=candidate.funding_tier,
                guardrail=guardrail_decision,
            ),
        )
        return NodeActivityResult(status="SUCCEEDED", output=output)

    if exhausted:
        # DEGRADED, never a raise: raising is what makes Temporal retry the activity from the
        # primary, which is exactly the double-spend this guard exists to prevent.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="text_budget_exhausted"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=(
                "core.agent: activity budget exhausted before the next fallback candidate could "
                f"be started (last error: {last_error})"
            ),
        )
    await record_and_flush(
        payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
    )
    return NodeActivityResult(
        status="DEGRADED",
        reason=f"core.agent: text generate failed on every resolved candidate: {last_error}",
    )


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
        # TASK-876: the fallback chain rides on the resolve answer — read, never resolved here.
        return await _run_text_generation(
            payload,
            resolved,
            started,
            fallback=read_text_fallback(raw),
            primary=read_text_primary(raw),
        )
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
    raw_action = config.get("action")
    action_config: dict[str, Any] = raw_action if isinstance(raw_action, dict) else {}
    # The runtime knobs travel with the action; `enabled` was already honoured by the walk.
    merged = {**action_config}
    for knob in ("timeoutSeconds", "retry", "onError"):
        if knob in config and knob not in merged:
            merged[knob] = config[knob]
    delegated = payload.model_copy(update={"node_type": spec.key, "config": merged})
    result: NodeActivityResult = await spec.activity(delegated)
    return result


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
CORE_ACTIVITIES: list[Callable[..., Any]] = [
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
