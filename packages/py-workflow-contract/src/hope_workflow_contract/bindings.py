"""TASK-1036 §9.2 (OD-29, OD-18) — DATA MOVES BY BINDINGS. Python mirror of ``bindings.ts``.

A node's declared input has at most one binding (``{from}`` / ``{value}`` / ``{template}`` /
``{firstOf}``) authored as ``config.inputs[<name>]``; a legacy graph's data edges translate to
``nodes.<from>.outputs.<outputKey>`` (fan-in → ``firstOf``, the producer that would have won
today first). ``compiled_bindings`` and ``binding_issues`` are held to
``tests/contracts/bindings.fixture.json`` with the TypeScript originals.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from hope_workflow_contract.consultation_read_schema import (
    CONSULTATION_ROOT,
    consultation_path_info,
    node_consultation_reads,
)
from hope_workflow_contract.node_io import (
    agent_task_of,
    io_type_of_json_schema,
    node_io_for,
    type_fits,
)
from hope_workflow_contract.ports import resolve_input_port, resolve_output_port
from hope_workflow_contract.template import template_references
from hope_workflow_contract.workflow_settings import effective_settings

BINDING_ROOTS: tuple[str, ...] = ("context", "consultation", "nodes", "vars", "run")
BINDING_FIRST_OF_MAX_PATHS = 8

RUN_SCOPE_FIELDS: dict[str, dict[str, str]] = {
    "id": {"type": "text", "description": "This run`s id."},
    "tenantId": {"type": "text", "description": "The tenant the run belongs to."},
    "workflowSlug": {"type": "text", "description": "The workflow`s slug."},
    "workflowVersion": {"type": "number", "description": "The published version number running."},
    "startedAt": {"type": "date", "description": "When the run started."},
    "now": {"type": "date", "description": "The time this step started."},
}


def _obj(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def is_binding(value: Any) -> bool:
    """Exactly one of the four closed shapes."""
    obj = _obj(value)
    if obj is None:
        return False
    keys = list(obj)
    if keys == ["value"]:
        return True
    if keys == ["template"]:
        return isinstance(obj["template"], str)
    if keys == ["firstOf"]:
        paths = obj["firstOf"]
        return (
            isinstance(paths, list)
            and 2 <= len(paths) <= BINDING_FIRST_OF_MAX_PATHS
            and all(isinstance(p, str) and p for p in paths)
        )
    if "from" in keys:
        if not isinstance(obj["from"], str) or not obj["from"]:
            return False
        if not all(k in ("from", "at") for k in keys):
            return False
        return "at" not in obj or obj["at"] in ("nodeStart", "runStart")
    return False


# ---------------------------------------------------------------------------------------------
# Graph helpers
# ---------------------------------------------------------------------------------------------


def _live_nodes(graph: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        n
        for n in graph.get("nodes") or []
        if isinstance(n, dict)
        and isinstance(n.get("id"), str)
        and isinstance(n.get("type"), str)
        and n["type"] != "core.note"
    ]


def _config(node: Mapping[str, Any]) -> dict[str, Any] | None:
    return _obj(node.get("config"))


def edge_ancestors(graph: Mapping[str, Any], node_id: str) -> set[str]:
    """Every node with an edge path INTO ``node_id`` (any edge), excluding itself."""
    reverse: dict[str, list[str]] = {}
    for edge in graph.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        if not isinstance(edge.get("from"), str) or not isinstance(edge.get("to"), str):
            continue
        reverse.setdefault(edge["to"], []).append(edge["from"])
    seen: set[str] = set()
    queue = deque(reverse.get(node_id, []))
    while queue:
        current = queue.popleft()
        if current in seen or current == node_id:
            continue
        seen.add(current)
        queue.extend(reverse.get(current, []))
    return seen


def legacy_input_name(
    node: Mapping[str, Any], to_port: str, agents: Mapping[str, Any] | None
) -> str:
    if node.get("type") != "core.agent" or to_port != "in":
        return to_port
    task = agent_task_of(_config(node), agents)
    return "text" if task in ("TEXT_TO_SPEECH", "NAMED_ENTITY_RECOGNITION") else "message"


@dataclass(frozen=True)
class _EdgeProducer:
    path: str
    to_port: str
    from_node_id: str
    edge_id: Any


def _edge_producers(
    graph: Mapping[str, Any], node: Mapping[str, Any], agents: Mapping[str, Any] | None
) -> dict[str, list[_EdgeProducer]]:
    nodes_by_id = {n["id"]: n for n in _live_nodes(graph)}
    groups: dict[str, list[_EdgeProducer]] = {}
    for edge in graph.get("edges") or []:
        if not isinstance(edge, dict) or edge.get("to") != node["id"]:
            continue
        producer = nodes_by_id.get(str(edge.get("from")))
        if producer is None:
            continue
        out = resolve_output_port(producer["type"], _config(producer), str(edge.get("fromPort")))
        if out is None or out["primitive"] == "control" or "outputKey" not in out:
            continue
        into = resolve_input_port(node["type"], _config(node), str(edge.get("toPort")))
        if into is None or into["primitive"] == "control":
            continue
        name = legacy_input_name(node, str(edge.get("toPort")), agents)
        groups.setdefault(name, []).append(
            _EdgeProducer(
                path=f"nodes.{edge['from']}.outputs.{out['outputKey']}",
                to_port=str(edge.get("toPort")),
                from_node_id=str(edge["from"]),
                edge_id=edge.get("id"),
            )
        )
    return groups


def _first_of_order(producers: Sequence[_EdgeProducer]) -> list[str]:
    ordered = sorted(producers, key=lambda p: (p.to_port, p.from_node_id))
    paths: list[str] = []
    for producer in reversed(ordered):
        if producer.path not in paths:
            paths.append(producer.path)
    return paths


def edge_implied_bindings(
    graph: Mapping[str, Any], node_id: str, agents: Mapping[str, Any] | None = None
) -> dict[str, dict[str, Any]]:
    node = next((n for n in _live_nodes(graph) if n["id"] == node_id), None)
    if node is None:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, producers in _edge_producers(graph, node, agents).items():
        paths = _first_of_order(producers)
        out[name] = {"from": paths[0]} if len(paths) == 1 else {"firstOf": paths}
    return out


def _authored_inputs(node: Mapping[str, Any]) -> dict[str, Any] | None:
    return _obj((_config(node) or {}).get("inputs"))


def compiled_bindings(
    graph: Mapping[str, Any], agents: Mapping[str, Any] | None = None
) -> dict[str, dict[str, Any]]:
    """Every node's EFFECTIVE bindings (edge-implied, overlaid by the authored ``inputs``)."""
    out: dict[str, dict[str, Any]] = {}
    for node in _live_nodes(graph):
        bindings = dict(edge_implied_bindings(graph, node["id"], agents))
        for name, binding in (_authored_inputs(node) or {}).items():
            if is_binding(binding):
                bindings[name] = binding
        if bindings:
            out[node["id"]] = bindings
    return out


