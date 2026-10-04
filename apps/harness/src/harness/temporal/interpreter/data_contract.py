"""TASK-1036 §9 (OD-29/30/32/33) — the interpreter's RUNTIME half of the data contract (pure).

The publish half (types, ancestor rules, issue codes) is TypeScript's, mirrored for parity in
``packages/py-workflow-contract``. This module is what the harness needs at RUN time, and it is
imported by the deterministic workflow: no I/O, no clock, no randomness.

* **NodeIO outputs** — which output FIELDS a node publishes (``outputs_view``). For every non-agent
  node a field IS the legacy output key of the same name (NodeIO names them after the port
  ``outputKey``), so the view is a projection of the stored output and never a second copy. The
  three that are not: an NER agent's ``entities`` (= legacy ``data.entities``), a router's
  ``input`` (the value bound to its ``in``, carried through to the branch taken — OD-19) and a
  loop's ``item`` (the current iteration's item, inside the body).
* **The binding resolver** (``resolve_bindings``) — a node's compiled ``bindings`` resolved from the
  run scope. BOTH spellings are served for one release: ``nodes.<id>.outputs.<field>`` (NodeIO) and
  ``nodes.<id>.<key>`` (the legacy runtime key). ``consultation.*`` comes from the node's DECLARED
  reads (recorded activity results — OD-30), ``run.now`` from ``workflow.now()`` at node start.
  A value the workflow cannot read (a claim-check reference, TASK-1038 R-3) is never guessed at:
  the binding is DEFERRED (``{"$hopeBinding": …}``) and the node-activity envelope finishes it
  once the reference is dereferenced (``finish_deferred``).
* **Delivery** (OD-24) — which nodes' outputs reach the PUBLIC plane: nodes wired into End
  (``core.output``) and nodes flagged ``stream``.
* **PHI classes** of the consultation read schema's paths, for ``data.bound`` /
  ``consultation.read`` events (pinned to ``consultation-read-schema.fixture.json``).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from harness.temporal.interpreter import payload_refs
from harness.temporal.interpreter.templating import (
    PromptTemplateSyntaxError,
    PromptVariableUnresolved,
    render_template,
    template_references,
)

#: The binding roots (``bindings.ts`` ``BINDING_ROOTS``).
BINDING_ROOTS = ("context", "consultation", "nodes", "vars", "run")

#: Declared output fields per core node type (``node-io.ts`` ``NODE_IO`` — pinned by test).
NODE_OUTPUT_FIELDS: dict[str, tuple[str, ...]] = {
    "core.trigger": ("context",),
    "core.agent": (
        "text",
        "data",
        "transcript",
        "segments",
        "language",
        "audio",
        "durationMs",
        "entities",
    ),
    "core.classify": ("classification", "input"),
    "core.humanReview": ("decision",),
    "core.variable": ("vars",),
    "core.condition": ("evaluation", "input"),
    "core.loop": ("item", "result"),
    "core.note": (),
    "core.output": (),
    "core.data": ("data", "text"),
    "core.action": ("result", "text", "entities", "verdict", "document", "context"),
}

#: ``agentNodeIO(task)`` output fields (``data`` only when the output schema is structured —
#: the view simply publishes it when the agent produced one).
AGENT_TASK_OUTPUT_FIELDS: dict[str, tuple[str, ...]] = {
    "TEXT_GENERATION": ("text", "data"),
    "SPEECH_TO_TEXT": ("transcript", "segments", "language"),
    "TEXT_TO_SPEECH": ("audio", "durationMs"),
    "NAMED_ENTITY_RECOGNITION": ("entities", "text"),
}

#: The PHI class each declared output carries, where the node type can say (``NODE_IO``).
OUTPUT_PHI_CLASS: dict[str, str] = {
    "text": "PHI",
    "data": "PHI",
    "transcript": "PHI",
    "segments": "PHI",
    "language": "NON_PHI",
    "audio": "PHI",
    "durationMs": "NON_PHI",
    "entities": "PHI",
    "context": "PHI",
    "classification": "NON_PHI",
    "evaluation": "NON_PHI",
    "decision": "PHI",
}

#: Router node types whose ``input`` output carries their bound ``in`` through (OD-19).
ROUTER_NODE_TYPES = frozenset({"core.classify", "core.condition"})

#: Every addressable ``consultation.*`` path and its PHI class (``consultationReadPaths()`` of
#: CONSULTATION_READ_SCHEMA_V1, pinned to ``consultation-read-schema.fixture.json``).
CONSULTATION_PATH_PHI: dict[str, str] = {
    "consultation.id": "NON_PHI",
    "consultation.visitType": "NON_PHI",
    "consultation.department": "NON_PHI",
    "consultation.department.id": "NON_PHI",
    "consultation.department.code": "NON_PHI",
    "consultation.department.name": "NON_PHI",
    "consultation.language": "NON_PHI",
    "consultation.outputLanguage": "NON_PHI",
    "consultation.outputLanguage.code": "NON_PHI",
    "consultation.outputLanguage.name": "NON_PHI",
    "consultation.patient": "PHI",
    "consultation.patient.age": "PHI",
    "consultation.patient.gender": "PHI",
    "consultation.patient.dob": "PHI",
    "consultation.clinician": "PHI",
    "consultation.clinician.dna": "PHI",
    "consultation.clinician.dna.style": "NON_PHI",
    "consultation.clinician.dna.rules": "PHI",
    "consultation.transcript": "PHI",
    "consultation.transcript.text": "PHI",
    "consultation.transcript.segments": "PHI",
    "consultation.items": "PHI",
    "consultation.notes": "PHI",
    "consultation.notes.preSummary": "PHI",
    "consultation.notes.summary": "PHI",
    "consultation.vitals": "PHI",
    "consultation.testResults": "PHI",
    "consultation.previousVisits": "PHI",
}

#: The reserved key a deferred binding travels under (finished by the activity envelope).
DEFERRED_KEY = "$hopeBinding"

_MISSING: Any = object()


def is_missing(value: Any) -> bool:
    return value is _MISSING


def phi_class_of(path: str) -> str | None:
    """The PHI class a binding source path carries, when the contract can say."""
    root, _, rest = path.partition(".")
    if root == "consultation":
        return CONSULTATION_PATH_PHI.get(path)
    if root == "run":
        return "NON_PHI"
    if root == "nodes":
        parts = rest.split(".")
        if len(parts) >= 3 and parts[1] == "outputs":
            return OUTPUT_PHI_CLASS.get(parts[2])
    return None


# ---------------------------------------------------------------------------------------------
# NodeIO outputs
# ---------------------------------------------------------------------------------------------


def declared_output_fields(node_type: str, task: str | None = None) -> tuple[str, ...]:
    if node_type == "core.agent" and task in AGENT_TASK_OUTPUT_FIELDS:
        return AGENT_TASK_OUTPUT_FIELDS[task]
    return NODE_OUTPUT_FIELDS.get(node_type, ())


def outputs_view(
    node_type: str,
    legacy: Mapping[str, Any] | None,
    *,
    task: str | None = None,
    router_input: Any = _MISSING,
) -> dict[str, Any]:
    """The node's NodeIO ``outputs``, projected from its stored (legacy) output.

    A field is present only when the node produced it — absent is "no value", never ``None``.
    """
    stored = legacy if isinstance(legacy, Mapping) else {}
    view: dict[str, Any] = {}
    for name in declared_output_fields(node_type, task):
        if name in stored:
            view[name] = stored[name]
    if node_type == "core.agent" and "entities" not in view:
        data = stored.get("data")
        if (task in (None, "NAMED_ENTITY_RECOGNITION")) and isinstance(data, dict):
            if "entities" in data:
                view["entities"] = data["entities"]
    if node_type == "core.agent" and task == "NAMED_ENTITY_RECOGNITION":
        view.pop("data", None)
    if node_type in ROUTER_NODE_TYPES and router_input is not _MISSING:
        view["input"] = router_input
    return view


# ---------------------------------------------------------------------------------------------
# The binding resolver
# ---------------------------------------------------------------------------------------------


@dataclass
class BindingScope:
    """What a binding may read, for ONE node, at ONE moment. All pure data.

    ``nodes`` holds the stored (legacy) outputs by node id; ``node_tasks`` the agent task of each
    ``core.agent`` that reported one; ``router_inputs`` what each router was handed on ``in``.
    ``consultation`` is keyed by full path (``consultation.patient.age``) — exactly the values the
    node's declared reads returned. ``loop_item`` is set inside a loop body: ``(loop node id,
    current item)``.
    """

    context: Any = None
    nodes: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    node_types: Mapping[str, str] = field(default_factory=dict)
    node_tasks: Mapping[str, str] = field(default_factory=dict)
    router_inputs: Mapping[str, Any] = field(default_factory=dict)
    vars: Mapping[str, Any] = field(default_factory=dict)
    run: Mapping[str, Any] = field(default_factory=dict)
    consultation: Mapping[str, Any] = field(default_factory=dict)
    loop_item: tuple[str, Any] | None = None
    #: The run payload, for a context that is the run-payload sentinel (TASK-1038 R-3).
    run_payload: Any = None


def _deferred(kind: str, **body: Any) -> dict[str, Any]:
    return {DEFERRED_KEY: {"kind": kind, **body}}


def is_deferred(value: Any) -> bool:
    return isinstance(value, dict) and len(value) == 1 and isinstance(value.get(DEFERRED_KEY), dict)


def _walk(base: Any, segments: list[str]) -> Any:
    """Walk ``segments`` from ``base``; a reference on the way DEFERS the rest of the walk."""
    current = base
    for index, segment in enumerate(segments):
        if payload_refs.is_reference(current):
            return _deferred("path", base=current, path=".".join(segments[index:]))
        if not isinstance(current, Mapping) or segment not in current:
            return _MISSING
        current = current[segment]
    return current


def _resolve_context(segments: list[str], scope: BindingScope) -> Any:
    base = scope.context
    if payload_refs.is_run_payload_sentinel(base) and isinstance(scope.run_payload, Mapping):
        base = scope.run_payload
    found = _walk(base, segments)
    # The sole-kind collapse (`bindings.ts`): a context whose only kind is `context` is read as
    # that kind, so `context.safe_age` reaches `{"context": {"safe_age": …}}`.
    if (
        found is _MISSING
        and isinstance(base, Mapping)
        and list(base) == ["context"]
        and segments[:1] != ["context"]
    ):
        found = _walk(base["context"], segments)
    return found


def _resolve_nodes(segments: list[str], scope: BindingScope) -> Any:
    if not segments:
        return _MISSING
    node_id, rest = segments[0], segments[1:]
    if (
        scope.loop_item is not None
        and node_id == scope.loop_item[0]
        and rest[:2]
        == [
            "outputs",
            "item",
        ]
    ):
        return _walk(scope.loop_item[1], rest[2:])
    stored = scope.nodes.get(node_id)
    if stored is None:
        if node_id in scope.router_inputs and rest[:2] == ["outputs", "input"]:
            return _walk(scope.router_inputs[node_id], rest[2:])
        return _MISSING
    if rest[:1] == ["outputs"] and len(rest) >= 2:
        node_type = scope.node_types.get(node_id, "")
        view = outputs_view(
            node_type,
            stored,
            task=scope.node_tasks.get(node_id),
            router_input=scope.router_inputs.get(node_id, _MISSING),
        )
        return _walk(view, rest[1:])
    # The legacy spelling, `nodes.<id>.<key>` — served for one release.
    return _walk(stored, rest)


def resolve_path(path: str, scope: BindingScope) -> Any:
    """One binding path's value, ``_MISSING`` when absent, or a deferred path spec."""
    root, *rest = path.split(".")
    if root == "context":
        return _resolve_context(rest, scope)
    if root == "consultation":
        if path in scope.consultation:
            return scope.consultation[path]
        # A read declared at a container also serves its fields.
        for prefix in sorted(scope.consultation, key=len, reverse=True):
            if path.startswith(prefix + "."):
                return _walk(scope.consultation[prefix], path[len(prefix) + 1 :].split("."))
        return _MISSING
    if root == "nodes":
        return _resolve_nodes(rest, scope)
    if root == "vars":
        return _walk(scope.vars, rest)
    if root == "run":
        return scope.run[rest[0]] if len(rest) == 1 and rest[0] in scope.run else _MISSING
    return _MISSING


