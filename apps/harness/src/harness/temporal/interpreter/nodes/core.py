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
from collections.abc import Callable
from time import perf_counter
from typing import TYPE_CHECKING, Any

import jsonschema
import structlog
from pydantic import ValidationError
from temporalio import activity

from harness.core.config import Settings, get_settings
from harness.core.llm_egress import egress_counts, known_phi_from, provider_locality
from harness.services import composed_prompt_recorder
from harness.services.api_client import ApiClientError, ApiServiceError
from harness.services.guardrail_client import GuardrailClient
from harness.services.nlp_client import NlpServiceError
from harness.services.note_plan.executor import (
    REPAIR_STEP_OFFSET,
    NoteCallRequest,
    NoteCallResult,
    NotePlanCallFailed,
    NotePlanEmptyNote,
    call_step_offset,
    execute_plan,
    note_run_stats,
    stop_reason_of,
    summed_usage,
)
from harness.services.note_plan.fallback import PlanAttempt, plan_attempts, walk_attempts
from harness.services.note_plan.models import NotePlanRef
from harness.services.system_governance import (
    GovernanceVerifier,
    PolicyVersionProbe,
    build_system_governance,
)
from harness.services.text_client import (
    TextGuardrailBlocked,
    TextServiceError,
    usage_detail_counters,
)
from harness.temporal.activities import (
    STEP_NODE,
    FailedAttempt,
    _api_client,
    _config_snapshot,
    _nlp_client,
    _text_client,
    failed_attempt_stats,
    record_note_plan_steps,
)
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # the one emitter — noqa: SLF001
)
from harness.temporal.claim_check import load_blob, open_store, should_offload, store_blob
from harness.temporal.interpreter.compose_messages import (
    ComposedMessages,
    compose_messages,
    platform_rules,
)
from harness.temporal.interpreter.data_contract import outputs_view
from harness.temporal.interpreter.expressions import evaluate_condition, evaluate_expression
from harness.temporal.interpreter.guardrail_hold import hold_notice, run_notices
from harness.temporal.interpreter.models import (
    RESERVED_RUN_IDENTITY_KEYS,
    EvaluateExpressionInput,
    EvaluateExpressionResult,
    GuardrailHold,
    NodeActivityInput,
    NodeActivityResult,
    ResolvedAgent,
    ResolvedClassificationModel,
)
from harness.temporal.interpreter.nodes import agent_version_cache
from harness.temporal.interpreter.nodes._consultation_shared import run_identity
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
from harness.temporal.interpreter.output_language import (
    OutputLanguage,
    output_language_policy_selected,
    resolve_platform_output_language,
)
from harness.temporal.interpreter.prompt_composition import (
    ComposedPrompt,
    PromptCompositionEmpty,
    build_prompt_scope,
    resolved_prompt_variable_declarations,
)
from harness.temporal.interpreter.templating import PromptVariableUnresolved, render_template

if TYPE_CHECKING:
    from harness.temporal.models import TrajectoryContext

_LOGGER = structlog.get_logger(__name__)


class ContextSchemaViolation(RuntimeError):
    """TASK-1038 R-5 — the run payload does not match the trigger's declared context schema.

    A NAMED type so the interpreter's retry policy can list it as non-retryable (Temporal matches
    on the failure type, i.e. this class name): the same payload is refused on every attempt.
    """


class OutputSchemaViolation(RuntimeError):
    """TASK-1038 R-5 — the run result does not match ``core.output``'s declared schema. Named
    for the same reason as :class:`ContextSchemaViolation`."""


def _config(payload: NodeActivityInput) -> dict[str, Any]:
    config = getattr(payload, "config", None)
    return config if isinstance(config, dict) else {}


#: TASK-1036 §9.1 — a `core.agent`'s NodeIO inputs whose value the agent arms read as `in`:
#: a text agent's `message`, a speech / entity agent's `text` (`bindings.legacyInputName`).
_AGENT_PRIMARY_INPUTS = ("message", "text")


def _bound(payload: NodeActivityInput) -> dict[str, Any]:
    bound = getattr(payload, "bound_inputs", None)
    if not isinstance(bound, dict):
        return {}
    if getattr(payload, "node_type", None) == "core.agent" and "in" not in bound:
        # A node bound by NodeIO name (compiled `bindings`) hands its primary text over as
        # `message` / `text`; the agent arms read the legacy port name. Same value, one place.
        for name in _AGENT_PRIMARY_INPUTS:
            if name in bound:
                return {**bound, "in": bound[name]}
    return bound


def _run_context(payload: NodeActivityInput) -> dict[str, Any]:
    """The run context `{trigger, vars, nodes}`. Under run protocol v2 (`nodeMeta` present) each
    `nodes.<id>` also serves its NodeIO `outputs` — the dual scope, one release (TASK-1036): a
    PROJECTION of the stored output built here, never a second copy carried in history."""
    context = getattr(payload, "run_context", None)
    if not isinstance(context, dict):
        return {}
    meta = context.get("nodeMeta")
    nodes = context.get("nodes")
    if not isinstance(meta, dict) or not isinstance(nodes, dict):
        return context
    served: dict[str, Any] = {}
    for node_id, output in nodes.items():
        raw_info = meta.get(node_id)
        info: dict[str, Any] = raw_info if isinstance(raw_info, dict) else {}
        if isinstance(output, dict) and "outputs" not in output:
            view = outputs_view(str(info.get("type") or ""), output, task=info.get("task"))
            served[node_id] = {**output, "outputs": view}
        else:
            served[node_id] = output
    return {**context, "nodes": served}


def _scope_context(payload: NodeActivityInput) -> dict[str, Any]:
    """The run context plus the v2 prompt roots (`consultation`, `run`) and the marker that turns
    on override rendering (TASK-1036). Byte-identical to `_run_context` off protocol v2."""
    context = _run_context(payload)
    if getattr(payload, "protocol", None) != 2:
        return context
    extra: dict[str, Any] = {_V2_SCOPE: True}
    if isinstance(payload.consultation, dict):
        extra["consultation"] = payload.consultation
    if isinstance(payload.run_fields, dict):
        extra["run"] = payload.run_fields
    return {**context, **extra}


#: Marks a scope context built under run protocol v2 (`_scope_context`).
_V2_SCOPE = "$hopeV2Scope"


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


#: TASK-1022 OD-1 (b) — the owner's LITERAL body for a template heading nothing was said under.
#: The finalizer's system prompt names the same string; the model is told never to paraphrase it.
_NOT_DISCUSSED_MARKER = "Not discussed"
#: The live lane's parser fallback (`document-shape-parser.ts#RUNNING_SUMMARY_TITLE`): an UNKNOWN
#: partition, not a section by that name — so it is rendered without a heading.
_RUNNING_SUMMARY_TITLE = "Running Summary"


def _headed_note(item: dict[str, Any]) -> str | None:
    """A ``sections``-carrying note as headed Markdown, or ``None`` when it carries no usable
    sections (the caller then reads ``text``, exactly as ``_texts`` does).

    Mirrors ``buildStructuredSummary`` (`document-shape-parser.ts`) for the parser fallback, and
    departs from it on purpose for empty sections: the owner chose a literal marker (OD-1 (b)) so
    the finalizer sees every heading and has nothing to invent a body for.
    """
    sections = [entry for entry in _as_list(item.get("sections")) if isinstance(entry, dict)]
    if not sections:
        return None
    parts = [
        (
            str(entry.get("title") or "").strip(),
            str(entry.get("content") or "").strip(),
        )
        for entry in sections
    ]
    if len(parts) == 1 and parts[0][0] in ("", _RUNNING_SUMMARY_TITLE):
        return parts[0][1] or None
    # No heading to show, or nothing said at all: the flat text is the honest rendering (and a
    # note made only of markers would hide a live lane that produced nothing).
    if not any(title for title, _ in parts) or not any(body for _, body in parts):
        return None
    rendered: list[str] = []
    for title, body in parts:
        if title:
            rendered.append(f"## {title}\n{body or _NOT_DISCUSSED_MARKER}")
        elif body:
            rendered.append(body)
    return "\n\n".join(rendered)


def _render_input_for_generation(value: Any) -> list[str]:
    """TASK-1022 — the ``in`` port of a text-generation ``core.agent``, as user-turn parts.

    A note carrying ``sections`` (the live summary node's ``{ text, sections, … }``) renders as
    ``## <title>\\n<content>`` per section, in list order — the live lane emits template order.
    Every other item renders exactly as :func:`_texts` renders it, so non-note inputs are
    byte-identical to before. ``text`` itself is never altered: it is the NER offset base, and
    ``_texts``'s other callers (classify, speech, NER) keep reading it.

    Pure and deterministic — the same bound value always yields the same bytes (prompt caching,
    and an activity that is safe to retry).
    """
    out: list[str] = []
    for item in _as_list(value):
        if isinstance(item, dict):
            headed = _headed_note(item)
            if headed:
                out.append(headed)
                continue
        out.extend(_texts([item]))
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