# ---------------------------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class BindingIssue:
    code: str
    severity: str
    node_id: str
    path: str
    message: str
    input: str | None = None


@dataclass(frozen=True)
class _Resolved:
    type: str
    phi_class: str | None


@dataclass(frozen=True)
class _Unresolved:
    code: str
    message: str


def _admits_more(level: Mapping[str, Any]) -> bool:
    return level.get("additionalProperties") is True or isinstance(
        level.get("additionalProperties"), dict
    )


def _walk_schema(schema: Any, segments: Sequence[str], walk: str) -> Any:
    """``{"schema": …}`` / ``"unknown"`` / ``"open"`` — mirrors ``walkSchema``."""
    current = _obj(schema)
    for segment in segments:
        if current is None:
            return "open"
        properties = _obj(current.get("properties"))
        if properties is not None and segment in properties:
            current = _obj(properties[segment])
            continue
        if walk == "strict":
            return "open" if _admits_more(current) else "unknown"
        if walk == "declared":
            if properties is None:
                return "unknown" if current.get("additionalProperties") is False else "open"
            return "open" if _admits_more(current) else "unknown"
        return (
            "unknown"
            if properties is not None and current.get("additionalProperties") is False
            else "open"
        )
    return "open" if current is None else {"schema": current}


@dataclass(frozen=True)
class _DeclaredVar:
    type: str
    node_ids: tuple[str, ...]