def _present(value: Any) -> bool:
    return value is not _MISSING and value is not None


def _contains_deferred(value: Any) -> bool:
    if is_deferred(value) or payload_refs.is_reference(value):
        return True
    if isinstance(value, Mapping):
        return any(_contains_deferred(v) for v in value.values())
    if isinstance(value, list):
        return any(_contains_deferred(v) for v in value)
    return False


def _nest(values: Mapping[str, Any]) -> dict[str, Any]:
    """``{"a.b": 1}`` → ``{"a": {"b": 1}}`` — a render scope from resolved paths."""
    scope: dict[str, Any] = {}
    for path, value in values.items():
        if value is _MISSING:
            continue
        current = scope
        parts = path.split(".")
        for part in parts[:-1]:
            nxt = current.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                current[part] = nxt
            current = nxt
        current[parts[-1]] = value
    return scope


def render_binding_template(template: str, values: Mapping[str, Any]) -> Any:
    """Render a ``{template}`` binding against its resolved paths; ``_MISSING`` when a path
    without ``default(...)`` has no value (the input is then unbound, reported as a warning)."""
    try:
        return render_template(template, _nest(values))
    except (PromptVariableUnresolved, PromptTemplateSyntaxError):
        return _MISSING


def resolve_binding(binding: Mapping[str, Any], scope: BindingScope) -> Any:
    """One compiled binding → its value, ``_MISSING``, or a deferred spec."""
    if "value" in binding and len(binding) == 1:
        return binding["value"]
    if isinstance(binding.get("from"), str):
        return resolve_path(binding["from"], scope)
    if isinstance(binding.get("firstOf"), list):
        candidates: list[Any] = []
        for path in binding["firstOf"]:
            if not isinstance(path, str):
                continue
            value = resolve_path(path, scope)
            if is_deferred(value) or payload_refs.is_reference(value):
                # Present-ness of a value behind a reference is the activity's to decide.
                candidates.append(value)
                continue
            if _present(value):
                if not candidates:
                    return value
                candidates.append(value)
                return _deferred("firstOf", candidates=candidates)
        if not candidates:
            return _MISSING
        return _deferred("firstOf", candidates=candidates)
    if isinstance(binding.get("template"), str):
        template = binding["template"]
        values = {ref.path: resolve_path(ref.path, scope) for ref in template_references(template)}
        if any(_contains_deferred(v) for v in values.values()):
            return _deferred(
                "template",
                template=template,
                values={p: v for p, v in values.items() if v is not _MISSING},
            )
        return render_binding_template(template, values)
    return _MISSING