def _authored_context(run_payload: dict[str, Any]) -> dict[str, Any]:
    """``run_payload`` minus the gateway-owned RUN ENVELOPE — what an AUTHOR actually supplied.

    TASK-930 D-2. A context schema describes the context an author declares, and it closes
    (``additionalProperties: false``) so an undeclared kind is a caller error rather than
    something to pass through silently. The five ``RESERVED_RUN_IDENTITY_KEYS`` are not that:
    they are the server's own envelope, and validating them against an author's schema killed the
    entire clinical plane — every consultation-plane run failed on the first node in ~230 ms with
    ``('consultationId', 'externalPatientId', 'userId' were unexpected)``, reproduced with an
    empty caller payload.

    Exempting them costs the check NOTHING, and that is the whole argument for doing it here
    rather than loosening the schema: a caller CANNOT put those keys in a payload. The gateway
    refuses an invocation that names one (``exposure-palette-policy.ts#reservedIdentityKeysIn``
    -> 400), and ``sanitize_run_payload`` strips them unconditionally before re-stamping the
    server-resolved :class:`RunSubject`. So every occurrence in ``run_payload`` is, by
    construction, the platform's own — there is no author-supplied value being waved through, and
    ``additionalProperties: false`` stays exactly as sharp as its author meant it for everything
    they could actually send.

    Only the VALIDATED object narrows. The published ``context`` is still the full payload, so the
    thirteen ``run_identity(...)`` readers and any ``trigger.context.*`` binding are untouched.
    """
    return {
        key: value for key, value in run_payload.items() if key not in RESERVED_RUN_IDENTITY_KEYS
    }


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
    violation = _schema_violation(declared, _authored_context(context))
    await _admin_event(
        payload,
        "input.validated",
        {"valid": violation is None, "problems": [] if violation is None else [violation]},
        "input-validated",
        node_scoped=False,
    )
    if violation is not None:
        await record_and_flush(payload, status=STATUS_ERROR, started=started)
        raise ContextSchemaViolation(
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


def _agent_variables(resolved: ResolvedAgent, config: dict[str, Any]) -> dict[str, Any]:
    """The agent's own ``instruction.variables``, overlaid by the node's
    ``overrides.promptVariables`` (node wins)."""
    instruction = resolved.instruction if isinstance(resolved.instruction, dict) else {}
    variables: dict[str, Any] = {}
    declared = instruction.get("variables")
    if isinstance(declared, dict):
        variables.update(declared)
    overrides = config.get("overrides")
    if isinstance(overrides, dict) and isinstance(overrides.get("promptVariables"), dict):
        variables.update(overrides["promptVariables"])
    return variables


def _agent_prompt_scope(
    resolved: ResolvedAgent, config: dict[str, Any], run_context: dict[str, Any]
) -> dict[str, Any]:
    """The render scope of §3.3 — ``build_prompt_scope``, the ONE scope every lane shares.

    Roots: the run env's ``trigger`` / ``vars`` / ``nodes``, plus ``context``. On this lane
    ``trigger`` is the run payload verbatim and ``context`` its CONTEXT VIEW — unwrapped through
    ``_unwrap_single_kind_context`` when the agent's frozen schema declares a single kind keyed
    ``context`` (J3-5) — so both are supplied and ``build_prompt_scope`` keeps them as given. With
    no trigger published neither root is bound: "this run has no trigger" and "this field does
    not exist" are different findings for the author.

    The bare names come from :func:`_agent_variables`; each is a ``{"value"}`` literal, a
    ``{"path"}`` reference resolved against the roots (an unresolved one raises
    ``PromptVariableUnresolved`` naming the path), or a plain value. They are bound AFTER the
    roots, so an agent that declares a variable called ``context`` still wins its own name.
    """
    trigger = run_context.get("trigger")
    trigger_view = trigger if isinstance(trigger, dict) else None
    context_view: dict[str, Any] | None = None
    if trigger_view is not None:
        unwrapped = _unwrap_single_kind_context(_bound_context_payload_schema(resolved), trigger)
        context_view = unwrapped if isinstance(unwrapped, dict) else trigger_view
    vars_root = run_context.get("vars")
    nodes_root = run_context.get("nodes")
    variables = _agent_variables(resolved, config)
    vars_view = vars_root if isinstance(vars_root, dict) else None
    nodes_view = nodes_root if isinstance(nodes_root, dict) else None
    if run_context.get(_V2_SCOPE) is not True:
        return build_prompt_scope(
            variables=variables,
            trigger=trigger_view,
            context=context_view,
            vars=vars_view,
            nodes=nodes_view,
        )
    # TASK-1036 (lane B1) — under run protocol v2 the scope also carries the `consultation` and
    # `run` roots, and an `overrides.promptVariables` string containing `{{…}}` is RENDERED
    # against the run scope (it used to be bound LITERALLY: `{{nodes.x.text}}` reached the model
    # as those characters). An unresolved, undefaulted path raises `PromptVariableUnresolved`
    # naming it, exactly like the instruction's own placeholders.
    extra_roots = {
        name: run_context[name]
        for name in ("consultation", "run")
        if isinstance(run_context.get(name), dict)
    }
    base = {
        **build_prompt_scope(
            trigger=trigger_view, context=context_view, vars=vars_view, nodes=nodes_view
        ),
        **extra_roots,
    }
    overrides = config.get("overrides")
    prompt_variables = overrides.get("promptVariables") if isinstance(overrides, dict) else None
    for key, value in (prompt_variables or {}).items():
        if isinstance(value, str) and "{{" in value:
            variables[key] = render_template(
                value, base, template_ref=f"overrides.promptVariables.{key}"
            )
    scope = build_prompt_scope(
        variables=variables,
        trigger=trigger_view,
        context=context_view,
        vars=vars_view,
        nodes=nodes_view,
        # TASK-1036 OD-10 (lane B6b) — the frozen template declarations: an absent OPTIONAL
        # variable renders "" (or its default); a required one still fails by name.
        variable_declarations=resolved_prompt_variable_declarations(resolved.resolved_prompt),
    )
    for name, root in extra_roots.items():
        scope.setdefault(name, root)
    return scope


def _agent_resolved_prompt(resolved: ResolvedAgent) -> Any | None:
    """The instruction ``compose_messages`` renders, or ``None`` when the agent carries none.

    TASK-947 §4.1 — a COMPOSITE instruction is passed as resolved, because its ``content`` is the
    static projection (OD-3): reading it would silently drop every conditional fragment.
    Otherwise the first non-empty body wins, as one inline instruction: the gateway-resolved
    prompt (TASK-863 resolves a pinned template version, or the inline prompt, once,
    gateway-side), then the raw instruction fields, then the compiled ones.
    """
    if resolved.resolved_prompt is not None and resolved.resolved_prompt.source == "composite":
        return resolved.resolved_prompt
    instruction = resolved.instruction if isinstance(resolved.instruction, dict) else {}
    compiled = resolved.compiled_config if isinstance(resolved.compiled_config, dict) else {}
    template = next(
        (
            value
            for value in (
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
    return None if template is None else {"source": "inline", "content": template}


def _compose_agent_messages(
    resolved: ResolvedAgent,
    config: dict[str, Any],
    run_context: dict[str, Any],
    *,
    data_blocks: list[dict[str, Any]] | None = None,
    output_language: OutputLanguage | None = None,
    rules: str | None = None,
) -> tuple[ComposedMessages, bool]:
    """The agent's request, composed by ``compose_messages`` — ``(messages, policy_selected)``.

    SYSTEM = ``platform_rules()`` → the composed instruction → the output-language step. There is
    no output-contract layer on this lane: the declared ``outputSchema`` travels as
    ``response_format``. USER = ``data_blocks``, wrapped, in the given order.

    TASK-1001 (OD-12) — the language step is decided per CANDIDATE, because a fallback carries
    its own instruction: a SELECTED tenant ``output_language_policy`` fragment owns the language
    (no step); otherwise ``output_language`` — the platform default — is stated by name. Which
    fragments are selected is known only once the instruction is composed, so the composition
    runs once to learn it and once more with the step; both passes are pure.

    Raises ``PromptVariableUnresolved`` (EVERY missing path of the selected instruction, or the
    one path of an unresolved ``{"path"}`` binding) and ``PromptCompositionEmpty`` (OD-6); the
    caller degrades the step on either.
    """
    kwargs: dict[str, Any] = {
        "platform_rules": platform_rules() if rules is None else rules,
        "resolved_prompt": _agent_resolved_prompt(resolved),
        "scope": _agent_prompt_scope(resolved, config, run_context),
        "data_blocks": data_blocks,
        "template_ref": f"agent:{resolved.slug}",
    }
    if run_context.get(_V2_SCOPE) is True:
        # TASK-1036 OD-10 — under run protocol v2 a whitespace-only data block is dropped too.
        kwargs["drop_empty_blocks"] = True
    composed = compose_messages(**kwargs)
    policy_selected = output_language_policy_selected(composed.selected)
    if policy_selected or output_language is None:
        return composed, policy_selected
    return compose_messages(**kwargs, output_language={"name": output_language.name}), False


def _guardrail_client(settings: Settings) -> GuardrailClient:
    return GuardrailClient(
        settings.guardrail_base_url,
        service_token=settings.peer_service_token(),
        timeout=settings.guardrail_timeout_s,
    )


async def _system_governance(
    composed: ComposedMessages,
    agent: ResolvedAgent,
    probe: PolicyVersionProbe,
    verifier: GovernanceVerifier,
) -> dict[str, Any] | None:
    """TASK-1047 FC-6 — the ``system_governance`` this call may send, or ``None``.

    The guardrail version is fetched (once per walk, via ``probe``) only when the composer
    reported governance AND the agent carries a stamp — nothing is fetched otherwise.
    """
    composed_governance = getattr(composed, "governance", None)
    if not composed_governance:
        return None
    stamp = (agent.compiled_config or {}).get("governance")
    if not isinstance(stamp, dict):
        # TASK-1047 V7 — seeded / pre-TASK-1047 agents carry no publish stamp. The registry, asked
        # through the gateway, already vouches for EVERY piece under its current policy version
        # (exactly what the gateway's own composers rely on), so it decides alone.
        return await _registry_governance(composed_governance, verifier)
    version = await probe.get()
    governance = build_system_governance(composed_governance, stamp, version)
    if governance is None:
        return None
    # The stamp covers only instruction pieces; the platform-owned ones (and the whole set, under
    # the policy version in force) are confirmed by the gateway — once per activity and digest set.
    governed, verified_version = await verifier.verify(composed_governance)
    if not governed or verified_version != governance["policy_version"]:
        return None
    return governance


async def _registry_governance(
    composed_governance: Any, verifier: GovernanceVerifier
) -> dict[str, Any] | None:
    """The FC-4 body when the gateway's registry vouches for every piece, else ``None``."""
    pieces = composed_governance.get("pieces")
    composed_digest = composed_governance.get("composed_digest")
    if not isinstance(pieces, list) or not pieces or not composed_digest:
        return None
    governed, verified_version = await verifier.verify(composed_governance)
    if not governed or not verified_version:
        return None
    return {
        "composed_digest": composed_digest,
        "pieces": [dict(p) for p in pieces],
        "policy_version": verified_version,
    }


def _compose_system_prompt(
    resolved: ResolvedAgent, config: dict[str, Any], context: dict[str, Any]
) -> ComposedPrompt:
    """The agent's INSTRUCTION alone — the same composition without the platform rules, the
    language step or any data — and which fragments composed it. Pure."""
    composed, _ = _compose_agent_messages(resolved, config, context, rules="")
    return ComposedPrompt(
        prompt=composed.system or None, selected=composed.selected, excluded=composed.excluded
    )


def _system_prompt(
    resolved: ResolvedAgent, config: dict[str, Any], context: dict[str, Any]
) -> str | None:
    """Just the prompt — for every caller that has no use for which fragments composed it."""
    return _compose_system_prompt(resolved, config, context).prompt


async def _output_language_snapshot() -> Any | None:
    """TASK-1001 (OD-12) — the control-plane snapshot the platform-default NOTE OUTPUT LANGUAGE
    (``consultation.summary.outputLanguage``) is read from, or ``None`` when it cannot be read.

    I/O, so it is called from the ``interpreter.core_agent`` ACTIVITY only — never from workflow
    code. It is the service's ONE effective-config client (TTL + jitter, negative cache,
    single-flight, push invalidation on ``arca:config:invalidate``), so a platform admin's write
    reaches the next durable generation without a redeploy. Never raises: ``_config_snapshot``
    degrades every failure to ``None``, which ``resolve_platform_output_language`` reads as the
    code default, English.

    A seam: the hermetic suite replaces it (``tests/conftest.py``) with "no control plane".
    """
    return await _config_snapshot()


#: OD-E's closed `trigger` vocabulary, mirrored from
#: `packages/applications/src/services/usageLedger/usage-attributes.ts` (`USAGE_TRIGGERS`). A
#: value outside that list is dropped by the ledger's attribute allow-list, so the two spellings
#: have to stay in step; every generation on this lane is caused by one product activity.
USAGE_TRIGGER_WORKFLOW_RUN = "WORKFLOW_RUN"

#: The screening disposition the same file declares (`GUARDRAIL_DISPOSITIONS`). TASK-1035 OD-1
#: removed every guardrail opt-out, so a generation on this lane is always `screened`.
GUARDRAIL_DISPOSITION_SCREENED = "screened"


def _generation_stats(
    result: Any,
    *,
    provider: str,
    model: str,
    funding_tier: str | None,
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
    * ``guardrail`` — always ``screened``: TASK-1035 OD-1 removed the tenant / agent / workflow /
      node opt-outs, and the platform kill switch went with them (OD-4).

    TASK-1035 §5.0 — ``egress`` is Text's egress report for the call that served, copied as
    COUNTS only (``harness.core.llm_egress.egress_counts``) and only when Text sent one.
    """
    stats: dict[str, Any] = dict(getattr(result, "stats", None) or {})
    if not stats.get("provider"):
        stats["provider"] = getattr(result, "provider", None) or provider
    if not stats.get("model"):
        stats["model"] = getattr(result, "model", None) or model
    stats["trigger"] = USAGE_TRIGGER_WORKFLOW_RUN
    if funding_tier:
        stats["funding_tier"] = funding_tier
    stats["guardrail"] = GUARDRAIL_DISPOSITION_SCREENED
    egress = egress_counts(getattr(result, "egress", None))
    if egress is not None:
        stats["egress"] = egress
    # TASK-957 F-6 / TASK-959 §10.2 — the counts AD-1 `GenerationStats` cannot express. Text
    # returns them on the SAME response, in `usage_detail`; the mapper zeroed cache-read,
    # cache-write and reasoning because nothing ever put them on the step, so reasoning-model
    # spend inside a workflow was structurally unbillable. Copied only when present — an absent
    # count stays absent rather than becoming a zero the rater would price.
    stats.update(usage_detail_counters(getattr(result, "usage_detail", None)))
    # TASK-1050 (README §9.8.2) — the guardrail evaluations of THIS call, so the reconciler can
    # find a generation whose evaluation row never arrived. Ids only; absent when none.
    evaluation_ids = getattr(result, "guardrail_evaluation_ids", None)
    if isinstance(evaluation_ids, list) and evaluation_ids:
        stats["guardrail_evaluation_ids"] = list(evaluation_ids)
    return stats


# ---------------------------------------------------------------------------------------------
# TASK-1050 W2f — guardrail correlation, notices and the hold, for every text generation here.
# ---------------------------------------------------------------------------------------------

#: The trajectory step offset of a `core.agent`'s billed LLM_CALL (`record_generation_and_flush`).
_LLM_CALL_STEP_OFFSET = 1


def _temporal_identity() -> tuple[str, str] | None:
    """``(workflow_id, workflow_run_id)`` of the running activity, or ``None`` outside one."""
    if not activity.in_activity():
        return None
    info = activity.info()
    return str(info.workflow_id), str(info.workflow_run_id)


def _guardrail_correlation(payload: NodeActivityInput, *, step_offset: int) -> dict[str, str]:
    """What a guardrail evaluation of this node's call is correlated by (README §9.8.2).

    ``runKey`` is the ``AiActivityRun.runKey`` of the trajectory step the call is recorded on —
    ``trajectory:<sessionId>:<runId>:<seq>`` (``activity-run.mapper.ts``), the Temporal workflow /
    run ids and the step's own seq. Only what is known is sent.
    """
    correlation: dict[str, str] = {}
    if payload.run_id:
        correlation["runId"] = payload.run_id
    correlation["nodeId"] = payload.node_id
    consultation_id = run_identity(payload.run_payload).consultation_id
    if consultation_id:
        correlation["consultationId"] = consultation_id
    identity = _temporal_identity()
    if identity is not None and payload.trajectory is not None:
        workflow_id, workflow_run_id = identity
        correlation["runKey"] = (
            f"trajectory:{workflow_id}:{workflow_run_id}:{payload.trajectory.seq + step_offset}"
        )
    return correlation


def _notice_scope(payload: NodeActivityInput) -> dict[str, str | None]:
    return {
        "run_id": payload.run_id or None,
        "node_id": payload.node_id,
        "consultation_id": run_identity(payload.run_payload).consultation_id,
    }


async def _emit_guardrail_notices(payload: NodeActivityInput, raw: Any) -> list[dict[str, Any]]:
    """The conforming warn / unverified notices of a generation, each emitted as a PUBLIC
    ``guardrail.notice`` (run protocol v2; best-effort) and returned for the activity result."""
    notices = run_notices(raw if isinstance(raw, list) else [], **_notice_scope(payload))
    for notice in notices:
        await _admin_event(payload, "guardrail.notice", notice, f"notice:{notice['noticeId']}")
    return notices


async def _guardrail_hold_result(
    payload: NodeActivityInput,
    started: Any,
    refused: TextGuardrailBlocked,
    *,
    failed_attempts: list[FailedAttempt] | None = None,
) -> NodeActivityResult:
    """A generation guardrail REFUSED (a block, or the cloud pseudonymiser being down).

    DEGRADED with a ``guardrail_hold``: the walk pauses the run at this node and re-executes it
    once the hold is resolved (``task-1050-guardrail-hold``). Never a raise — Temporal would retry
    the same refused call — and never a walk to the next candidate: a block is a policy verdict
    the next model is screened against too, and a privacy outage is not the model's fault. The
    consultation is NOT told the note failed: the hold is resumable.
    """
    code = (
        "egress_redaction_unavailable"
        if refused.kind == "redaction_unavailable"
        else "guardrail_blocked"
    )
    await record_and_flush(
        payload,
        status=STATUS_DEGRADED,
        started=started,
        error_code=code,
        stats=(
            {"guardrail_evaluation_ids": list(refused.evaluation_ids)}
            if refused.evaluation_ids
            else None
        ),
        failed_attempts=failed_attempts or None,
    )
    notice = hold_notice(refused.kind, refused.notice, **_notice_scope(payload))
    return NodeActivityResult(
        status="DEGRADED",
        reason=f"GUARDRAIL_BLOCKED: core.agent: {code} (notice {notice['noticeId']})",
        guardrail_hold=GuardrailHold(
            kind="redaction_unavailable" if refused.kind == "redaction_unavailable" else "blocked",
            notice=notice,
            evaluation_ids=list(refused.evaluation_ids),
            error_code=refused.error_code,
        ),
    )


# ---------------------------------------------------------------------------------------------
# TASK-932 R-16a — the FINALIZED note becomes the consultation's own note.
# ---------------------------------------------------------------------------------------------

#: The execution cadence that means "once, at the close of the session" (`node-config-schemas.ts`
#: `NODE_EXECUTION_CADENCES`). It is the ONLY cadence that carries a durable-lane consequence: a
#: `core.agent` declaring it, inside a consultation-bound run, IS that consultation's finalizer.
_CADENCE_ON_END = "onEnd"


def _execution(config: dict[str, Any]) -> dict[str, Any]:
    execution = config.get("execution")
    return execution if isinstance(execution, dict) else {}


#: The live lane's running note is `perTurn`; anything else on this lane is a plain workflow step.
_CADENCE_PER_TURN = "perTurn"


def _record_phase(config: dict[str, Any]) -> str:
    """OD-9 — the ``phase`` a composed-prompt record carries, from the node's declared cadence:
    ``onEnd`` is the note (``finalize``), ``perTurn`` the running note (``live``), and any other
    step is ``workflow``."""
    cadence = _execution(config).get("cadence")
    if cadence == _CADENCE_ON_END:
        return "finalize"
    if cadence == _CADENCE_PER_TURN:
        return "live"
    return "workflow"


def _is_consultation_finalizer(payload: NodeActivityInput, config: dict[str, Any]) -> bool:
    """Whether THIS node is the consultation's end-of-session note (pure).

    Three conditions, and each removes a different way of getting this wrong:

    * a CONSULTATION-bound run — an exposure-plane invocation has no clinical record to write to,
      and a graph declaring ``kinds: ['consultation','api']`` runs on both;
    * ``execution.cadence: onEnd`` — the graph author's own declaration that this step runs once
      at the close. `perTurn` is the live lane's running note (already persisted by the live
      executor as ``LIVE_SOAP_SNAPSHOT``), `onStart` is the warm start, `once` is a plain
      one-shot generation. Only `onEnd` means "this is the note";
    * not SANDBOX — a Workbench run must never write a clinical record. `core.agent` is
      ``external_write=False`` on the TYPE (an LLM agent has to be runnable in a sandbox), so the
      suppression is made HERE, exactly as ``_run_speech`` already makes it for a TTS artifact.
    """
    if payload.sandbox:
        return False
    if _execution(config).get("cadence") != _CADENCE_ON_END:
        return False
    return bool(run_identity(payload.run_payload).consultation_id)


def _finalized_note(output: dict[str, Any]) -> str | None:
    """The clinician-facing note out of a finalizer's answer (pure).

    The seeded ``casenote-finalization`` agent declares
    ``outputSchema: {case_note, redactions}``, which TASK-930 §5 turns into the response format,
    so the parsed ``data`` is the honest source. ``text`` is the fallback for an agent that
    declares no schema — but NEVER when ``data`` parsed, because then ``text`` is the raw JSON
    document and persisting it would put a serialized object in front of a clinician.
    """
    data = output.get("data")
    if isinstance(data, dict):
        case_note = data.get("case_note")
        return case_note.strip() or None if isinstance(case_note, str) else None
    text = output.get("text")
    return text.strip() or None if isinstance(text, str) else None


def _redaction_audit(output: dict[str, Any]) -> tuple[bool | None, dict[str, Any] | None]:
    """The redaction MARKER and its audit manifest (pure), or ``(None, None)``.

    **The manifest never carries removed PHI.** A finalizer reports each redaction as
    ``{text, label}`` where ``text`` is the identifier it replaced — so only the LABELS and their
    COUNTS travel, which is exactly what ``SummaryMeta.redactionManifest`` is documented to hold
    ("rule ids, actions, spans and counts — NEVER removed PHI plaintext"). Copying the list
    through would move patient identifiers into a second column for no diagnostic gain.

    ``(None, None)`` when the agent declared no redaction contract at all — absent is not
    ``redactionApplied: false``, which would assert that a transform ran and changed nothing.
    """
    data = output.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("redactions"), list):
        return None, None
    counts: dict[str, int] = {}
    for entry in data["redactions"]:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        key = label if isinstance(label, str) and label else "UNLABELLED"
        counts[key] = counts.get(key, 0) + 1
    total = sum(counts.values())
    return bool(total), {"source": "core.agent", "labelCounts": counts, "total": total}


#: OD-6 — a redaction that could not be confirmed leaves the note FLAGGED, never silent. The
#: mechanism is the legacy gate's own (`workflows.py`: `decision = str(GateDecision.FLAG)` when
#: `redaction_failed_closed`), so a clinician sees the same marker whichever lane produced it.
_REDACTION_UNCONFIRMED = "the redaction engine could not confirm the transform"


def _redaction_rules(trigger: Any) -> tuple[list[Any] | None, str | None]:
    """The doctor's DNA redaction rules off the LIVE HANDOFF context (pure).

    Three outcomes, and they are clinically different:

    * ``(None, None)`` — nothing configured. Not a failure: the doctor asked for no transform,
      so the finalizer's self-reported audit stays the provenance.
    * ``(rules, None)`` — a usable set; the deterministic engine runs.
    * ``(None, reason)`` — rules ARE configured but this lane cannot build them. Something was
      meant to be removed and will not be, which is the same clinical situation as an engine
      that could not run, so OD-6 applies rather than a silent fall-through to the audit. The
      reason NAMES the offending rule ids (never the pydantic message — see below), because
      OD-6 turns it into a forced clinical review someone has to be able to act on.

    The cross-field rule that most often rejects a set the GATEWAY accepted is ``RedactionRule``'s
    own: ``type: "rewrite"`` with ``match: "literal"|"regex"`` and no ``replacement``.
    ``validateRedactionRuleSet`` checks the two closed vocabularies but not that pair.

    The gateway holds the set as ``{ rules: [...] }`` (``RedactionRuleSet``); both that and the
    bare list are accepted, because they are the same object with and without its envelope.
    """
    from pydantic import ValidationError  # noqa: PLC0415

    from harness.redaction.engine import RedactionRule  # noqa: PLC0415

    raw = trigger.get("dna_redaction_rules") if isinstance(trigger, dict) else None
    if isinstance(raw, dict):
        raw = raw.get("rules")
    if raw is None or (isinstance(raw, list) and not raw):
        return None, None
    if not isinstance(raw, list):
        return None, f"`dna_redaction_rules` is a {type(raw).__name__}, not a list of rules"
    parsed: list[Any] = []
    rejected: list[str] = []
    for index, rule in enumerate(raw):
        try:
            parsed.append(RedactionRule.model_validate(rule))
        except ValidationError:
            # The rule ID, and NEVER the pydantic message: that message echoes the offending
            # INPUT, and a rule's `pattern` is precisely the identifier the doctor asked to have
            # removed. The reason is published on `SummaryMeta.redactionManifest`, the one column
            # documented to carry no removed PHI plaintext. An ID is the doctor's own label.
            rule_id = rule.get("id") if isinstance(rule, dict) else None
            rejected.append(rule_id if isinstance(rule_id, str) and rule_id else f"#{index}")
    if rejected:
        # Named, because OD-6 turns this into a forced clinical review: a doctor has to be able
        # to see which of their own rules stopped the transform and fix it.
        return None, f"these configured redaction rules did not parse: {', '.join(rejected)}"
    return parsed, None


async def _deterministic_redaction(
    payload: NodeActivityInput,
    content: str,
    rules: list[Any],
    *,
    provider: str | None,
    model: str | None,
) -> tuple[str, bool | None, dict[str, Any], str | None]:
    """Run ``apply_redaction`` over the doctor's rules and report what it did.

    Returns ``(content, applied, manifest, failed_reason)`` — ``content`` MATERIALIZED, never a
    claim-check ref. ``apply_redaction`` empties the inline when its result crosses the offload
    threshold, and the two things that read this note next cannot follow a ref: the node output
    carries no ref field at all, and ``persist_draft`` is a direct call from here (no Temporal
    payload boundary between them), so it would resolve exactly the same blob one frame later.
    The un-redacted note of the same size is already inline in this activity's result, so
    materializing costs the history budget nothing it was not already paying.

    This is the SAME activity the legacy ``HarnessDocWorkflow`` runs, called the same way
    ``persist_draft`` already is from here — activity-to-activity, inside the node activity that
    holds the note. It therefore adds NO workflow command and needs no ``workflow.patched`` era:
    the workflow still sees one activity result.

    A partially-applied transform is KEPT even when the pass fails closed (the legacy path's
    ``if redaction.changed`` adoption), because a half-redacted note is strictly better than an
    unredacted one; the FLAG is what stops it being read as clean.

    ``response_format`` is NOT threaded, and that is a REAL difference from the legacy lane
    rather than an omission. There, the text handed to ``apply_redaction`` is the whole generated
    document, so the generation's own response format still describes it. Here the text is the
    bare ``case_note`` STRING pulled out of that document — it has no schema, so forcing the
    finalizer's ``{case_note, redactions}`` schema onto the semantic rewrite makes the model
    answer with a serialized object, which ``apply_redaction`` then adopts as the note (it
    parses as JSON, which is all its schema check asserts) and ``persist_draft`` writes in front
    of a clinician.
    """
    from harness.temporal.activities import apply_redaction  # noqa: PLC0415
    from harness.temporal.models import ApplyRedactionInput  # noqa: PLC0415

    try:
        redaction = await apply_redaction(
            ApplyRedactionInput(
                tenant_id=payload.tenant_id,
                note_text=content,
                rules=rules,
                response_format=None,
                provider=provider,
                model=model,
                trajectory=payload.trajectory,
            )
        )
        redacted = redaction.text
        if redaction.changed and redaction.text_ref is not None:
            store, _ = await open_store(get_settings().claim_check, redaction.text_ref)
            redacted = await load_blob(redaction.text_ref, store=store)
    except Exception as exc:  # noqa: BLE001 — any failure here is OD-6, never a lost note
        # A blob that cannot be read is the same clinical situation as an engine that could not
        # run: the transform is unconfirmable, so the ORIGINAL content is kept and flagged.
        return content, False, {}, f"{_REDACTION_UNCONFIRMED}: {exc}"

    manifest = redaction.manifest
    audit: dict[str, Any] = {
        "source": "deterministic",
        "applied": manifest.applied,
        "totalHits": manifest.total_hits,
        "hitsByRule": dict(manifest.hits_by_rule),
        "ruleIds": sorted(manifest.hits_by_rule.keys()),
        "failedClosed": redaction.failed_closed,
    }
    if redaction.changed:
        content = redacted
    return (
        content,
        manifest.applied,
        audit,
        _REDACTION_UNCONFIRMED if redaction.failed_closed else None,
    )


def _adopt_redacted_note(output: dict[str, Any], content: str) -> None:
    """Thread the (possibly redacted) note back onto the node output, in place.

    A transform that reaches only ``persist_draft`` leaves the identifiers the doctor asked to
    have removed travelling on the GRAPH: ``core.humanReview`` shows this output,
    ``core.output`` DELIVERS it (``nodes/deliver.py`` reads ``value["text"]``), and any
    downstream node binds it. The legacy lane adopts ``redaction.text`` into ``generated`` for
    exactly this reason (``workflows.py``).

    The write-back mirrors ``_finalized_note``'s own selection, so what is replaced is what was
    read: the parsed ``data.case_note`` when the agent declared an output contract — and then
    ``text``, which is that same document serialized, is re-emitted from it so the two copies
    cannot disagree — else ``text`` itself. A no-op when the note did not change.
    """
    data = output.get("data")
    if isinstance(data, dict) and isinstance(data.get("case_note"), str):
        if data["case_note"] == content:
            return
        data["case_note"] = content
        if isinstance(output.get("text"), str):
            output["text"] = json.dumps(data, ensure_ascii=False)
        return
    if isinstance(output.get("text"), str):
        output["text"] = content


async def _persist_finalized_note(
    payload: NodeActivityInput,
    candidate: ResolvedAgent,
    output: dict[str, Any],
    *,
    provider: str | None = None,
    model: str | None = None,
    coverage: dict[str, Any] | None = None,
    persisted: dict[str, Any] | None = None,
) -> str | None:
    """Write the finalized note onto the consultation. Returns a failure reason, or ``None``.

    ``coverage`` (a NotePlan execution's ``CoverageResultV1``) rides on the persist; when
    ``persisted`` is given it receives the written note's ``context_item_id`` and
    ``version_number`` for the run record.

    Reuses ``persist_draft`` — the SAME gateway write ``HarnessDocWorkflow`` has always used —
    so the note lands as a ``RAW_SUMMARY`` ``ContextItem`` with its ``SummaryMeta``
    (``dnaWritingStyleId``, ``redactionApplied``, the encrypted manifest, model/prompt
    provenance), the ``ai_draft_v1`` snapshot is captured, and the consultation advances to
    ``PENDING_REVIEW`` — which is precisely the state a graph's ``core.humanReview`` gate then
    waits in. One consultation still gets ONE harness draft: the gateway ADOPTS its own prior row
    rather than creating a second, and refuses to overwrite a clinician's edit.

    The DNA style id comes from the run context the LIVE HANDOFF published, never from the node's
    config: which style applied is a fact about the clinician whose consultation this is, and the
    gateway resolved it under the tenant AND doctor gate.

    KNOWN DIFFERENCE from the legacy lane, recorded rather than papered over: because the
    redaction runs activity-to-activity from inside this one, its result is NOT an event in the
    workflow history, so a retry of ``interpreter.core_agent`` re-runs the transform — where a
    retry of ``HarnessDocWorkflow`` replays the recorded ``apply_redaction`` result. The
    deterministic pass is pure, so re-running it is free; the optional SEMANTIC pass is a Text
    call, protected only by its idempotency key (stable across an activity's retry attempts) and
    whatever that key dedups against.
    """
    # Imported inside the function for the same reason `_run_transcription` does it.
    from harness.temporal.activities import persist_draft  # noqa: PLC0415
    from harness.temporal.models import PersistDraftInput  # noqa: PLC0415

    content = _finalized_note(output)
    if not content:
        return "the finalizer returned no `case_note` to persist"

    identity = run_identity(payload.run_payload)
    trigger = _run_context(payload).get("trigger")
    dna_style_id = trigger.get("dna_style_id") if isinstance(trigger, dict) else None

    # The redaction MARKER. `_redaction_audit` reports what the finalizer SAID it redacted —
    # the model's own account of its own output. That is provenance, not evidence, and it is
    # the only thing this lane had: `SummaryMeta.redactionApplied` read `false` on every
    # interpreter-persisted note because no deterministic pass ran here at all.
    #
    # When the doctor HAS configured DNA redaction rules, the real transform runs first and its
    # manifest replaces the self-report. When they have not, the self-report stays — absence of
    # rules is not a failed redaction.
    redaction_applied, redaction_manifest = _redaction_audit(output)
    gate_decision: str | None = None
    rules, failed_reason = _redaction_rules(trigger)
    if rules is not None:
        content, redaction_applied, redaction_manifest, failed_reason = (
            await _deterministic_redaction(
                payload,
                content,
                rules,
                provider=provider,
                model=model,
            )
        )
    elif failed_reason is not None:
        # Rules WERE configured and this lane could not build them, so no deterministic pass
        # ran — and a manifest must not report on one that did not. Carrying the finalizer's
        # own `labelCounts`/`total` under `source: "deterministic"` would label provenance as
        # evidence, which is the confusion the deterministic pass exists to end.
        redaction_applied, redaction_manifest = False, {}
    if failed_reason is not None:
        # OD-6 — persist, do NOT drop: an undocumented encounter is the worse clinical outcome,
        # and `n_review` already gates what lands here. The forced review flag is the legacy
        # gate's own `FLAG`, and the reason is named on the manifest so the review is
        # explainable rather than mysterious.
        from harness.sensors.aggregator import GateDecision  # noqa: PLC0415

        gate_decision = str(GateDecision.FLAG)
        redaction_manifest = {
            **(redaction_manifest or {}),
            "source": "deterministic",
            "failedClosed": True,
            "reason": failed_reason,
        }
        redaction_applied = bool(redaction_manifest.get("applied", False))

    # The transform must reach every reader of this node, not just the clinical record.
    _adopt_redacted_note(output, content)

    try:
        response = await persist_draft(
            PersistDraftInput(
                consultation_id=identity.consultation_id or "",
                tenant_id=payload.tenant_id,
                content=content,
                user_id=identity.user_id,
                job_id=identity.job_id,
                model_name=candidate.model.source_uri or candidate.model.slug,
                prompt_version=(
                    str(candidate.version_number) if candidate.version_number is not None else None
                ),
                dna_style_id=(
                    dna_style_id if isinstance(dna_style_id, str) and dna_style_id else None
                ),
                redaction_applied=redaction_applied,
                redaction_manifest=redaction_manifest,
                gate_decision=gate_decision,
                is_auto_generated=True,
                coverage=coverage,
            )
        )
    except ApiServiceError as exc:
        return f"the finalized note was not persisted: {exc}"
    if persisted is not None:
        persisted["context_item_id"] = getattr(response, "context_item_id", None)
        persisted["version_number"] = getattr(response, "version_number", None)
    return None


def _candidate_wire_format(
    candidate: ResolvedAgent, resolved: ResolvedAgent
) -> dict[str, Any] | None:
    """The ``response_format`` one candidate is called with (pure): its explicit
    ``responseFormat`` hyper-parameter, else the output contract it declared."""
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
    if wire_format is None and response_format is None:
        # TASK-930 §5 — the agent DECLARED an output contract and nobody set an explicit
        # hyper-parameter, so the declaration becomes the constraint. Until now
        # `outputSchema` was documentation on this lane: an agent could publish
        # `{ case_note, redactions }` and be handed prose, and its `core.output` node then
        # failed the very schema check the agent could have satisfied.
        #
        # TASK-1035 — per CANDIDATE: a fallback agent constrains to its OWN declared schema;
        # the primary's applies only when the candidate declares none. Sending the primary's
        # schema to every candidate forced a fallback agent into a contract it never wrote.
        wire_format = output_schema_response_format(
            candidate.slug,
            (
                candidate.output_schema
                if candidate.output_schema is not None
                else resolved.output_schema
            ),
            parameters,
        )
    return wire_format


def _primary_agent(resolved: ResolvedAgent, primary: TextFallbackCandidate | None) -> ResolvedAgent:
    """The PRIMARY candidate: the agent row plus the gateway-derived funding tier (and, when the
    answer shipped one, its deployment kind) from ``textPrimary``."""
    primary_agent = resolved
    if primary is not None:
        primary_agent = resolved.model_copy(update={"funding_tier": primary.funding_tier})
        if primary_agent.model.deployment_kind is None and primary.deployment_kind:
            primary_agent = primary_agent.model_copy(
                update={
                    "model": primary_agent.model.model_copy(
                        update={"deployment_kind": primary.deployment_kind}
                    )
                }
            )
    return primary_agent


#: The keys a live-handoff summary output names its NotePlan pointer under.
_NOTE_PLAN_REF_KEYS = ("note_plan_ref", "notePlanRef")


def _note_plan_ref(value: Any) -> NotePlanRef | None:
    """The first NotePlan pointer bound on ``in`` (a live-handoff summary output carries one),
    or ``None``. A pointer that is present but malformed raises ``ValueError``."""
    for item in _as_list(value):
        if not isinstance(item, dict):
            continue
        for key in _NOTE_PLAN_REF_KEYS:
            raw = item.get(key)
            if raw is None:
                continue
            try:
                return NotePlanRef.model_validate(raw)
            except ValidationError as exc:
                raise ValueError(
                    f"the bound `{key}` is malformed: {exc.error_count()} error(s)"
                ) from exc
    return None


#: The keys a live-handoff summary output names the composer's refusal code under.
_NOTE_PLAN_ERROR_KEYS = ("note_plan_error", "notePlanError")


def _note_plan_error(value: Any) -> str | None:
    """The first composer refusal code bound on ``in`` (a live handoff that could not compose the
    plan hands its note outputs over EMPTY with this code), or ``None``."""
    for item in _as_list(value):
        if not isinstance(item, dict):
            continue
        for key in _NOTE_PLAN_ERROR_KEYS:
            code = item.get(key)
            if isinstance(code, str) and code:
                return code
    return None


def _carries_note_plan(item: Any) -> bool:
    return isinstance(item, dict) and any(
        item.get(key) is not None for key in (*_NOTE_PLAN_REF_KEYS, *_NOTE_PLAN_ERROR_KEYS)
    )


def _handoff_note_source(bound_in: Any, run_context: dict[str, Any]) -> list[Any]:
    """Where the finalizer reads the handoff's plan pointer (or refusal code) from.

    ``in`` when it carries one; otherwise the run context's node outputs that do — the live
    handoff seeds each note node as ``{text: '', note_plan_ref | note_plan_error}`` and only the
    handoff writes those keys, so every such output names the same plan.
    """
    if any(_carries_note_plan(item) for item in _as_list(bound_in)):
        return _as_list(bound_in)
    nodes = run_context.get("nodes")
    if not isinstance(nodes, dict):
        return []
    return [output for output in nodes.values() if _carries_note_plan(output)]


#: The harness progress stage that marks a consultation's note as not written (apps/api
#: ``HARNESS_PROGRESS_FAILED_STAGE``).
_PROGRESS_FAILED_STAGE = "failed"


async def _report_finalizer_failure(payload: NodeActivityInput, code: str) -> None:
    """Tell apps/api the consultation finalizer wrote no note, naming why (best-effort).

    A degraded ``core.agent`` stores no output, so the graph's critical ``core.output`` then fails
    its schema and the RUN's code is ``OUTPUT_INVALID`` — which says nothing about the note. The
    ``failed`` progress stage marks a STOPPED consultation without a note FAILED by the note path
    (an earlier named reason is kept), before the run's own failure arrives. Never raises: the
    degrade is the node's outcome either way.
    """
    consultation_id = run_identity(payload.run_payload).consultation_id
    if not consultation_id:
        return
    try:
        await _api_client(get_settings()).report_progress(
            consultation_id,
            tenant_id=payload.tenant_id,
            stage=_PROGRESS_FAILED_STAGE,
            label=f"Note not written ({code})"[:256],
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, the degrade stands either way
        _LOGGER.warning(
            "core.agent.finalizer_failure_report_failed",
            node_id=payload.node_id,
            code=code,
            error=type(exc).__name__,
        )


async def _degrade_note_plan(
    payload: NodeActivityInput, started: Any, code: str, detail: str
) -> NodeActivityResult:
    await record_and_flush(payload, status=STATUS_DEGRADED, started=started, error_code=code)
    await _report_finalizer_failure(payload, code)
    return NodeActivityResult(status="DEGRADED", reason=f"core.agent: {code}: {detail}")


def _consultation_trajectory(
    payload: NodeActivityInput, consultation_id: str | None
) -> TrajectoryContext | None:
    """The node's trajectory context, naming the consultation its note belongs to.

    The interpreter keys a run by run id, so its context carries no consultation; the note's
    steps would then reach the run record unattributed to the consultation it was written for.
    """
    ctx = payload.trajectory
    if ctx is None or ctx.consultation_id or not consultation_id:
        return ctx
    return ctx.model_copy(update={"consultation_id": consultation_id})


def _workflow_run_stats(payload: NodeActivityInput) -> dict[str, Any]:
    """The workflow run a note step belongs to (ids and numbers only).

    The step's own run id is the Temporal run; ``workflow_run_id`` is the HOPE run the console
    links to. Slug and version are known only on run protocol v2 (``run.*``).
    """
    fields = payload.run_fields if isinstance(payload.run_fields, dict) else {}
    stats: dict[str, Any] = {}
    run_id = fields.get("id") or payload.run_id
    if isinstance(run_id, str) and run_id:
        stats["workflow_run_id"] = run_id
    slug = fields.get("workflowSlug")
    if isinstance(slug, str) and slug:
        stats["workflow_slug"] = slug
    version = fields.get("workflowVersion")
    if isinstance(version, int) and not isinstance(version, bool) and version > 0:
        stats["workflow_version"] = version
    return stats


def _summed_call_tokens(records: Any) -> dict[str, int]:
    """Prompt / generated tokens summed over the plan calls that answered (the note record)."""
    totals: dict[str, int] = {}
    for record in records:
        stats = record.result.stats if record.result is not None else None
        if not isinstance(stats, dict):
            continue
        for key in ("prompt_tokens", "predicted_tokens"):
            value = stats.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0) + value
    return totals


async def _run_note_plan_finalizer(
    payload: NodeActivityInput,
    resolved: ResolvedAgent,
    started: Any,
    ref: NotePlanRef,
    primary: TextFallbackCandidate | None,
    fallback: TextFallbackBlock | None = None,
) -> NodeActivityResult:
    """The consultation finalizer, driven by the NotePlan apps/api composed at the handoff.

    The plan's blocks are the input (wrapped as data, in plan order — one byte-identical prefix
    for every call); the SYSTEM prompt is still the agent's own composition (platform rules →
    instruction → output-language step), so the governed agent keeps owning how the note is
    written. Each plan call runs on the PLAN's model with the agent's generation parameters and
    output contract; the executor merges the sections, checks coverage and repairs once. The
    finalizer output keeps its ``{case_note, redactions, sources}`` shape, and ``case_note`` is
    persisted exactly as before (Copy to EMR reads it).

    Each call walks the agent's fallback chain NARROWED to the candidates that serve the PLAN's
    model (another provider or connection for the same model): the plan was budgeted for ONE
    model's context window, so a candidate on a different model would not fit it and is never
    tried. Each call switches on its own, within the activity budget; the output names the
    candidate that served. A call that lost on every allowed candidate degrades the node (never
    a raise: a retry would re-run every call from the start).

    Runs inside the node activity, so the walk is activity-level: the workflow sees one result.
    """
    config = _config(payload)
    settings = get_settings()
    try:
        envelope = await _api_client(settings).get_note_plan(
            ref.consultation_id, ref.plan_id, tenant_id=payload.tenant_id
        )
    except ApiServiceError as exc:
        return await _degrade_note_plan(payload, started, "note_plan_unavailable", str(exc))
    except ValueError as exc:
        return await _degrade_note_plan(payload, started, "note_plan_invalid", str(exc))
    plan = envelope.plan
    consultation_id = run_identity(payload.run_payload).consultation_id
    if (
        plan.tenant_id != payload.tenant_id
        or plan.plan_id != ref.plan_id
        or plan.consultation_id != ref.consultation_id
        or plan.consultation_id != consultation_id
    ):
        return await _degrade_note_plan(
            payload, started, "note_plan_mismatch", "the plan served is not this run's"
        )
    provider = wire_provider(plan.model.provider)
    model = plan.model.wire_model_id
    if not provider or not model:
        return await _degrade_note_plan(
            payload, started, "note_plan_invalid", "the plan names no provider/model"
        )

    candidate = _primary_agent(resolved, primary)
    run_context = _scope_context(payload)
    platform_default = resolve_platform_output_language(await _output_language_snapshot())
    try:
        composed, _policy_selected = _compose_agent_messages(
            candidate,
            config,
            run_context,
            data_blocks=[
                {"key": block.key, "label": block.label, "content": block.content}
                for block in plan.blocks
            ],
            output_language=platform_default,
        )
    except PromptVariableUnresolved as exc:
        return await _degrade_note_plan(payload, started, "prompt_variable_unresolved", str(exc))
    except PromptCompositionEmpty as exc:
        return await _degrade_note_plan(payload, started, "prompt_composition_empty", str(exc))
    generation = _generation_params(candidate, config)
    # The candidate's own connection and locality apply only when the plan names ITS model.
    same_model = plan.model.slug == candidate.model.slug
    deployment_kind = candidate.model.deployment_kind if same_model else None
    provider_override = candidate.provider_override if same_model else None
    known_phi = known_phi_from(payload.run_payload, run_context.get("trigger"))
    budget = ActivityBudget.for_activity(settings.text_timeout_s)
    primary_attempt = PlanAttempt(
        provider=provider,
        model=model,
        funding_tier=candidate.funding_tier,
        deployment_kind=deployment_kind,
        provider_override=provider_override,
    )
    attempts = plan_attempts(plan, primary_attempt, chain_candidates(fallback))
    # Run protocol v2 only: the admin trace names the composition once and every candidate tried.
    trace = _GenerationTrace(payload) if payload.protocol == 2 and payload.run_id else None
    if trace is not None:
        await trace.composed(composed, 0)

    async def _on_attempt(attempt: PlanAttempt, index: int) -> None:
        if trace is not None:
            await trace.model_request(attempt.provider, attempt.model, index, False, generation)

    # TASK-1047 V7 — the claim must describe the system this finalizer sends (the agent's own
    # composition), verified exactly as every other core.agent call is (FC-6); never the plan's.
    own_governance = await _system_governance(
        composed,
        candidate,
        PolicyVersionProbe(_guardrail_client(settings), payload.tenant_id),
        GovernanceVerifier(_api_client(settings), payload.tenant_id),
    )

    async def _generate(
        request: NoteCallRequest, attempt: PlanAttempt, index: int
    ) -> NoteCallResult:
        result = await _text_client(settings).generate(
            tenant_id=payload.tenant_id,
            prompt=request.user,
            system_prompt=request.system,
            # The finalizer sends the AGENT's composed system, never the plan's: the plan calls'
            # `systemGovernance` describes the plan's system and would never match (TASK-1047 V7).
            system_governance=own_governance,
            provider=attempt.provider,
            model=attempt.model,
            temperature=generation.get("temperature"),
            max_tokens=request.max_tokens,
            top_p=generation.get("topP"),
            # Each plan call answers ITS sections, not the agent's whole-note contract.
            response_format=request.response_format,
            provider_locality=provider_locality(attempt.provider, attempt.deployment_kind),
            known_phi=known_phi,
            # Each candidate spends its own connection; the plan's own attempt carries the
            # agent's only when the plan names the agent's model.
            provider_override=attempt.provider_override,
            # The agent's reasoning posture: a model that reasons unasked spends the section
            # budget on thinking and the answer is cut off.
            reasoning=generation.get("reasoning"),
            # TASK-1050 — correlated to THIS call's own LLM_CALL step, and the resolved hold's
            # override when the walk re-runs the node.
            correlation=_guardrail_correlation(
                payload,
                step_offset=(
                    call_step_offset(request.call_index - 1)
                    if request.call_index is not None
                    else REPAIR_STEP_OFFSET
                ),
            ),
            guardrail_override=payload.guardrail_override,
        )
        composed_prompt_recorder.record_composed_prompt(
            tenant_id=payload.tenant_id,
            consultation_id=consultation_id,
            agent_slug=candidate.slug,
            phase=_record_phase(config),
            provider=result.provider or attempt.provider,
            egress=getattr(result, "egress", None),
            system=request.system,
            user=request.user,
        )
        return NoteCallResult(
            content=result.content,
            stats=_generation_stats(
                result,
                provider=attempt.provider,
                model=attempt.model,
                funding_tier=attempt.funding_tier,
            ),
            provider=result.provider or attempt.provider,
            model=result.model or attempt.model,
            usage=result.usage,
            stop_reason=stop_reason_of(result),
        )

    agent_stats: dict[str, Any] = {
        "agent_slug": candidate.slug,
        **_workflow_run_stats(payload),
    }
    if candidate.version_number is not None:
        agent_stats["agent_version"] = candidate.version_number
    batch = TrajectoryBatch(settings, _consultation_trajectory(payload, consultation_id))
    try:
        execution = await execute_plan(
            plan,
            system=composed.system or None,
            user_prefix=composed.user,
            generate=walk_attempts(
                attempts,
                _generate,
                allows_another=budget.allows_another,
                on_attempt=_on_attempt if trace is not None else None,
            ),
            preserved_sections=envelope.preserved_sections,
            allow_repair=budget.allows_another,
            # TASK-1049 F9 — one lead call fills guardrail's window cache for the shared prefix.
            prime_shared_prefix=True,
        )
    except NotePlanCallFailed as exc:
        refused = next(
            (r.error for r in exc.records if isinstance(r.error, TextGuardrailBlocked)), None
        )
        if refused is not None:
            # TASK-1050 §9.8.1 — a refused plan call holds the node (resumable), and the
            # consultation is NOT told its note failed. The calls that ran are still recorded.
            record_note_plan_steps(
                batch, plan, exc.records, provider=provider, model=model, extra_stats=agent_stats
            )
            await batch.flush()
            return await _guardrail_hold_result(payload, started, refused)
        # No note is stored — not a cut-off one, not an empty one — and the consultation is told
        # why, instead of reading the run's later `OUTPUT_INVALID`.
        code = (
            "note_empty"
            if isinstance(exc, NotePlanEmptyNote)
            else "note_output_truncated" if exc.truncated_only else "note_plan_call_failed"
        )
        batch.record(
            step_type=STEP_NODE,
            name=payload.node_type,
            status=STATUS_DEGRADED,
            started=started,
            error_code=code,
        )
        record_note_plan_steps(
            batch, plan, exc.records, provider=provider, model=model, extra_stats=agent_stats
        )
        await batch.flush()
        await _report_finalizer_failure(payload, code)
        return NodeActivityResult(status="DEGRADED", reason=f"core.agent: {code}: {exc}")
    except ValueError as exc:
        return await _degrade_note_plan(payload, started, "note_plan_invalid", str(exc))

    usage = summed_usage(execution.records)
    coverage = execution.coverage.to_wire()
    # The candidate that served the first call answered (each call switches on its own).
    served = next(
        (
            r.attempt
            for r in execution.records
            if r.result is not None and isinstance(r.attempt, PlanAttempt)
        ),
        primary_attempt,
    )
    output: dict[str, Any] = {
        "text": json.dumps(execution.document, ensure_ascii=False),
        "data": execution.document,
        "provider": served.provider,
        "model": served.model,
        "usage": usage,
        "agent": {"slug": candidate.slug, "versionNumber": candidate.version_number},
        "selectionSource": "agent",
        "fundingTier": served.funding_tier,
        "guardrail": {"enabled": True, "source": "default"},
        "notePlan": {"planId": plan.plan_id, "mode": plan.mode, "coverage": coverage},
    }
    persisted: dict[str, Any] = {}
    failure = await _persist_finalized_note(
        payload,
        candidate,
        output,
        provider=served.provider,
        model=served.model,
        coverage=coverage,
        persisted=persisted,
    )

    node_stats: dict[str, Any] = {
        **note_run_stats(plan, execution),
        **agent_stats,
        "provider": served.provider,
        "model": served.model,
        **_summed_call_tokens(execution.records),
    }
    if persisted.get("context_item_id"):
        node_stats["context_item_id"] = persisted["context_item_id"]
    if persisted.get("version_number") is not None:
        node_stats["output_version"] = persisted["version_number"]
    batch.record(
        step_type=STEP_NODE,
        name=payload.node_type,
        status=STATUS_OK if failure is None else STATUS_DEGRADED,
        started=started,
        stats=node_stats,
        error_code=None if failure is None else "note_persist_failed",
    )
    record_note_plan_steps(
        batch, plan, execution.records, provider=provider, model=model, extra_stats=agent_stats
    )
    await batch.flush()
    if failure is not None:
        return NodeActivityResult(status="DEGRADED", reason=f"core.agent: {failure}", output=output)
    return NodeActivityResult(status="SUCCEEDED", output=output)


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

    TASK-1001 (OD-12) — this arm is the durable lane's NOTE writer, so its system prompt states
    the note's OUTPUT language exactly as the realtime lane's ``generateDocument`` does
    (``operatingFrame``): when the candidate's composed instruction SELECTED no
    ``output_language_policy`` fragment, the platform default's step is stated. The
    consultation's declared (SOURCE) language is never consulted. See ``output_language.py``.

    TASK-1035 — the messages are composed by ``compose_messages``, the one composer every lane
    shares: SYSTEM = platform rules → instruction → language step; USER = the bound ``in`` and
    ``context`` as wrapped data blocks (``input`` / ``context``), so transcript text is never
    read as an instruction.
    """
    config = _config(payload)
    bound = _bound(payload)
    # The finalizer of a consultation whose live handoff carries a NotePlan pointer executes
    # that plan instead of generating once from the bound text.
    if _is_consultation_finalizer(payload, config):
        # `in` is read first; the handoff's seeded note outputs are the fallback, because the
        # walk binds a note node's `out` socket — its `text`, empty on the plan path — and the
        # pointer beside it never reaches `in`.
        plan_source = _handoff_note_source(bound.get("in"), _run_context(payload))
        try:
            plan_ref = _note_plan_ref(plan_source)
        except ValueError as exc:
            return await _degrade_note_plan(payload, started, "note_plan_ref_invalid", str(exc))
        if plan_ref is not None:
            return await _run_note_plan_finalizer(
                payload, resolved, started, plan_ref, primary, fallback
            )
        # The handoff could not compose the plan and failed the note path by name: degrade with
        # THAT code, and never generate from whatever else is bound (a partial input).
        plan_error = _note_plan_error(plan_source)
        if plan_error is not None:
            return await _degrade_note_plan(
                payload, started, plan_error, "the note plan could not be composed"
            )
    # TASK-1022 — a bound note keeps its headings; see `_render_input_for_generation`.
    input_text = "\n\n".join(_render_input_for_generation(bound.get("in")))
    context_values = [value for value in _as_list(bound.get("context")) if value is not None]
    context_text = (
        json.dumps(
            context_values if len(context_values) > 1 else context_values[0],
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
        if context_values
        else ""
    )
    data_blocks = [
        {"key": "input", "label": "Input", "content": input_text},
        {"key": "context", "label": "Context", "content": context_text},
    ]
    if not input_text and not context_text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        if _is_consultation_finalizer(payload, config):
            await _report_finalizer_failure(payload, "no_bound_text")
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

    # TASK-1035 — PHI egress is `apps/text`'s job now: it pseudonymizes for a cloud provider,
    # re-identifies the answer and fails CLOSED (no locality stamp ⇒ cloud). The harness Presidio
    # pass and the policy fetch that only fed it are gone from this lane. What the harness still
    # owes text is what it KNOWS: each candidate's deployment-kind locality (stamped per call
    # below) and the identity values this run holds.
    #
    # OD-1 — the guardrail opt-out is gone too. A stored node `config.guardrail` or an agent's
    # `compiledConfig.guardrail` from before the decision is accepted and IGNORED: every call is
    # screened, and nothing here reads either field.

    # The PRIMARY carries the gateway-derived funding tier (and, when the answer shipped one, its
    # deployment kind) from `textPrimary`; the agent row is otherwise unchanged.
    primary_agent = _primary_agent(resolved, primary)
    candidates: list[tuple[str, ResolvedAgent]] = [("agent", primary_agent)]
    candidates.extend(
        ("agent-fallback", candidate_as_resolved_agent(candidate))
        for candidate in chain_candidates(fallback)
    )

    # The whole walk runs inside ONE activity budget: a switch started too late times the
    # activity out mid-call and Temporal re-runs it FROM THE PRIMARY, re-billing a generation
    # that already completed. Never start a candidate whose call cannot finish in what is left.
    budget = ActivityBudget.for_activity(settings.text_timeout_s)
    run_context = _scope_context(payload)
    # TASK-1038 R6/R8 — the admin model trace and the text deltas, under run protocol v2 only.
    trace = _GenerationTrace(payload) if payload.protocol == 2 and payload.run_id else None
    known_phi = known_phi_from(payload.run_payload, run_context.get("trigger"))
    # TASK-1001 (OD-12) — the platform-default note OUTPUT language, read ONCE for the whole walk
    # (every candidate that selects no tenant policy states the same default). Read HERE, inside
    # the activity: it is I/O, and workflow code never sees it — the replayer feeds this
    # activity's recorded RESULT back, so no command changes and no `workflow.patched` is needed.
    platform_default = resolve_platform_output_language(await _output_language_snapshot())
    policy_version_probe = PolicyVersionProbe(_guardrail_client(settings), payload.tenant_id)
    governance_verifier = GovernanceVerifier(_api_client(settings), payload.tenant_id)
    last_error: TextServiceError | None = None
    # §6.2 Gap A — one stats block per candidate that was TRIED and lost. The walk used to do
    # `last_error = exc; continue` with no timer at all, so a failed BYOK attempt cost the
    # platform CPU and network and left no trace anywhere.
    failed_attempts: list[FailedAttempt] = []
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
            # TASK-1001 (OD-12) — per CANDIDATE, because a fallback agent carries its own
            # instruction: a selected tenant policy owns the language (nothing added); otherwise
            # the platform default is stated by name, after the instruction, overriding any
            # "write in the conversation language" clause it carries.
            composed, policy_selected = _compose_agent_messages(
                candidate,
                config,
                run_context,
                data_blocks=data_blocks,
                output_language=platform_default,
            )
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
        except PromptCompositionEmpty as exc:
            # TASK-947 OD-6 — publish enforces an unconditional base fragment, so this is the
            # defensive half. Named and DEGRADED, never an empty system prompt sent to a model.
            await record_and_flush(
                payload,
                status=STATUS_DEGRADED,
                started=started,
                error_code="prompt_composition_empty",
            )
            return NodeActivityResult(
                status="DEGRADED",
                reason=f"core.agent: prompt_composition_empty: {exc}",
            )
        system_prompt = composed.system
        user_prompt = composed.user
        streaming = trace is not None and trace.streams_text
        if trace is not None:
            await trace.composed(composed, index)
        _LOGGER.info(
            "core.agent.output_language",
            node_id=payload.node_id,
            slug=candidate.slug,
            policy_selected=policy_selected,
            output_language=None if policy_selected else platform_default.tag,
        )
        prompt_fragments = composed.selected or None
        for exclusion in composed.excluded:
            # OD-5/OD-11 — an exclusion is not a degrade, and only the KEY is observable: a
            # condition string and a fragment body are both authored content.
            _LOGGER.debug(
                "core.agent.prompt_fragment_excluded",
                node_id=payload.node_id,
                slug=candidate.slug,
                fragment=exclusion.key,
                reason=exclusion.reason,
            )
        generation = _generation_params(candidate, config)
        wire_format = _candidate_wire_format(candidate, resolved)

        attempt_started_at = now()
        attempt_started = perf_counter()
        if trace is not None:
            await trace.model_request(provider, model, index, streaming, generation)
        call_kwargs: dict[str, Any] = {}
        # TASK-1047 FC-6 — per candidate: its own composed digests against ITS own stamp.
        governance = await _system_governance(
            composed, candidate, policy_version_probe, governance_verifier
        )
        if governance is not None:
            call_kwargs["system_governance"] = governance
        if streaming and trace is not None:
            call_kwargs["on_delta"] = trace.delta_sink(index)
        generate = (
            _text_client(settings).generate_stream if streaming else _text_client(settings).generate
        )
        try:
            result = await generate(
                **call_kwargs,
                tenant_id=payload.tenant_id,
                prompt=user_prompt,
                system_prompt=system_prompt or None,
                provider=provider,
                model=model,
                temperature=generation.get("temperature"),
                max_tokens=generation.get("maxTokens"),
                top_p=generation.get("topP"),
                response_format=wire_format,
                # TASK-1035 §5.0 — per CANDIDATE, from ITS deployment kind only; absent ⇒ no
                # stamp and text fails closed to cloud.
                provider_locality=provider_locality(provider, candidate.model.deployment_kind),
                known_phi=known_phi,
                # TASK-958 G3 — THIS candidate's own connection. The gateway resolved it from
                # the model row's `sourceConnectionId`, so a sibling-bound agent authenticates
                # as the account it names; without it the client fell back to a lookup by
                # provider NAME, which is the tenant's DEFAULT account for that vendor. Each
                # candidate of the chain carries its own, so a fallback does not inherit the
                # primary's.
                provider_override=candidate.provider_override,
                # THIS candidate's reasoning posture (`parameters.generation.reasoning`).
                reasoning=generation.get("reasoning"),
                # TASK-1050 — the evaluation record's correlation, and a resolved hold's one-shot
                # override (set by the walk only on the node's re-run).
                correlation=_guardrail_correlation(payload, step_offset=_LLM_CALL_STEP_OFFSET),
                guardrail_override=payload.guardrail_override,
            )
        except TextGuardrailBlocked as refused:
            # TASK-1050 §9.8.1 — a hold, never a switch (see `_guardrail_hold_result`).
            return await _guardrail_hold_result(
                payload, started, refused, failed_attempts=failed_attempts
            )
        except TextServiceError as exc:
            # A provider outage: switch to the next resolved candidate (a DIFFERENT engine —
            # the after-send guard protects the SAME call from being re-issued, not the chain).
            last_error = exc
            failed_attempts.append(
                FailedAttempt(
                    attempt_started_at,
                    failed_attempt_stats(
                        provider=provider,
                        model=model,
                        funding_tier=candidate.funding_tier,
                        total_ms=round((perf_counter() - attempt_started) * 1000.0),
                        # The workflow lane knows WHY the inference happened; the consultation
                        # lane stamps none on its successful step, so it stamps none here.
                        trigger=USAGE_TRIGGER_WORKFLOW_RUN,
                    ),
                )
            )
            continue

        # OD-9 — what was SENT, for incident reconstruction. Fire-and-forget: it never fails or
        # delays this step.
        composed_prompt_recorder.record_composed_prompt(
            tenant_id=payload.tenant_id,
            consultation_id=run_identity(payload.run_payload).consultation_id,
            agent_slug=candidate.slug,
            phase=_record_phase(config),
            provider=result.provider or provider,
            egress=getattr(result, "egress", None),
            system=system_prompt,
            user=user_prompt,
        )

        if trace is not None:
            await trace.guardrails(result, index)
        # TASK-1050 — warn / unverified notices: public now, collected by the walk.
        notices = await _emit_guardrail_notices(payload, getattr(result, "guardrail_notices", None))
        output: dict[str, Any] = {
            "text": result.content,
            "provider": result.provider or provider,
            "model": result.model or model,
            "usage": result.usage,
            "agent": {"slug": candidate.slug, "versionNumber": candidate.version_number},
            "selectionSource": selection_source,
            "fundingTier": candidate.funding_tier,
            # §3.14 record (c), kept in shape for its readers. TASK-1035 OD-1: there is no
            # opt-out left to decide, so every generation is screened by platform default.
            "guardrail": {"enabled": True, "source": "default"},
        }
        if wire_format is not None:
            try:
                output["data"] = json.loads(result.content)
            except (TypeError, ValueError):
                output["data"] = None
        # F14 — the LLM_CALL step this generation is BILLED from. Before it, every
        # interpreter node persisted `stats = null` and the gateway's co-emission hook
        # (`buildHarnessUsageEvent`) had nothing to bill: a real generation, zero ledger rows.
        # Both extras are passed ONLY when there is something to say, so a single-body agent
        # whose primary served records byte-identically to before:
        # * TASK-947 OD-11 `node_stats` — which fragments of a composite instruction ran, KEYS
        #   only, on the node step;
        # * TASK-959 §6.2 `failed_attempts` — the legs that lost, on the same batch as the leg
        #   that served, at their own offsets inside this node's seq base.
        extras: dict[str, Any] = {}
        if prompt_fragments:
            extras["node_stats"] = {"prompt_fragments": prompt_fragments}
        if failed_attempts:
            extras["failed_attempts"] = failed_attempts
        await record_generation_and_flush(
            payload,
            started=started,
            **extras,
            stats=_generation_stats(
                result,
                provider=provider,
                model=model,
                funding_tier=candidate.funding_tier,
            ),
        )

        # TASK-932 R-16a — the FINALIZED note becomes the consultation's note.
        #
        # Until now nothing in a `core` graph persisted it. `consultation.persistDraft` cannot be
        # wired to a `core.agent` at all — its `in` port is `document` and `core.agent` publishes
        # `text` / `object`, and the port lattice allows widening ONLY specific -> general
        # (`port-model.ts`), which is deliberate — so the note reached `core.output` (delivery)
        # and `core.humanReview` (a gate over a note nobody had written) and stopped there. A
        # clinician opening the console saw an empty case-note column.
        #
        # A persist FAILURE degrades and keeps the output rather than raising: raising is what
        # makes Temporal re-run this activity FROM THE PRIMARY, re-billing a generation that
        # already completed. The note still reaches the review gate and the output node, and the
        # reason names what did not happen.
        if _is_consultation_finalizer(payload, config):
            # The provider/model are the ones THIS generation already resolved — threaded rather
            # than re-resolved, so the optional semantic-rewrite half of the redaction runs
            # against the same engine that wrote the note. `wire_format` is deliberately NOT
            # threaded: it describes the finalizer's DOCUMENT, and what the redaction transforms
            # is the bare `case_note` string inside it.
            failure = await _persist_finalized_note(
                payload,
                candidate,
                output,
                provider=provider,
                model=model,
            )
            if failure is not None:
                return NodeActivityResult(
                    status="DEGRADED",
                    reason=f"core.agent: {failure}",
                    output=output,
                    prompt_fragments=prompt_fragments,
                    io=_streamed_io(streaming),
                    guardrail_notices=notices or None,
                )
        return NodeActivityResult(
            status="SUCCEEDED",
            output=output,
            prompt_fragments=prompt_fragments,
            io=_streamed_io(streaming),
            guardrail_notices=notices or None,
        )

    if exhausted:
        # DEGRADED, never a raise: raising is what makes Temporal retry the activity from the
        # primary, which is exactly the double-spend this guard exists to prevent.
        await record_and_flush(
            payload,
            status=STATUS_DEGRADED,
            started=started,
            error_code="text_budget_exhausted",
            failed_attempts=failed_attempts,
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=(
                "core.agent: activity budget exhausted before the next fallback candidate could "
                f"be started (last error: {last_error})"
            ),
        )
    await record_and_flush(
        payload,
        status=STATUS_DEGRADED,
        started=started,
        error_code="text_generate_failed",
        failed_attempts=failed_attempts,
    )
    return NodeActivityResult(
        status="DEGRADED",
        reason=f"core.agent: text generate failed on every resolved candidate: {last_error}",
    )


async def _admin_event(
    payload: NodeActivityInput,
    event_type: str,
    data: dict[str, Any],
    intent: str,
    *,
    node_scoped: bool = True,
) -> None:
    """One admin-trace event (run protocol v2 only; best-effort, never raises)."""
    if payload.protocol != 2 or not payload.run_id:
        return
    from harness.temporal.interpreter.activities import run_event_producer  # noqa: PLC0415
    from harness.temporal.interpreter.node_events import attempt_of  # noqa: PLC0415
    from harness.temporal.interpreter.run_events import v2_node_key  # noqa: PLC0415

    await run_event_producer().append(
        run_id=payload.run_id,
        type=event_type,
        node_id=payload.node_id if node_scoped else None,
        data=data,
        dedupe_key=v2_node_key(
            payload.run_id, payload.node_id, attempt_of(), intent, payload.event_scope or ""
        ),
    )


def _streamed_io(streaming: bool) -> dict[str, Any] | None:
    return {"streamed": ["text"]} if streaming else None


class _GenerationTrace:
    """TASK-1038 R6/R8 — what a text generation reports on the run stream (run protocol v2).

    Admin: ``prompt.composed`` (layer SIZES only — the content is read through the Prompt
    Inspector), ``model.request`` per candidate, ``guardrail.inbound`` / ``guardrail.outbound``
    from the text service's report. Public: ``output.text.delta { field: 'text' }`` for a node
    wired into End or flagged ``stream`` (OD-24), generated with ``stream: true``.
    """

    def __init__(self, payload: NodeActivityInput) -> None:
        from harness.temporal.interpreter.activities import run_event_producer  # noqa: PLC0415
        from harness.temporal.interpreter.node_events import attempt_of  # noqa: PLC0415

        self._payload = payload
        self._producer = run_event_producer()
        self._attempt = attempt_of()
        self._streamed_any = False
        delivery = payload.delivery or {}
        self.streams_text = delivery.get("stream") is True or "text" in (
            delivery.get("publicFields") or []
        )

    def _key(self, intent: str) -> str:
        from harness.temporal.interpreter.run_events import v2_node_key  # noqa: PLC0415

        return v2_node_key(
            self._payload.run_id,
            self._payload.node_id,
            self._attempt,
            intent,
            self._payload.event_scope or "",
        )

    async def _append(self, event_type: str, data: dict[str, Any], intent: str | None) -> None:
        await self._producer.append(
            run_id=self._payload.run_id,
            type=event_type,
            node_id=self._payload.node_id,
            data=data,
            dedupe_key=self._key(intent) if intent else None,
        )

    async def composed(self, composed: Any, index: int) -> None:
        layers = [{"name": name, "chars": chars} for name, chars in composed.layers]
        await self._append(
            "prompt.composed",
            {
                "layers": layers,
                "charsTotal": sum(layer["chars"] for layer in layers),
                "selected": list(composed.selected),
                "excluded": [
                    {"key": exclusion.key, "reason": exclusion.reason}
                    for exclusion in composed.excluded
                    if exclusion.reason in ("condition_false", "condition_error")
                ],
                "blocks": [
                    {"key": b.key, "chars": b.chars, "truncated": b.truncated}
                    for b in composed.blocks
                ],
            },
            f"prompt:{index}",
        )

    async def model_request(
        self, provider: str, model: str, index: int, stream: bool, generation: dict[str, Any]
    ) -> None:
        parameters: dict[str, Any] = {}
        temperature = generation.get("temperature")
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
            parameters["temperature"] = max(0, temperature)
        max_tokens = generation.get("maxTokens")
        if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens >= 1:
            parameters["maxTokens"] = max_tokens
        data: dict[str, Any] = {
            "provider": provider,
            "model": model,
            "attempt": index + 1,
            "fallback": index > 0,
            "stream": stream,
        }
        if parameters:
            data["parameters"] = parameters
        await self._append("model.request", data, f"model:{index}")

    def delta_sink(self, index: int) -> Any:
        """The ``on_delta`` of candidate ``index``. A fallback candidate that starts streaming
        AFTER an earlier one already streamed partial text first re-announces the node with a
        higher ``attempt``, so a client discards the abandoned text (protocol-v2.md §3)."""
        restarted = [False]

        async def _sink(text: str) -> None:
            if index > 0 and self._streamed_any and not restarted[0]:
                restarted[0] = True
                await self._append(
                    "node.started",
                    {"kind": self._payload.node_type, "attempt": self._attempt + index},
                    f"restart:{index}",
                )
            self._streamed_any = True
            await self._producer.text_delta(
                run_id=self._payload.run_id,
                node_id=self._payload.node_id,
                field="text",
                text=text,
            )

        return _sink

    async def guardrails(self, result: Any, index: int) -> None:
        verdicts = getattr(result, "guardrail", None)
        verdicts = verdicts if isinstance(verdicts, dict) else {}
        egress = getattr(result, "egress", None)
        inbound = _guardrail_event(verdicts.get("inbound"))
        if inbound is None and isinstance(egress, dict):
            raw_detected = egress.get("detected")
            detected: dict[str, Any] = raw_detected if isinstance(raw_detected, dict) else {}
            counts = [v for v in detected.values() if isinstance(v, int)]
            redacted = egress.get("redacted") is True
            inbound = {
                "action": "REDACT" if redacted else "ALLOW",
                "detected": sum(counts),
                "categories": sorted(str(k) for k in detected),
                "mode": "redact" if redacted else "detect",
            }
        if inbound is not None:
            await self._append("guardrail.inbound", inbound, f"guardrail-in:{index}")
        outbound = _guardrail_event(verdicts.get("outbound"))
        if outbound is not None:
            await self._append("guardrail.outbound", outbound, f"guardrail-out:{index}")


def _guardrail_event(verdict: Any) -> dict[str, Any] | None:
    """A text-service verdict, narrowed to `GuardrailEventData`'s closed shape; ``None`` when
    the service reported none."""
    if not isinstance(verdict, dict) or verdict.get("action") not in ("ALLOW", "REDACT", "BLOCK"):
        return None
    detected = verdict.get("detected")
    event: dict[str, Any] = {
        "action": verdict["action"],
        "detected": detected if isinstance(detected, int) and detected >= 0 else 0,
    }
    categories = verdict.get("categories")
    if isinstance(categories, list):
        event["categories"] = [str(c) for c in categories]
    if verdict.get("mode") in ("detect", "redact"):
        event["mode"] = verdict["mode"]
    latency = verdict.get("latencyMs")
    if isinstance(latency, (int, float)) and not isinstance(latency, bool) and latency >= 0:
        event["latencyMs"] = latency
    return event


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
        # TASK-1042 — no blob, but a LIVE STT session bound to this run: read its transcript.
        session_id = _stt_session_id(audio)
        if session_id is not None:
            return await _run_session_transcript(payload, resolved, started, session_id)
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
            # The node names its agent; apps/api resolves it into the job's `ResolvedAsrSpec`
            # (TASK-1006 — there is no pipeline id any more).
            agent_slug=resolved.slug,
            audio_uri=audio_uri,
            language=language,
            poll_timeout_seconds=int(config.get("timeoutSeconds") or 900),
        )
    )
    await record_and_flush(payload, status=STATUS_OK, started=started)
    transcript_text = getattr(result, "transcript", None)
    if isinstance(transcript_text, str) and transcript_text:
        # TASK-1036 §10.3 — the transcript the harness sees, on the admin trace.
        await _admin_event(payload, "transcript.final", {"text": transcript_text}, "transcript")
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


def _stt_session_id(audio: Any) -> str | None:
    """The live STT session id an `audio` port value names (TASK-1042), or `None`.

    `{sttSessionId}` itself (a binding to the stream-audio input field), or one level inside the
    bound value (a legacy edge from the trigger hands the whole run input to `audio`). Called
    only when no blob reference was found, so a blob always wins.
    """
    for candidate in _as_list(audio):
        if not isinstance(candidate, dict):
            continue
        for value in (candidate, *candidate.values()):
            if isinstance(value, dict):
                session_id = value.get("sttSessionId")
                if isinstance(session_id, str) and session_id:
                    return session_id
    return None


#: C5 state → the node's named failure (TASK-1042). `live` here means the walk's wait reached its
#: ceiling with the audio still open, which is the same outcome as the gateway's own `timeout`.
_SESSION_FAILURES = {
    "truncated": "transcript_truncated",
    "timeout": "live_audio_timeout",
    "live": "live_audio_timeout",
}


async def _run_session_transcript(
    payload: NodeActivityInput, resolved: ResolvedAgent, started: Any, session_id: str
) -> NodeActivityResult:
    """TASK-1042 — the transcript of the live STT session bound to this run (C5 → C6).

    ONE read: by the time this node runs, the walk's durable wait (OD-4a) has already seen the
    session leave `live`. The gateway serves finals from offset 0, so speech captured before the
    run started is included (OD-9). A transport fault raises (Temporal retries the activity); a
    refusal or a session that did not end cleanly degrades by NAME, never with a short transcript.
    """
    try:
        answer = await _api_client(get_settings()).get_stt_session_transcript(
            session_id, tenant_id=payload.tenant_id, run_id=payload.run_id
        )
    except ApiClientError as exc:
        if exc.status_code != 404:
            raise
        state = "unbound"
    else:
        raw_state = answer.get("state") if isinstance(answer, dict) else None
        state = raw_state if isinstance(raw_state, str) else "live"

    if state != "ended":
        code = _SESSION_FAILURES.get(state, "live_audio_unbound")
        await record_and_flush(payload, status=STATUS_DEGRADED, started=started, error_code=code)
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"core.agent: {code}: live STT session is {state}",
        )

    finals = [f for f in _as_list(answer.get("finals")) if isinstance(f, dict)]
    segments = [
        {
            "text": f.get("text") if isinstance(f.get("text"), str) else "",
            "start": f.get("start"),
            "end": f.get("end"),
            "speaker": f.get("speaker"),
        }
        for f in finals
    ]
    transcript = answer.get("transcript")
    if not isinstance(transcript, str):
        transcript = " ".join(seg["text"] for seg in segments if seg["text"])
    language = answer.get("language")
    await record_and_flush(payload, status=STATUS_OK, started=started)
    if transcript:
        # TASK-1036 §10.3 — the transcript the harness sees, on the admin trace (as the blob path).
        await _admin_event(payload, "transcript.final", {"text": transcript}, "transcript")
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "transcript": transcript,
            "segments": segments,
            "language": language if isinstance(language, str) else None,
            "agent": {"slug": resolved.slug, "versionNumber": resolved.version_number},
        },
    )