@dataclass
class _Scope:
    nodes_by_id: dict[str, dict[str, Any]]
    ancestors: set[str]
    vars: dict[str, _DeclaredVar]
    agents: Mapping[str, Any] | None
    context_payload_schema: Any


def _label(node: Mapping[str, Any]) -> str:
    named = (_config(node) or {}).get("label")
    return f'"{named}" (`{node["id"]}`)' if isinstance(named, str) and named else f"`{node['id']}`"


def _is_stream_audio_payload(schema: Any) -> bool:
    """TASK-1042 — mirrors ``isStreamAudioPayload``: an object whose ONLY declared property is the
    string ``sttSessionId`` is a live audio session, read by a binding as ``audio``."""
    obj = _obj(schema)
    properties = _obj(obj.get("properties")) if obj is not None else None
    if obj is None or properties is None or obj.get("type") != "object":
        return False
    session = _obj(properties.get("sttSessionId"))
    return (
        list(properties.keys()) == ["sttSessionId"]
        and session is not None
        and session.get("type") == "string"
    )


def _resolve_context_path(segments: list[str], payload_schema: Any, path: str) -> Any:
    if _obj(payload_schema) is None:
        return _Resolved("json" if not segments else "any", None)
    walked = _walk_schema(payload_schema, segments, "declared")
    properties = _obj(payload_schema.get("properties"))
    if (
        walked == "unknown"
        and properties is not None
        and len(properties) == 1
        and "context" in properties
    ):
        walked = _walk_schema(properties["context"], segments, "declared")
    if walked == "unknown":
        return _Unresolved(
            "BINDING_UNKNOWN_PATH", f"`{path}` is not declared by this workflow's context schema."
        )
    if walked != "open" and _is_stream_audio_payload(walked["schema"]):
        return _Resolved("audio", None)
    return _Resolved("any" if walked == "open" else io_type_of_json_schema(walked["schema"]), None)


def _resolve_node_path(segments: list[str], scope: _Scope, path: str) -> Any:
    node_id = segments[0] if segments else None
    outputs = segments[1] if len(segments) > 1 else None
    field = segments[2] if len(segments) > 2 else None
    rest = segments[3:]
    producer = scope.nodes_by_id.get(node_id) if node_id is not None else None
    if producer is None:
        return _Unresolved(
            "BINDING_UNKNOWN_PATH",
            f"`{path}`: there is no step `{node_id or ''}` in this workflow.",
        )
    if producer["id"] not in scope.ancestors:
        return _Unresolved(
            "BINDING_NOT_ANCESTOR",
            f"`{path}`: step {_label(producer)} does not run before this step, so its output is "
            "not available here. Connect it upstream first.",
        )
    if outputs != "outputs" or field is None:
        return _Unresolved(
            "BINDING_UNKNOWN_PATH",
            f"`{path}`: a step's data is read from its `outputs` — "
            f"`nodes.{producer['id']}.outputs.<field>`.",
        )
    io = node_io_for(producer, scope.agents)
    declared = (io or {}).get("outputs", {}).get(field)
    if declared is None:
        offered = list((io or {}).get("outputs", {}))
        named = ", ".join(f"`{n}`" for n in offered) if offered else "nothing"
        return _Unresolved(
            "BINDING_UNKNOWN_PATH",
            f"`{path}`: step {_label(producer)} does not output `{field}` (it outputs {named}).",
        )
    phi = declared.get("phiClass")
    if not rest:
        return _Resolved(declared["type"], phi)
    if "schema" in declared:
        walked = _walk_schema(declared["schema"], rest, "strict")
        if walked == "unknown":
            return _Unresolved(
                "BINDING_UNKNOWN_PATH",
                f"`{path}`: `{'.'.join(rest)}` is not a field of {_label(producer)}'s `{field}`.",
            )
        return _Resolved(
            "any" if walked == "open" else io_type_of_json_schema(walked["schema"]), phi
        )
    if declared["type"] in ("json", "any"):
        return _Resolved("any", phi)
    return _Unresolved(
        "BINDING_UNKNOWN_PATH",
        f"`{path}`: `{field}` is {declared['type']}, which has no fields to read.",
    )