@dataclass(frozen=True)
class ResolvedBindings:
    #: Bound values by NodeIO input name (a deferred spec where only an activity can finish).
    values: dict[str, Any]
    #: Inputs whose binding resolved to nothing.
    unresolved: list[str]


def resolve_bindings(bindings: Mapping[str, Any], scope: BindingScope) -> ResolvedBindings:
    values: dict[str, Any] = {}
    unresolved: list[str] = []
    for name, binding in bindings.items():
        if not isinstance(binding, Mapping):
            continue
        value = resolve_binding(binding, scope)
        if value is _MISSING:
            unresolved.append(name)
            continue
        values[name] = value
    return ResolvedBindings(values=values, unresolved=unresolved)


def finish_deferred(value: Any, hydrate: Callable[[Any], Any]) -> Any:
    """Finish one deferred binding in the ACTIVITY, after ``hydrate`` has dereferenced its parts.

    ``hydrate`` turns a reference into its value (``activities._resolve_references``). Returns
    ``_MISSING`` when the finished binding has no value.
    """
    if not is_deferred(value):
        return value
    spec = value[DEFERRED_KEY]
    kind = spec.get("kind")
    if kind == "path":
        base = hydrate(spec.get("base"))
        path = spec.get("path") or ""
        return _walk(base, path.split(".")) if path else base
    if kind == "firstOf":
        for candidate in spec.get("candidates") or []:
            finished = finish_deferred(hydrate(candidate), hydrate)
            if _present(finished):
                return finished
        return _MISSING
    if kind == "template":
        values = {
            path: finish_deferred(hydrate(v), hydrate)
            for path, v in (spec.get("values") or {}).items()
        }
        return render_binding_template(str(spec.get("template") or ""), values)
    return _MISSING


