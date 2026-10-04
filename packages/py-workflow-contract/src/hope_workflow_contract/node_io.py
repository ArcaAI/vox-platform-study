"""TASK-1036 §9.1 (OD-29) — the standard NODE I/O contract, Python mirror of ``node-io.ts``.

Held to ``tests/contracts/node-io.fixture.json``. Field names ARE the runtime keys for every
non-agent node (named after the port ``outputKey`` that carries the value today); ``core.agent``
names its sockets after the agent contract (``agent_node_io(task)``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from hope_workflow_contract.ports import NODE_PORTS, Ports, action_delegate_of

IO_BASE_TYPES: tuple[str, ...] = (
    "text",
    "number",
    "boolean",
    "date",
    "json",
    "audio",
    "file",
    "document",
    "any",
)
IO_ELEMENT_TYPES: tuple[str, ...] = ("entity", "segment")
IO_REFERENCE_TYPES = frozenset({"audio", "file", "document"})

_BASE = frozenset(IO_BASE_TYPES)
_ELEMENT = frozenset(IO_ELEMENT_TYPES)
_JSON_COMPATIBLE = frozenset({"text", "number", "boolean", "date", "json", "entity", "segment"})
_TEXT_CONVERTIBLE = frozenset({"number", "boolean", "date", "json"})


def _list_element(type_: str) -> str | None:
    return type_[5:-1] if type_.startswith("list<") and type_.endswith(">") else None


def is_io_type(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    if value in _BASE:
        return True
    element = _list_element(value)
    return element is not None and len(element) > 0 and (element in _ELEMENT or is_io_type(element))


def _element_fits(target: str, source: str) -> bool:
    if target == source or target == "any":
        return True
    if target == "json":
        return source not in IO_REFERENCE_TYPES and source != "any"
    target_element, source_element = _list_element(target), _list_element(source)
    if target_element is not None and source_element is not None:
        return _element_fits(target_element, source_element)
    return False


def type_fits(target: str, source: str) -> str:
    """``match`` / ``convert`` / ``blocked`` — mirrors ``typeFits``."""
    if not is_io_type(target) or not is_io_type(source):
        return "blocked"
    if target == "any" or target == source:
        return "match"
    target_element, source_element = _list_element(target), _list_element(source)
    if target_element is not None:
        fits = source_element is not None and _element_fits(target_element, source_element)
        return "match" if fits else "blocked"
    if target in IO_REFERENCE_TYPES or source in IO_REFERENCE_TYPES:
        return "blocked"
    if source == "any":
        return "match" if target == "json" else "convert"
    if target == "json":
        return "match" if source_element is not None or source in _JSON_COMPATIBLE else "blocked"
    if target == "text":
        fits = source_element is not None or source in _TEXT_CONVERTIBLE
        return "convert" if fits else "blocked"
    return "blocked"


def io_type_of_json_schema(schema: Any) -> str:
    obj = schema if isinstance(schema, dict) else None
    raw = obj.get("type") if obj else None
    types = [
        t for t in (raw if isinstance(raw, list) else [raw]) if isinstance(t, str) and t != "null"
    ]
    first = types[0] if types else None
    if first == "string":
        return "date" if obj and obj.get("format") in ("date", "date-time") else "text"
    if first in ("integer", "number"):
        return "number"
    if first == "boolean":
        return "boolean"
    if first == "array":
        items = obj.get("items") if obj else None
        return f"list<{'json' if items is None else io_type_of_json_schema(items)}>"
    return "json"


_PORT_PRIMITIVE_IO_TYPE = {
    "stream<audio>": "audio",
    "audio": "audio",
    "transcript": "text",
    "text": "text",
    "object": "json",
    "entities": "list<entity>",
    "document": "text",
    "edits": "json",
    "verdict": "json",
    "context<schemaRef>": "json",
    "any": "any",
}


def _input(type_: str, required: bool, description: str) -> dict[str, Any]:
    return {"type": type_, "required": required, "description": description}


def _output(
    type_: str, description: str, phi_class: str | None = None, schema: Any = None
) -> dict[str, Any]:
    out: dict[str, Any] = {"type": type_, "description": description}
    if phi_class is not None:
        out["phiClass"] = phi_class
    if schema is not None:
        out["schema"] = schema
    return out


def _io(inputs: dict[str, Any], outputs: dict[str, Any]) -> dict[str, Any]:
    return {"inputs": inputs, "outputs": outputs}


_AGENT_FIELDS = {
    "message": _input(
        "text",
        False,
        "The text the agent works on: the user turn, or the document to operate on.",
    ),
    "context": _input(
        "json",
        False,
        "Structured context for the prompt (the run input, or an earlier step`s data).",
    ),
    "audio": _input(
        "audio", True, "The recording to transcribe (a reference, never inline bytes)."
    ),
    "speechText": _input("text", True, "The text to speak."),
    "nerText": _input("text", True, "The document to extract entities from."),
}

_DATA_DESCRIPTION = "The structured result, shaped by the agent`s output schema."

_AGENT_OUTPUTS = {
    "text": _output("text", "The generated text.", "PHI"),
    "transcript": _output("text", "The transcript text, utterances joined in spoken order.", "PHI"),
    "segments": _output(
        "list<segment>",
        "Per-utterance timing, speaker and correlation over the transcript.",
        "PHI",
    ),
    "language": _output(
        "text", "The capture-level language the speech was recognised in.", "NON_PHI"
    ),
    "audio": _output("audio", "The synthesised speech (a reference).", "PHI"),
    "durationMs": _output(
        "number", "Length of the synthesised speech, in milliseconds.", "NON_PHI"
    ),
    "entities": _output(
        "list<entity>",
        "The recognised entities: text, label, character offsets and score.",
        "PHI",
    ),
    "nerText": _output(
        "text",
        "The classified text, passed through so a later step still sees the document.",
        "PHI",
    ),
}


def _is_structured_output(output_schema: Mapping[str, Any] | None) -> bool:
    properties = (
        (output_schema or {}).get("properties") if isinstance(output_schema, dict) else None
    )
    if not isinstance(properties, dict):
        return False
    return any(name != "text" for name in properties)


def agent_node_io(task: str, output_schema: Mapping[str, Any] | None = None) -> dict[str, Any]:
    if task == "TEXT_GENERATION":
        outputs: dict[str, Any] = {"text": _AGENT_OUTPUTS["text"]}
        if _is_structured_output(output_schema):
            outputs["data"] = _output("json", _DATA_DESCRIPTION, "PHI", dict(output_schema or {}))
        return _io(
            {"message": _AGENT_FIELDS["message"], "context": _AGENT_FIELDS["context"]}, outputs
        )
    if task == "SPEECH_TO_TEXT":
        return _io(
            {"audio": _AGENT_FIELDS["audio"]},
            {
                "transcript": _AGENT_OUTPUTS["transcript"],
                "segments": _AGENT_OUTPUTS["segments"],
                "language": _AGENT_OUTPUTS["language"],
            },
        )
    if task == "TEXT_TO_SPEECH":
        return _io(
            {"text": _AGENT_FIELDS["speechText"]},
            {"audio": _AGENT_OUTPUTS["audio"], "durationMs": _AGENT_OUTPUTS["durationMs"]},
        )
    if task == "NAMED_ENTITY_RECOGNITION":
        return _io(
            {"text": _AGENT_FIELDS["nerText"]},
            {"entities": _AGENT_OUTPUTS["entities"], "text": _AGENT_OUTPUTS["nerText"]},
        )
    raise ValueError(f"unknown agent task {task!r}")


def _io_from_ports(ports: Ports, summary: str) -> dict[str, Any]:
    inputs: dict[str, Any] = {}
    for port in ports["inputs"]:
        if port["primitive"] == "control":
            continue
        inputs[port["name"]] = _input(
            _PORT_PRIMITIVE_IO_TYPE[port["primitive"]],
            port["required"],
            f"{summary} — input `{port['name']}` ({port['primitive']}).",
        )
    outputs: dict[str, Any] = {}
    for port in ports["outputs"]:
        key = port.get("outputKey")
        if port["primitive"] == "control" or key is None or key in outputs:
            continue
        outputs[key] = _output(
            _PORT_PRIMITIVE_IO_TYPE[port["primitive"]],
            f"{summary} — output `{key}` ({port['primitive']}).",
        )
    return _io(inputs, outputs)


def action_node_io(action_key: str) -> dict[str, Any] | None:
    delegate = action_delegate_of({"actionKey": action_key})
    return None if delegate is None else _io_from_ports(delegate["ports"], delegate["label"])


NODE_IO: dict[str, dict[str, Any]] = {
    "core.trigger": _io(
        {}, {"context": _output("json", "The validated run input (the Input shape).", "PHI")}
    ),
    "core.agent": _io(
        {
            "message": _input("text", False, _AGENT_FIELDS["message"]["description"]),
            "context": _AGENT_FIELDS["context"],
            "audio": _input("audio", False, _AGENT_FIELDS["audio"]["description"]),
            "text": _input(
                "text", False, "The text to speak (speech) or classify (entity recognition)."
            ),
        },
        {
            "text": _AGENT_OUTPUTS["text"],
            "data": _output("json", _DATA_DESCRIPTION, "PHI"),
            "transcript": _AGENT_OUTPUTS["transcript"],
            "segments": _AGENT_OUTPUTS["segments"],
            "language": _AGENT_OUTPUTS["language"],
            "audio": _AGENT_OUTPUTS["audio"],
            "durationMs": _AGENT_OUTPUTS["durationMs"],
            "entities": _AGENT_OUTPUTS["entities"],
        },
    ),
    "core.classify": _io(
        {
            "in": _input(
                "any",
                True,
                "What to classify: a transcript, a generated text, or a structured value.",
            )
        },
        {
            "classification": _output("json", "The class taken and its score.", "NON_PHI"),
            "input": _output(
                "any", "The classified input, carried through to the branch taken (OD-19)."
            ),
        },
    ),
    "core.humanReview": _io(
        {"in": _input("any", False, "What the reviewer is shown.")},
        {
            "decision": _output(
                "json", "The review outcome, reviewer, comment and any edited payload.", "PHI"
            )
        },
    ),
    "core.variable": _io(
        {"set": _input("json", False, "Values to merge into the run variables.")},
        {"vars": _output("json", "The run variables after this step.")},
    ),
    "core.condition": _io(
        {
            "in": _input(
                "any",
                False,
                "The value the conditions read (they may also read the run context).",
            )
        },
        {
            "evaluation": _output(
                "json", "Which branch was taken and whether a condition matched.", "NON_PHI"
            ),
            "input": _output(
                "any", "The router`s input, carried through to the branch taken (OD-19)."
            ),
        },
    ),
    "core.loop": _io(
        {"in": _input("any", False, "The list to iterate.")},
        {
            "item": _output("any", "The current item, inside the loop body."),
            "result": _output("json", "What the loop collected when it finished."),
        },
    ),
    "core.note": _io({}, {}),
    "core.output": _io(
        {"in": _input("any", False, "The workflow result, validated against the Output shape.")},
        {},
    ),
    "core.data": _io(
        {"in": _input("json", True, "The value to reshape.")},
        {
            "data": _output("json", "The reshaped value."),
            "text": _output("text", "The reshaped value`s `text` field, when it is text."),
        },
    ),
    "core.action": _io_from_ports(NODE_PORTS["core.action"], "Platform action"),
}


def _slug_of(config: Mapping[str, Any] | None) -> str | None:
    ref = (config or {}).get("agentRef")
    slug = ref.get("slug") if isinstance(ref, dict) else None
    return slug if isinstance(slug, str) else None


def agent_task_of(
    config: Mapping[str, Any] | None, agents: Mapping[str, Any] | None = None
) -> str | None:
    slug = _slug_of(config)
    if slug is None or not agents:
        return None
    resolved = agents.get(slug)
    task = resolved.get("task") if isinstance(resolved, dict) else None
    return task if isinstance(task, str) else None


def node_io_for(
    node: Mapping[str, Any], agents: Mapping[str, Any] | None = None
) -> dict[str, Any] | None:
    """The EXACT I/O of one node instance (an agent by its task, an action by its key)."""
    node_type = node.get("type")
    config = node.get("config") if isinstance(node.get("config"), dict) else None
    if node_type == "core.agent":
        slug = _slug_of(config)
        resolved = (agents or {}).get(slug) if slug is not None else None
        if isinstance(resolved, dict) and isinstance(resolved.get("task"), str):
            return agent_node_io(resolved["task"], resolved.get("outputSchema"))
    if node_type == "core.action":
        key = (config or {}).get("actionKey")
        exact = action_node_io(key) if isinstance(key, str) else None
        if exact is not None:
            return exact
    return NODE_IO.get(node_type) if isinstance(node_type, str) else None