def _resolve_path(path: str, scope: _Scope) -> Any:
    root, *rest = path.split(".")
    if root == "context":
        return _resolve_context_path(rest, scope.context_payload_schema, path)
    if root == CONSULTATION_ROOT:
        found = consultation_path_info(path)
        if found is None:
            return _Unresolved(
                "BINDING_UNKNOWN_PATH", f"`{path}` is not a field of the consultation read schema."
            )
        return _Resolved(found["type"], found["phiClass"])
    if root == "nodes":
        return _resolve_node_path(rest, scope, path)
    if root == "vars":
        key = rest[0] if rest else None
        declared_var = scope.vars.get(key) if key is not None else None
        if declared_var is None:
            return _Unresolved(
                "BINDING_UNKNOWN_PATH", f"`{path}`: no `core.variable` step declares `{key or ''}`."
            )
        if not any(i in scope.ancestors for i in declared_var.node_ids):
            setters = [
                scope.nodes_by_id[i] for i in declared_var.node_ids if i in scope.nodes_by_id
            ]
            return _Unresolved(
                "BINDING_NOT_ANCESTOR",
                f"`{path}` is set by {', '.join(_label(s) for s in setters)}, which does not run "
                "before this step. Connect it upstream first.",
            )
        return _Resolved("any" if len(rest) > 1 else declared_var.type, None)
    if root == "run":
        field = RUN_SCOPE_FIELDS.get(rest[0]) if len(rest) == 1 else None
        if field is None:
            fields = ", ".join(f"`run.{n}`" for n in RUN_SCOPE_FIELDS)
            return _Unresolved("BINDING_UNKNOWN_PATH", f"`{path}` is not a run field ({fields}).")
        return _Resolved(field["type"], "NON_PHI")
    roots = ", ".join(f"`{n}`" for n in BINDING_ROOTS)
    return _Unresolved(
        "BINDING_UNKNOWN_PATH", f"`{path}`: `{root}` is not a binding root ({roots})."
    )


def _literal_type(value: Any) -> str:
    if isinstance(value, str):
        return "text"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "list<json>"
    return "json"


def _declared_vars(nodes: Sequence[Mapping[str, Any]]) -> dict[str, _DeclaredVar]:
    out: dict[str, _DeclaredVar] = {}
    for node in nodes:
        if node["type"] != "core.variable":
            continue
        declared = (_config(node) or {}).get("variables")
        for entry in declared if isinstance(declared, list) else []:
            variable = _obj(entry)
            if variable is None or not isinstance(variable.get("key"), str):
                continue
            type_ = (
                "any" if "schema" not in variable else io_type_of_json_schema(variable["schema"])
            )
            previous = out.get(variable["key"])
            out[variable["key"]] = _DeclaredVar(
                type_, (*(previous.node_ids if previous else ()), node["id"])
            )
    return out


# ---------------------------------------------------------------------------------------------
# The publish rules
# ---------------------------------------------------------------------------------------------


def _check_type(
    issues: list[BindingIssue],
    node: Mapping[str, Any],
    name: str,
    pointer: str,
    target: str,
    source: str,
    what: str,
) -> None:
    fit = type_fits(target, source)
    if fit == "match":
        return
    if fit == "convert":
        issues.append(
            BindingIssue(
                "BINDING_TYPE_CONVERTED",
                "INFO",
                node["id"],
                pointer,
                f"`{name}` takes {target}; {what} is {source} and will be formatted as {target}.",
                name,
            )
        )
        return
    issues.append(
        BindingIssue(
            "BINDING_TYPE_MISMATCH",
            "ERROR",
            node["id"],
            pointer,
            f"`{name}` takes {target}, and {what} is {source}, which cannot be used here.",
            name,
        )
    )