# ---------------------------------------------------------------------------------------------
# Binding sources, for the `data.bound` admin event
# ---------------------------------------------------------------------------------------------


def binding_source(binding: Mapping[str, Any]) -> dict[str, Any]:
    """``data.bound``'s ``source``: ``{kind, path?, template?}`` (``firstOf`` reports as ``from``
    with its first path — the event's vocabulary has no coalesce kind)."""
    if isinstance(binding.get("from"), str):
        return {"kind": "from", "path": binding["from"]}
    if isinstance(binding.get("firstOf"), list) and binding["firstOf"]:
        return {"kind": "from", "path": str(binding["firstOf"][0])}
    if isinstance(binding.get("template"), str):
        return {"kind": "template", "template": binding["template"]}
    return {"kind": "value"}


def binding_paths(binding: Mapping[str, Any]) -> list[str]:
    if isinstance(binding.get("from"), str):
        return [binding["from"]]
    if isinstance(binding.get("firstOf"), list):
        return [p for p in binding["firstOf"] if isinstance(p, str)]
    if isinstance(binding.get("template"), str):
        return [ref.path for ref in template_references(binding["template"])]
    return []


# ---------------------------------------------------------------------------------------------
# Delivery (OD-24): which nodes reach the PUBLIC plane
# ---------------------------------------------------------------------------------------------


def end_wired_fields(
    output_bindings: Iterable[Mapping[str, Any]] | None,
    legacy_edges: Iterable[tuple[str, str | None]],
) -> dict[str, set[str]]:
    """``{nodeId: {field, …}}`` — the outputs a ``core.output`` node is wired to.

    From the node's compiled bindings when it has them (``nodes.<id>.outputs.<field>`` and the
    legacy ``nodes.<id>.<key>``), else from its legacy edges ``(fromNodeId, outputKey)``.
    """
    wired: dict[str, set[str]] = {}
    bindings = list(output_bindings or [])
    if bindings:
        for binding in bindings:
            for path in binding_paths(binding):
                parts = path.split(".")
                if parts[0] != "nodes" or len(parts) < 3:
                    continue
                field_name = parts[3] if parts[2] == "outputs" and len(parts) > 3 else parts[2]
                wired.setdefault(parts[1], set()).add(field_name)
        return wired
    for node_id, key in legacy_edges:
        if key is not None:
            wired.setdefault(node_id, set()).add(key)
    return wired