#: `output.audio.delta.format` is one of four; a TTS format or content type maps onto it.
_PROTOCOL_AUDIO_FORMATS = {
    "wav": "wav",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "mp3": "mp3",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "ogg": "ogg",
    "opus": "ogg",
    "audio/ogg": "ogg",
    "pcm": "pcm",
    "audio/pcm": "pcm",
    "audio/l16": "pcm",
}


def _protocol_audio_format(declared: Any, content_type: Any) -> str | None:
    for candidate in (declared, content_type):
        if isinstance(candidate, str):
            found = _PROTOCOL_AUDIO_FORMATS.get(candidate.split(";")[0].strip().lower())
            if found is not None:
                return found
    return None


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
    # The DELTA lane, best-effort by contract. Audio frames ride the same per-run Redis Stream,
    # the same envelope and the same resume-token contract as text deltas, base64-encoded; they
    # never touch Temporal — not a signal, not an activity result — because the history ceiling
    # is 51,200 events / 50 MB per run and a minute of speech would consume a measurable slice
    # of it. A Redis outage costs the live view and nothing else, so it is deliberately not
    # allowed to fail a synthesis that already succeeded, and a run with no `run_id` (the field
    # is additive-optional) simply does not stream. MEASURED by
    # `test_task849_audio_two_lane_split.py`.
    #
    # TASK-1038 R6 — the frames are run-protocol v2 `output.audio.delta { field: 'audio' }`,
    # appended through the ONE sequencer (no dedupe key: a retried synthesis is new audio, and the
    # retry's `node.started` tells clients to discard). A format the protocol cannot name is not
    # streamed — the stored `audio` reference still carries the whole result.
    audio_format = _protocol_audio_format(params.get("format"), synthesis.content_type)
    if payload.run_id and audio_format is not None:
        from harness.temporal.interpreter.activities import run_event_producer  # noqa: PLC0415

        producer = run_event_producer()
        for frame in synthesis.chunks:
            await producer.audio_delta(
                run_id=payload.run_id,
                node_id=payload.node_id,
                field="audio",
                chunk=frame,
                audio_format=audio_format,
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


# ---------------------------------------------------------------------------------------------
# TASK-930 §5 — `Agent.outputSchema` is ENFORCED, not decorative
# ---------------------------------------------------------------------------------------------

#: `AGENT_IO_DEFAULTS.TEXT_GENERATION.outputSchema` from `packages/workflow-contract`.
#:
#: Mirrored rather than imported: `packages/py-workflow-contract` carries the NODE vocabulary,
#: not the agent I/O defaults, and this lane's only consumer of the rule is
#: `_run_text_generation`, so the TEXT_GENERATION default is the only one that can ever arrive.
#: Its shape is pinned by `test_core_agent_ner_task930.py` on this side and by
#: `agent-schemas.task930.test.ts` on the other, so a drift is a failing test, not a silent
#: constraint applied to every agent on the platform.
_TEXT_GENERATION_DEFAULT_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["text"],
    "properties": {"text": {"type": "string"}},
}