def _check_authored_node(
    issues: list[BindingIssue],
    node: Mapping[str, Any],
    inputs: Mapping[str, Any],
    scope: _Scope,
    io: Mapping[str, Any] | None,
) -> None:
    for name, binding in inputs.items():
        pointer = f"/inputs/{name}"
        declared = io["inputs"].get(name) if io is not None else None
        if io is not None and declared is None:
            offered = ", ".join(f"`{n}`" for n in io["inputs"]) or "none"
            issues.append(
                BindingIssue(
                    "BINDING_UNKNOWN_INPUT",
                    "ERROR",
                    node["id"],
                    pointer,
                    f"step {_label(node)} has no input `{name}` (its inputs are {offered}).",
                    name,
                )
            )
            continue
        if not is_binding(binding):
            continue
        target = declared["type"] if declared else "any"
        if "from" in binding:
            resolved = _resolve_path(binding["from"], scope)
            if isinstance(resolved, _Unresolved):
                issues.append(
                    BindingIssue(
                        resolved.code,
                        "ERROR",
                        node["id"],
                        f"{pointer}/from",
                        resolved.message,
                        name,
                    )
                )
                continue
            _check_type(
                issues, node, name, f"{pointer}/from", target, resolved.type, f"`{binding['from']}`"
            )
        elif "firstOf" in binding:
            for index, path in enumerate(binding["firstOf"]):
                at = f"{pointer}/firstOf/{index}"
                resolved = _resolve_path(path, scope)
                if isinstance(resolved, _Unresolved):
                    issues.append(
                        BindingIssue(resolved.code, "ERROR", node["id"], at, resolved.message, name)
                    )
                    continue
                _check_type(issues, node, name, at, target, resolved.type, f"`{path}`")
        elif "template" in binding:
            broken = False
            for reference in template_references(binding["template"]):
                resolved = _resolve_path(reference.path, scope)
                if isinstance(resolved, _Unresolved):
                    issues.append(
                        BindingIssue(
                            resolved.code,
                            "ERROR",
                            node["id"],
                            f"{pointer}/template",
                            resolved.message,
                            name,
                        )
                    )
                    broken = True
            if not broken:
                _check_type(issues, node, name, f"{pointer}/template", target, "text", "a template")
        else:
            _check_type(
                issues,
                node,
                name,
                f"{pointer}/value",
                target,
                _literal_type(binding["value"]),
                "the literal value",
            )


def _check_edge_producers(
    issues: list[BindingIssue],
    graph: Mapping[str, Any],
    node: Mapping[str, Any],
    authored: Mapping[str, Any] | None,
    agents: Mapping[str, Any] | None,
) -> None:
    for name, producers in _edge_producers(graph, node, agents).items():
        if authored is not None and name in authored:
            continue
        paths = _first_of_order(producers)
        if len(paths) < 2:
            continue
        issues.append(
            BindingIssue(
                "INPUT_MULTIPLE_PRODUCERS",
                "WARNING" if authored is None else "ERROR",
                node["id"],
                f"/inputs/{name}",
                f"`{name}` of step {_label(node)} is fed by {len(paths)} steps; only one value "
                "can arrive.",
                name,
            )
        )


def _check_required(
    issues: list[BindingIssue],
    graph: Mapping[str, Any],
    node: Mapping[str, Any],
    authored: Mapping[str, Any],
    io: Mapping[str, Any] | None,
    agents: Mapping[str, Any] | None,
) -> None:
    if io is None:
        return
    edge_bound = set(_edge_producers(graph, node, agents))
    for name, declared in io["inputs"].items():
        if not declared["required"] or name in authored or name in edge_bound:
            continue
        issues.append(
            BindingIssue(
                "REQUIRED_INPUT_UNBOUND",
                "ERROR",
                node["id"],
                f"/inputs/{name}",
                f"step {_label(node)} needs `{name}` ({declared['type']}): choose where it comes "
                "from.",
                name,
            )
        )


