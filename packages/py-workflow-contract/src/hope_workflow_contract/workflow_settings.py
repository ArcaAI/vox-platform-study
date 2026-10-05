"""TASK-1036 §3.5 — workflow settings, Python mirror of ``workflow-settings.ts``.

``effective_settings`` reads ``graph.settings`` first and otherwise derives them from the legacy
trigger ``kinds`` / output ``protocols`` (D-4, one release). Held to
``tests/contracts/workflow-settings.fixture.json``.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from hope_workflow_contract.node_io import agent_task_of

WORKFLOW_CONNECTIONS: tuple[str, ...] = ("api", "webhook", "sse", "socket")
WORKFLOW_SOURCES: tuple[str, ...] = ("consultation", "schedule")

_LEGACY_PROTOCOL_CONNECTION = {"http": "api", "http-sse": "sse", "socket": "socket"}
_LEGACY_DEFAULT_PROTOCOLS = ("http-sse",)


def _obj(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _js(value: Any) -> str:
    """``JSON.stringify`` for the scalar values a problem message quotes."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _enum_list_problems(value: Any, pointer: str, allowed: Sequence[str]) -> list[str]:
    if not isinstance(value, list):
        return [f"{pointer}: must be an array"]
    problems: list[str] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, str) or entry not in allowed:
            names = ", ".join(_js(name) for name in allowed)
            problems.append(f"{pointer}/{index}: must be one of {names} (got {_js(entry)})")
    hashable = [json.dumps(v, sort_keys=True) for v in value]
    if len(set(hashable)) != len(value):
        problems.append(f"{pointer}: must not repeat a value")
    return problems


def _context_schema_problems(value: Any, pointer: str) -> list[str]:
    obj = _obj(value)
    if obj is None:
        return [f"{pointer}: must be an object"]
    by_ref = "contextSchemaId" in obj
    inline = "inline" in obj
    if by_ref == inline:
        return [
            f"{pointer}: must be exactly one of "
            "{ contextSchemaId, versionNumber } or { inline }"
        ]
    problems: list[str] = []
    if inline:
        for key in obj:
            if key != "inline":
                problems.append(f"{pointer}/{key}: is not a property of an inline context schema")
        if _obj(obj["inline"]) is None:
            problems.append(f"{pointer}/inline: must be a JSON Schema object")
        return problems
    for key in obj:
        if key not in ("contextSchemaId", "versionNumber"):
            problems.append(f"{pointer}/{key}: is not a property of a context schema reference")
    schema_id = obj.get("contextSchemaId")
    if not isinstance(schema_id, str) or not schema_id:
        problems.append(f"{pointer}/contextSchemaId: must be a non-empty string")
    version = obj.get("versionNumber")
    valid_version = (
        isinstance(version, (int, float))
        and not isinstance(version, bool)
        and float(version).is_integer()
        and version >= 1
    )
    if version is not None and not valid_version:
        problems.append(
            f"{pointer}/versionNumber: must be an integer >= 1, "
            "or null to follow the latest version"
        )
    return problems


def workflow_settings_problems(value: Any) -> list[str]:
    """Every way ``value`` fails to be a ``WorkflowSettings`` (graph-rooted pointers)."""
    obj = _obj(value)
    if obj is None:
        return ["/settings: must be an object"]
    problems: list[str] = []
    for key in obj:
        if key not in ("connections", "sources", "contextSchema"):
            problems.append(f"/settings/{key}: is not a workflow setting")
    problems.extend(
        _enum_list_problems(obj.get("connections"), "/settings/connections", WORKFLOW_CONNECTIONS)
    )
    problems.extend(_enum_list_problems(obj.get("sources"), "/settings/sources", WORKFLOW_SOURCES))
    if "contextSchema" in obj:
        problems.extend(_context_schema_problems(obj["contextSchema"], "/settings/contextSchema"))
    return problems


def _ordered(values: Iterable[Any], vocabulary: Sequence[str]) -> list[str]:
    present = set(v for v in values if isinstance(v, str))
    return [name for name in vocabulary if name in present]


def _node_config(graph: Mapping[str, Any], node_type: str) -> dict[str, Any] | None:
    for node in graph.get("nodes") or []:
        if isinstance(node, dict) and node.get("type") == node_type:
            return _obj(node.get("config")) or {}
    return None