def output_schema_response_format(
    slug: str, output_schema: Any, parameters: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The ``json_schema`` response format a declared ``outputSchema`` implies.

    The Python half of the ONE rule the gateway invocation service, this activity and the
    realtime `core.agent` handler share (``outputSchemaResponseFormat`` in
    ``packages/workflow-contract/src/agent-schemas.ts``), so an agent cannot behave differently
    depending on which lane happens to run it.

    Three deliberate silences, each returning ``None``:

    * the declared schema IS the task default — nothing was declared, so nothing is enforced,
      and enforcing it anyway would constrain every agent that simply never wrote one;
    * it is not an object schema with at least one property — an engine cannot constrain to it,
      and half a constraint is worse than none because it LOOKS like one;
    * ``parameters.responseFormat`` is set — an explicit hyper-parameter is the author's
      decision and always wins, including when it says plain text.
    """
    if parameters is not None and parameters.get("responseFormat") is not None:
        return None
    if not isinstance(output_schema, dict) or output_schema.get("type") != "object":
        return None
    properties = output_schema.get("properties")
    if not isinstance(properties, dict) or not properties:
        return None
    if output_schema == _TEXT_GENERATION_DEFAULT_OUTPUT_SCHEMA:
        return None
    name = re.sub(r"[^a-z0-9_]", "_", slug, flags=re.IGNORECASE)
    return {
        "type": "json_schema",
        "json_schema": {"name": f"{name}_output", "schema": output_schema, "strict": True},
    }


# ---------------------------------------------------------------------------------------------
# core.agent — NAMED_ENTITY_RECOGNITION (TASK-930 §2.4)
# ---------------------------------------------------------------------------------------------


def _ner_entities(response: Any) -> list[dict[str, Any]]:
    """`apps/nlp`'s wire entities in the AGENT's declared output vocabulary (§2.3).

    The wire shape is `apps/nlp`'s ``Entity``: ``entity_type`` / ``confidence`` /
    ``position.{start,end}``, plus enrichment fields (``umls_cui``, ``icd_code``, ``assertion``)
    that belong to the clinical NER plane and are deliberately NOT re-exported — the agent's
    declared schema closes ``additionalProperties``, so anything it does not name would violate
    the contract the agent published.

    A span with no resolvable OFFSETS is DROPPED rather than emitted with substituted ones: a
    span the caller cannot locate in its own text is not a finding, and a fabricated offset
    would highlight the wrong words in a clinical note.
    """
    raw = response.get("entities") if isinstance(response, dict) else None
    if not isinstance(raw, list):
        return []
    entities: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        position = item.get("position")
        position = position if isinstance(position, dict) else {}
        start, end = position.get("start"), position.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            continue
        entity: dict[str, Any] = {
            "text": item.get("text") if isinstance(item.get("text"), str) else "",
            "label": (
                item.get("entity_type") if isinstance(item.get("entity_type"), str) else "UNKNOWN"
            ),
            "start": start,
            "end": end,
        }
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            entity["score"] = confidence
        entities.append(entity)
    return entities


async def _run_ner(
    payload: NodeActivityInput, resolved: ResolvedAgent, started: Any
) -> NodeActivityResult:
    """Run a NAMED_ENTITY_RECOGNITION agent through the SAME nlp call `core.classify` uses.

    One route, one client, one set of registry facts: ``model_name``/``model_path`` are the
    ``sourceUri``/``localPath`` the GATEWAY resolved, never anything this activity picks.
    ``labels`` is the agent's INSTRUCTION (what to look for — required by an open-taxonomy
    extractor, ignored by a closed-taxonomy checkpoint) and ``threshold``/``aggregation`` are
    its PARAMETERS (how hard to look); each is omitted when the agent declared none, so the
    checkpoint's own declaration keeps applying rather than being overwritten here.

    Degrades rather than raises, like every other `_run_*`: the reason stays on the node so a
    run's failure names the agent instead of surfacing as an opaque activity error.
    """
    text = " ".join(_texts(_bound(payload).get("in")))
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="core.agent: no text arrived on the `in` port — nothing to extract from",
        )

    instruction = resolved.instruction if isinstance(resolved.instruction, dict) else {}
    parameters = resolved.parameters if isinstance(resolved.parameters, dict) else {}
    labels = [
        label
        for label in (instruction.get("labels") or [])
        if isinstance(label, str) and label.strip()
    ]
    raw_threshold = parameters.get("threshold")
    aggregation = parameters.get("aggregation")

    try:
        response = await _nlp_client(get_settings()).classify_tokens_raw(
            text,
            tenant_id=payload.tenant_id,
            model_name=resolved.model.source_uri,
            model_path=resolved.model.local_path,
            labels=labels or None,
            threshold=(float(raw_threshold) if isinstance(raw_threshold, (int, float)) else None),
            aggregation_strategy=aggregation if isinstance(aggregation, str) else None,
        )
    except NlpServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="ner_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"core.agent: {exc}")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "data": {"entities": _ner_entities(response)},
            # The classified TEXT rides through on the `out` SOCKET, so a node bound downstream
            # still sees the document. TASK-1006 — under the socket's RUNTIME key `text`
            # (`core.agent`'s `out -> text`, the parity fixture), as the live lane's NER already
            # publishes it: the key used to be `out`, which no socket reads, so on this lane a
            # summarizer bound to `n_ner.out` was handed nothing.
            "text": text,
            "agent": {"slug": resolved.slug, "versionNumber": resolved.version_number},
        },
    )


async def _resolve_agent_answer(slug: str, version: int | None, tenant_id: str) -> dict[str, Any]:
    """The gateway's ``ResolvedAgent`` answer for one ``core.agent`` node.

    TASK-1038 D-A (owner rule W3) — a node that pins ``agentRef.versionNumber`` RUNS that
    version: it is resolved BY VERSION (``resolve_agent_version``), so a republished agent (vN+1
    active) or a DEPRECATED pinned version does not change or break a published workflow, and the
    prompt that runs is the one frozen inside that version (``compiledConfig.resolvedPrompt``,
    lifted by :class:`ResolvedAgent`). There is no runtime template fetch on this path.

    The pinned answer is cached per ``(tenantId, slug, versionNumber)`` — see
    ``agent_version_cache`` for why that is safe and why a credential-bearing answer is not
    cached. An UNPINNED node keeps asking for the ACTIVE version on every run, exactly as before.
    """
    api = _api_client(get_settings())
    if version is None:
        return await api.resolve_agent(slug=slug, tenant_id=tenant_id)
    cached = agent_version_cache.get(tenant_id, slug, version)
    if cached is not None:
        return cached
    answer = await api.resolve_agent_version(slug=slug, version_number=version, tenant_id=tenant_id)
    agent_version_cache.put(tenant_id, slug, version, answer)
    return answer


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
    raw_version = ref.get("versionNumber") if isinstance(ref, dict) else None
    # `bool` is an `int`; a boolean is never a version number.
    version = (
        raw_version if isinstance(raw_version, int) and not isinstance(raw_version, bool) else None
    )

    try:
        raw = await _resolve_agent_answer(slug, version, payload.tenant_id)
        resolved = ResolvedAgent.model_validate(raw)
    except (ApiServiceError, ValueError) as exc:
        # Fails CLOSED: an unresolvable agent is never substituted with a default — and a pinned
        # version the gateway cannot serve is never substituted with the ACTIVE one either.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="agent_unresolvable"
        )
        pinned = f" v{version}" if version is not None else ""
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"core.agent: agent `{slug}`{pinned} did not resolve: {exc}",
        )
    if version is not None and resolved.version_number != version:
        # TASK-1038 D-A — the by-version route answered for a DIFFERENT version. That is a
        # gateway defect, not drift: the pin is the contract, so the node fails CLOSED rather
        # than running a version nobody pinned.
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="agent_version_mismatch"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=(
                f"core.agent: agent_version_mismatch: `{slug}` is pinned to v{version} but the "
                f"by-version resolve answered v{resolved.version_number}"
            ),
        )

    if resolved.task == "TEXT_GENERATION":
        # TASK-876: the fallback chain rides on the resolve answer — read, never resolved here.
        result = await _run_text_generation(
            payload,
            resolved,
            started,
            fallback=read_text_fallback(raw),
            primary=read_text_primary(raw),
        )
    elif resolved.task == "SPEECH_TO_TEXT":
        result = await _run_transcription(payload, resolved, started)
    # TASK-930 §2.4 — an EXPLICIT arm, before the TTS fallthrough. Without it a NER agent
    # reached `_run_speech` and degraded with "the resolved TTS agent names no `voice`": a
    # complaint about a control its author never declared, for a task nobody had told the
    # switch about. Every task the mirror admits is now named here.
    elif resolved.task == "NAMED_ENTITY_RECOGNITION":
        result = await _run_ner(payload, resolved, started)
    else:
        result = await _run_speech(payload, resolved, started)
    if payload.protocol != 2:
        return result
    # TASK-1036 §9.1 — the agent's TASK decides its NodeIO outputs (`nodes.<id>.outputs.*`).
    return result.model_copy(update={"io": {**(result.io or {}), "task": resolved.task}})


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
    await _admin_event(
        payload,
        "output.validated",
        {
            "valid": violation is None,
            "problems": [] if violation is None else [violation],
            "field": "in",
        },
        "output-validated",
    )
    if violation is not None:
        mode = config.get("onSchemaViolation") or "fail"
        await record_and_flush(payload, status=STATUS_ERROR, started=started)
        if mode == "fail":
            raise OutputSchemaViolation(
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
    """Deterministic reshape — the tier-2 escape hatch.

    The mapping language is intentionally tiny: dotted reads out of this node's bound inputs,
    renamed writes onto its output, plus literal constants. Anything richer is a transformation
    language, which is a second place for tenant logic to live and a second thing to audit.

    An unresolved mapping marked ``required`` DEGRADES the node observably; an optional one is
    simply absent from the output. Neither ever invents a value — a fabricated field is worse
    than a missing one, because a downstream schema check would pass on it.

    TASK-893: the body moved here verbatim from the retired ``agentic.data`` activity, which
    ``core.data`` had been delegating to. The reason prefix is the only change, and it now names
    the node type that actually ran.
    """
    started = now()
    config = _config(payload)
    bound = _bound(payload)

    output: dict[str, Any] = {}
    constants = config.get("constants")
    if isinstance(constants, dict):
        output.update(constants)

    missing_required: list[str] = []
    mappings = config.get("mappings")
    for mapping in mappings if isinstance(mappings, list) else []:
        if not isinstance(mapping, dict):
            continue
        source = mapping.get("from")
        target = mapping.get("to")
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        value = resolve_dotted_path(bound, source)
        if value is MISSING:
            if mapping.get("required") is True:
                missing_required.append(source)
            continue
        output[target] = value

    result: dict[str, Any] = {"data": output}
    # TASK-1006 — the `text` socket: the reshaped `text` field, when it IS text. It is how a
    # TEXT kind a caller supplies on the trigger (a finished transcript) reaches an agent's
    # `in: text` — the trigger's own socket is an object. Absent unless there is real text: a
    # blank or non-text value publishes nothing rather than an empty string downstream.
    texts = [text for text in _texts(output.get("text")) if text.strip()]
    if texts:
        result["text"] = "\n\n".join(texts)

    await record_and_flush(payload, status=STATUS_OK, started=started)
    if missing_required:
        return NodeActivityResult(
            status="DEGRADED",
            reason=(
                "core.data: required mapping(s) did not resolve: "
                f"{', '.join(sorted(missing_required))}"
            ),
            output=result,
        )
    return NodeActivityResult(status="SUCCEEDED", output=result)


@activity.defn(name="interpreter.core_note")
async def interpreter_core_note(payload: NodeActivityInput) -> NodeActivityResult:
    """A canvas comment. `compile()` strips it; if a compiled artifact ever carries one, it is an
    observable skip, never work."""
    return NodeActivityResult(status="SKIPPED", reason="annotation")


@activity.defn(name="interpreter.core_action")
async def interpreter_core_action(payload: NodeActivityInput) -> NodeActivityResult:
    """Delegate to the catalogue activity named by `actionKey`, with the action's own config.

    The action's activity is called DIRECTLY (a plain coroutine), under a payload whose
    `node_type` is the action key so every trajectory row still names the capability that ran.
    `record_and_flush` is the action's. The catalogue is `action_catalogue.py` (TASK-893) — one
    table, mirrored by `action-catalogue.ts`, never a hand-copied key list here.
    """
    # Imported here rather than at module scope: the catalogue's node modules are siblings of
    # this one, and a module-scope import would fix an import order nothing else needs.
    from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE  # noqa: PLC0415

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