def _check_prompt_variable_nodes(
    issues: list[BindingIssue], node: Mapping[str, Any], scope: _Scope
) -> None:
    overrides = _obj((_config(node) or {}).get("overrides"))
    prompt_variables = _obj((overrides or {}).get("promptVariables"))
    for key, value in (prompt_variables or {}).items():
        if not isinstance(value, str) or "{{" not in value:
            continue
        pointer = f"/overrides/promptVariables/{key}"
        for reference in template_references(value):
            segments = reference.path.split(".")
            root = segments[0]
            if root == "nodes" and (len(segments) < 3 or segments[2] != "outputs"):
                producer_id = segments[1] if len(segments) > 1 else None
                producer = scope.nodes_by_id.get(producer_id) if producer_id else None
                if producer is None:
                    issues.append(
                        BindingIssue(
                            "BINDING_UNKNOWN_PATH",
                            "ERROR",
                            node["id"],
                            pointer,
                            f"`{reference.path}`: there is no step `{producer_id or ''}` in this "
                            "workflow.",
                        )
                    )
                elif producer["id"] not in scope.ancestors:
                    issues.append(
                        BindingIssue(
                            "BINDING_NOT_ANCESTOR",
                            "ERROR",
                            node["id"],
                            pointer,
                            f"`{reference.path}`: step {_label(producer)} does not run before this "
                            "step.",
                        )
                    )
                continue
            if root not in ("nodes", CONSULTATION_ROOT):
                continue
            resolved = _resolve_path(reference.path, scope)
            if isinstance(resolved, _Unresolved):
                issues.append(
                    BindingIssue(resolved.code, "ERROR", node["id"], pointer, resolved.message)
                )


def _check_agent_nothing_bound(
    issues: list[BindingIssue],
    graph: Mapping[str, Any],
    node: Mapping[str, Any],
    authored: Mapping[str, Any] | None,
    agents: Mapping[str, Any] | None,
) -> None:
    if node["type"] != "core.agent" or agent_task_of(_config(node), agents) != "TEXT_GENERATION":
        return
    bound = set(authored or {}) | set(_edge_producers(graph, node, agents))
    if "message" in bound or "context" in bound:
        return
    overrides = _obj((_config(node) or {}).get("overrides"))
    prompt_variables = _obj((overrides or {}).get("promptVariables"))
    if prompt_variables:
        return
    issues.append(
        BindingIssue(
            "AGENT_NOTHING_BOUND",
            "WARNING",
            node["id"],
            "/inputs",
            f"text agent step {_label(node)} has nothing to work on: bind its `message` or "
            "`context`, or set a prompt variable. As it is, it runs on its prompt alone.",
        )
    )


def binding_issues(
    graph: Mapping[str, Any],
    *,
    agents: Mapping[str, Any] | None = None,
    context_payload_schema: Any = None,
    sources: Sequence[str] | None = None,
) -> list[BindingIssue]:
    """Every binding problem in the graph, ERROR / WARNING / INFO (mirrors ``bindingIssues``)."""
    issues: list[BindingIssue] = []
    nodes = _live_nodes(graph)
    nodes_by_id = {n["id"]: n for n in nodes}
    variables = _declared_vars(nodes)
    source_set = set(sources if sources is not None else effective_settings(graph)["sources"])
    for node in nodes:
        scope = _Scope(
            nodes_by_id=nodes_by_id,
            ancestors=edge_ancestors(graph, node["id"]),
            vars=variables,
            agents=agents,
            context_payload_schema=context_payload_schema,
        )
        authored = _authored_inputs(node)
        io = node_io_for(node, agents)
        if authored is not None:
            _check_authored_node(issues, node, authored, scope, io)
            _check_required(issues, graph, node, authored, io, agents)
        _check_edge_producers(issues, graph, node, authored, agents)
        _check_prompt_variable_nodes(issues, node, scope)
        _check_agent_nothing_bound(issues, graph, node, authored, agents)
        if "consultation" not in source_set:
            reads = node_consultation_reads(_config(node))
            if reads:
                issues.append(
                    BindingIssue(
                        "CONSULTATION_SCOPE_UNAVAILABLE",
                        "ERROR",
                        node["id"],
                        "/inputs",
                        f"step {_label(node)} reads consultation data, but this workflow is not "
                        "started by a consultation.",
                    )
                )
    return issues