def _version_or_null(value: Any) -> Any:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _trigger_context_schema(graph: Mapping[str, Any]) -> dict[str, Any] | None:
    authored = _obj((_node_config(graph, "core.trigger") or {}).get("contextSchema"))
    if authored is None:
        return None
    schema_id = authored.get("contextSchemaId")
    if isinstance(schema_id, str) and schema_id:
        return {
            "contextSchemaId": schema_id,
            "versionNumber": _version_or_null(authored.get("versionNumber")),
        }
    inline = _obj(authored.get("inline"))
    return None if inline is None else {"inline": inline}


def _normalise_context_schema(value: Any) -> dict[str, Any] | None:
    obj = _obj(value)
    if obj is None:
        return None
    if isinstance(obj.get("contextSchemaId"), str):
        return {
            "contextSchemaId": obj["contextSchemaId"],
            "versionNumber": _version_or_null(obj.get("versionNumber")),
        }
    inline = _obj(obj.get("inline"))
    return None if inline is None else {"inline": inline}


def effective_settings(graph: Mapping[str, Any]) -> dict[str, Any]:
    raw = graph.get("settings") if isinstance(graph, Mapping) else None
    if raw is not None and not workflow_settings_problems(raw):
        return {
            "connections": _ordered(raw["connections"], WORKFLOW_CONNECTIONS),
            "sources": _ordered(raw["sources"], WORKFLOW_SOURCES),
            "contextSchema": _normalise_context_schema(raw.get("contextSchema"))
            or _trigger_context_schema(graph),
            "origin": "settings",
        }
    kinds = (_node_config(graph, "core.trigger") or {}).get("kinds")
    kind_list = [k for k in kinds if isinstance(k, str)] if isinstance(kinds, list) else []
    output = _node_config(graph, "core.output")
    if output is None:
        protocols: list[Any] = []
    elif isinstance(output.get("protocols"), list):
        protocols = output["protocols"]
    else:
        protocols = list(_LEGACY_DEFAULT_PROTOCOLS)
    connections = [
        *kind_list,
        *(
            _LEGACY_PROTOCOL_CONNECTION[p]
            for p in protocols
            if isinstance(p, str) and p in _LEGACY_PROTOCOL_CONNECTION
        ),
    ]
    return {
        "connections": _ordered(connections, WORKFLOW_CONNECTIONS),
        "sources": _ordered(kind_list, WORKFLOW_SOURCES),
        "contextSchema": _trigger_context_schema(graph),
        "origin": "legacy",
    }


def _audio_delivery(kind: Mapping[str, Any]) -> str | None:
    raw = kind.get("primitive")
    primitive = raw if isinstance(raw, str) else ""
    if "AUDIO" not in primitive:
        return None
    if kind.get("delivery") in ("blob", "stream"):
        return str(kind["delivery"])
    return "stream" if primitive == "STREAM_AUDIO" else "blob"


def _is_attachment_kind(kind: Mapping[str, Any]) -> bool:
    return kind.get("primitive") in ("DOCUMENT", "IMAGE") or "attachments" in kind


def settings_implications(
    graph: Mapping[str, Any], settings: Mapping[str, Any], ctx: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """What ``settings.connections`` is missing (WF-SET-001..004)."""
    ctx = ctx or {}
    has = set(settings.get("connections") or [])
    consultation_audio = "consultation" in (settings.get("sources") or [])
    found: list[dict[str, Any]] = []
    if "sse" in has and "api" not in has:
        found.append(
            {
                "ruleId": "WF-SET-001",
                "requires": "api",
                "nodeId": None,
                "message": "Streaming a run (SSE) needs the API connection: a stream follows a "
                "run started through the API.",
            }
        )
    if "socket" in has and "api" not in has:
        found.append(
            {
                "ruleId": "WF-SET-002",
                "requires": "api",
                "nodeId": None,
                "message": "The socket connection needs the API connection: a socket attaches to "
                "a run started through the API.",
            }
        )
    if "socket" not in has:
        for node in graph.get("nodes") or []:
            if not isinstance(node, dict) or node.get("type") != "core.agent":
                continue
            task = agent_task_of(_obj(node.get("config")), ctx.get("agents"))
            if task not in ("SPEECH_TO_TEXT", "TEXT_TO_SPEECH"):
                continue
            if task == "SPEECH_TO_TEXT" and consultation_audio:
                continue
            verb = "transcribes speech" if task == "SPEECH_TO_TEXT" else "speaks its output"
            found.append(
                {
                    "ruleId": "WF-SET-003",
                    "requires": "socket",
                    "nodeId": node.get("id"),
                    "message": f"Step `{node.get('id')}` {verb}, which needs the socket "
                    "connection for live audio.",
                }
            )
    kinds = (_obj(ctx.get("contextSchemaDefinition")) or {}).get("kinds")
    kind_objects = [k for k in kinds if isinstance(k, dict)] if isinstance(kinds, list) else []
    if "socket" not in has:
        streamed = next((k for k in kind_objects if _audio_delivery(k) == "stream"), None)
        if streamed is not None:
            found.append(
                {
                    "ruleId": "WF-SET-003",
                    "requires": "socket",
                    "nodeId": None,
                    "message": f"The Input shape streams audio (`{streamed.get('key')}`), which "
                    "needs the socket connection.",
                }
            )
    if "api" not in has:
        uploaded = next(
            (k for k in kind_objects if _audio_delivery(k) == "blob" or _is_attachment_kind(k)),
            None,
        )
        if uploaded is not None:
            found.append(
                {
                    "ruleId": "WF-SET-004",
                    "requires": "api",
                    "nodeId": None,
                    "message": f"The Input shape takes an uploaded file (`{uploaded.get('key')}`), "
                    "which needs the API connection.",
                }
            )
    return found


# ---------------------------------------------------------------------------------------------
# WF-SET-005 (TASK-1042 OD-7) — a streamed audio input must be READ by a speech-to-text step.
# ---------------------------------------------------------------------------------------------


def _binding_paths(binding: Any) -> list[str]:
    obj = _obj(binding)
    if obj is None:
        return []
    if isinstance(obj.get("from"), str):
        return [obj["from"]]
    first_of = obj.get("firstOf")
    return [p for p in first_of if isinstance(p, str)] if isinstance(first_of, list) else []


def _reads_kind(path: str, key: str, trigger_ids: set[str]) -> bool:
    """Whether a binding path carries the input field ``key``: ``context.<key>[.…]``, the whole
    ``context``, or the trigger's ``context`` output (what a legacy data edge from it carries)."""
    segments = path.split(".")
    if segments[0] == "context":
        rest = segments[1:]
    elif (
        len(segments) >= 4
        and segments[0] == "nodes"
        and segments[1] in trigger_ids
        and segments[2] == "outputs"
        and segments[3] == "context"
    ):
        rest = segments[4:]
    else:
        return False
    return not rest or rest[0] == key


def live_audio_unread(
    graph: Mapping[str, Any], settings: Mapping[str, Any], ctx: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    """WF-SET-005 — every ``stream``-delivery Input kind no speech-to-text step's ``audio`` reads.

    Not a connection implication (it names no connection to add), so it is NOT part of
    ``settings_implications``, whose every entry the settings dialog turns into a checkbox.
    """
    # Imported here: ``bindings`` imports this module (``effective_settings``).
    from hope_workflow_contract.bindings import compiled_bindings

    ctx = ctx or {}
    if "consultation" in (settings.get("sources") or []):
        # A consultation-sourced run receives its audio on the consultation session.
        return []
    kinds = (_obj(ctx.get("contextSchemaDefinition")) or {}).get("kinds")
    streamed = [
        k
        for k in (kinds if isinstance(kinds, list) else [])
        if isinstance(k, dict) and _audio_delivery(k) == "stream" and isinstance(k.get("key"), str)
    ]
    if not streamed:
        return []
    agents = ctx.get("agents")
    nodes = [n for n in graph.get("nodes") or [] if isinstance(n, dict)]
    trigger_ids = {n.get("id") for n in nodes if n.get("type") == "core.trigger"}
    bindings = compiled_bindings(graph, agents)
    reader_paths: list[str] = []
    for node in nodes:
        if node.get("type") != "core.agent":
            continue
        task = agent_task_of(_obj(node.get("config")), agents)
        if task not in (None, "SPEECH_TO_TEXT"):
            continue
        reader_paths.extend(_binding_paths((bindings.get(node.get("id")) or {}).get("audio")))
    found: list[dict[str, Any]] = []
    for kind in streamed:
        key = kind["key"]
        if any(_reads_kind(path, key, trigger_ids) for path in reader_paths):
            continue
        found.append(
            {
                "ruleId": "WF-SET-005",
                "nodeId": None,
                "kindKey": key,
                "message": f"The Input shape streams audio (`{key}`), but no speech-to-text step "
                "reads it: bind it to a speech-to-text step's audio input.",
            }
        )
    return found
