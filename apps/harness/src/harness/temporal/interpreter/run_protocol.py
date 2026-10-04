"""TASK-1038 R6 — run protocol v2, the harness's hand-written mirror of
``packages/async-contract/src/run-protocol.ts`` (frozen by lane F2; design: ``protocol-v2.md``).

ONE envelope ``{seq, runId, type, ts, nodeId?, data}`` for every run stream. The harness is a
PRODUCER: it builds events, validates them, and appends them through the ONE sequencer
(:data:`RUN_APPEND_LUA`) so every stored event of a run gets the next contiguous ``seq``, whichever
process writes it. The gateway derives the legacy frames for legacy-selecting clients; the harness
writes v2 only.

Held to ``tests/contracts/run-protocol.fixture.json`` by ``test_task1038_run_protocol_parity.py``
(the constants, the per-type data shapes through the fixture's examples/invalid entries, the SSE
bytes, the Lua bytes and the stored EVAL arguments).

Pure and dependency-free: no I/O here (the append itself is ``run_events.RunEventProducer``).
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

RUN_PROTOCOL_VERSION = 2
RUN_PROTOCOL_HEADER = "x-hope-run-protocol"
RUN_PROTOCOL_QUERY_PARAM = "protocol"
RUN_RESULT_INLINE_MAX_BYTES = 64 * 1024

PUBLIC_RUN_EVENT_TYPES: tuple[str, ...] = (
    "run.started",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "run.resync",
    "node.started",
    "node.completed",
    "node.failed",
    "output.text.delta",
    "output.audio.delta",
    "output.data",
    "ping",
)
ADMIN_RUN_EVENT_TYPES: tuple[str, ...] = (
    "input.validated",
    "data.bound",
    "binding.warning",
    "consultation.read",
    "transcript.partial",
    "transcript.final",
    "prompt.composed",
    "model.request",
    "guardrail.inbound",
    "guardrail.outbound",
    "output.validated",
)
RUN_EVENT_TYPES: tuple[str, ...] = (*PUBLIC_RUN_EVENT_TYPES, *ADMIN_RUN_EVENT_TYPES)
RUN_EVENT_VISIBILITY: dict[str, str] = {
    **dict.fromkeys(PUBLIC_RUN_EVENT_TYPES, "public"),
    **dict.fromkeys(ADMIN_RUN_EVENT_TYPES, "admin"),
}


def _scope_of(type_: str) -> str:
    if type_.startswith("run.") or type_ in ("ping", "input.validated"):
        return "forbidden"
    if type_.startswith("transcript."):
        return "optional"
    return "required"


RUN_EVENT_NODE_SCOPE: dict[str, str] = {t: _scope_of(t) for t in RUN_EVENT_TYPES}
AGENT_RUN_NODE_ID = "agent"
SYNTHETIC_RUN_EVENT_TYPES = ("ping", "run.resync")

RUN_ERROR_MESSAGES: dict[str, str] = {
    "RUN_TIMED_OUT": "The run exceeded its time limit.",
    "NODE_TIMED_OUT": "The step exceeded its time limit.",
    "RUN_CANCELLED": "The run was cancelled.",
    "INPUT_INVALID": "The run input does not match its schema.",
    "OUTPUT_INVALID": "The output does not match its declared contract.",
    "BINDING_UNRESOLVED": "A required input of the step has no value.",
    "PROMPT_VARIABLE_UNRESOLVED": "A required prompt variable has no value.",
    "PAYLOAD_TOO_LARGE": "A payload exceeded the size limit.",
    "MODEL_UNAVAILABLE": "The model did not answer.",
    "MODEL_ERROR": "The model returned an error.",
    "PROVIDER_NOT_CONFIGURED": "No usable provider connection is configured.",
    "AGENT_VERSION_UNAVAILABLE": "The pinned agent version is not available.",
    "GUARDRAIL_BLOCKED": "A guardrail blocked the content.",
    "CONSULTATION_READ_FAILED": "Consultation data could not be read.",
    "DOWNSTREAM_UNAVAILABLE": "A downstream service did not answer.",
    "INTERNAL_ERROR": "An internal error occurred.",
}
RUN_ERROR_FALLBACK_MESSAGE = "The step could not be completed."
RUN_RESYNC_REASONS = ("gap", "expired", "cursor_invalid", "unavailable")


def run_error_message(code: str) -> str:
    return RUN_ERROR_MESSAGES.get(code, RUN_ERROR_FALLBACK_MESSAGE)


def run_error(
    code: str, *, node_id: str | None = None, detail: str | None = None
) -> dict[str, Any]:
    """A conforming ``RunError``: the fixed label as ``message``; free text only in ``detail``."""
    error: dict[str, Any] = {"code": code, "message": run_error_message(code)}
    if node_id is not None:
        error["nodeId"] = node_id
    if detail:
        error["detail"] = detail[:4000]
    return error


# ---------------------------------------------------------------------------------------------
# Data shapes — the JSON-Schema subset `RUN_EVENT_DATA_SCHEMAS` declares (mirrored by hand)
# ---------------------------------------------------------------------------------------------

_ANY: dict[str, Any] = {}
_STR = {"type": "string"}
_STR1 = {"type": "string", "minLength": 1, "maxLength": 255}
_INT0 = {"type": "integer", "minimum": 0}
_INT1 = {"type": "integer", "minimum": 1}
_NUM0 = {"type": "number", "minimum": 0}
_BOOL = {"type": "boolean"}
_FIELD = {"type": "string", "minLength": 1, "maxLength": 128}
_PHI = {"type": "string", "enum": ["PHI", "NON_PHI"]}
_STRINGS = {"type": "array", "items": _STR}


def _closed(properties: dict[str, Any], required: Sequence[str] = ()) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(required),
    }


def _enum(*values: str) -> dict[str, Any]:
    return {"type": "string", "enum": list(values)}


_TOKENS = _closed({"in": _INT0, "out": _INT0}, ["in", "out"])
_ERROR = _closed(
    {
        "code": {"type": "string", "pattern": r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$", "maxLength": 64},
        "message": _STR,
        "nodeId": _STR1,
        "detail": {"type": "string", "maxLength": 4000},
    },
    ["code", "message"],
)
_SHA256 = {"type": "string", "pattern": r"^[0-9a-f]{64}$"}
_RESULT = {
    "anyOf": [
        _closed({"kind": {"const": "inline"}, "value": _ANY}, ["kind", "value"]),
        _closed(
            {
                "kind": {"const": "ref"},
                "bucket": _STR1,
                "key": {"type": "string", "minLength": 1},
                "sizeBytes": _INT0,
                "sha256": _SHA256,
            },
            ["kind", "bucket", "key", "sizeBytes", "sha256"],
        ),
    ]
}
_GUARDRAIL = _closed(
    {
        "action": _enum("ALLOW", "REDACT", "BLOCK"),
        "detected": _INT0,
        "categories": _STRINGS,
        "mode": _enum("detect", "redact"),
        "latencyMs": _NUM0,
    },
    ["action", "detected"],
)
_BASE64 = r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"

RUN_EVENT_DATA_SCHEMAS: dict[str, dict[str, Any]] = {
    "run.started": _closed(
        {
            "kind": _enum("workflow", "agent"),
            "slug": _STR1,
            "versionNumber": _INT1,
            "mode": _enum("blocking", "async", "stream"),
        },
        ["kind", "slug", "versionNumber"],
    ),
    "run.completed": _closed(
        {
            "status": {"const": "COMPLETED"},
            "durationMs": _INT0,
            "tokens": _TOKENS,
            "result": _RESULT,
            "degraded": _BOOL,
        },
        ["status", "durationMs", "tokens"],
    ),
    "run.failed": _closed(
        {
            "status": _enum("FAILED", "TIMED_OUT"),
            "durationMs": _INT0,
            "error": _ERROR,
            "tokens": _TOKENS,
        },
        ["status", "durationMs", "error"],
    ),
    "run.cancelled": _closed(
        {"status": {"const": "CANCELED"}, "durationMs": _INT0, "reason": _STR},
        ["status", "durationMs"],
    ),
    "run.resync": _closed(
        {
            "reason": _enum(*RUN_RESYNC_REASONS),
            "snapshot": _closed(
                {
                    "status": _enum("RUNNING", "COMPLETED", "FAILED", "CANCELED", "TIMED_OUT"),
                    "lastSeq": _INT0,
                    "nodes": {
                        "type": "object",
                        "additionalProperties": _closed(
                            {
                                "status": _enum(
                                    "waiting",
                                    "running",
                                    "completed",
                                    "degraded",
                                    "failed",
                                    "skipped",
                                ),
                                "durationMs": _INT0,
                            },
                            ["status"],
                        ),
                    },
                    "outputs": {
                        "type": "object",
                        "additionalProperties": {"type": "object", "additionalProperties": _ANY},
                    },
                    "result": _RESULT,
                },
                ["status", "lastSeq", "nodes", "outputs"],
            ),
        },
        ["reason", "snapshot"],
    ),
    "node.started": _closed({"kind": _STR1, "label": _STR, "attempt": _INT1}, ["kind"]),
    "node.completed": _closed(
        {
            "status": _enum("COMPLETED", "DEGRADED", "SKIPPED"),
            "durationMs": _INT0,
            "tokens": _TOKENS,
            "warnings": _INT0,
        },
        ["status", "durationMs"],
    ),
    "node.failed": _closed(
        {"durationMs": _INT0, "error": _ERROR, "attempt": _INT1, "willRetry": _BOOL},
        ["durationMs", "error"],
    ),
    "output.text.delta": _closed({"field": _FIELD, "text": _STR}, ["field", "text"]),
    "output.audio.delta": _closed(
        {
            "field": _FIELD,
            "chunk": {"type": "string", "minLength": 1, "pattern": _BASE64},
            "format": _enum("wav", "mp3", "ogg", "pcm"),
            "sampleRate": _INT1,
        },
        ["field", "chunk", "format"],
    ),
    "output.data": _closed(
        {"field": _FIELD, "value": _ANY, "visibility": {"const": "admin"}}, ["field", "value"]
    ),
    "ping": _closed({}),
    "input.validated": _closed(
        {
            "valid": _BOOL,
            "problems": _STRINGS,
            "schema": _closed({"slug": _STR1, "versionNumber": _INT1}, ["slug"]),
        },
        ["valid", "problems"],
    ),
    "data.bound": _closed(
        {
            "inputs": {
                "type": "array",
                "items": _closed(
                    {
                        "input": _FIELD,
                        "source": _closed(
                            {
                                "kind": _enum("from", "value", "template"),
                                "path": _STR1,
                                "template": _STR,
                            },
                            ["kind"],
                        ),
                        "value": _ANY,
                        "empty": _BOOL,
                        "phiClass": _PHI,
                    },
                    ["input", "source"],
                ),
            }
        },
        ["inputs"],
    ),
    "binding.warning": _closed(
        {"input": _FIELD, "code": _STR1, "message": _STR}, ["input", "code", "message"]
    ),
    "consultation.read": _closed(
        {
            "consultationId": _STR1,
            "snapshot": _enum("node-start", "run-start"),
            "fields": {
                "type": "array",
                "items": _closed(
                    {"path": _STR1, "phiClass": _PHI, "value": _ANY}, ["path", "phiClass"]
                ),
            },
        },
        ["consultationId", "snapshot", "fields"],
    ),
    "transcript.partial": _closed(
        {"text": _STR, "utteranceIndex": _INT0, "stableChars": _INT0}, ["text"]
    ),
    "transcript.final": _closed(
        {
            "text": _STR,
            "utteranceIndex": _INT0,
            "start": _NUM0,
            "end": _NUM0,
            "speaker": _STR,
            "language": _STR,
        },
        ["text"],
    ),
    "prompt.composed": _closed(
        {
            "layers": {
                "type": "array",
                "items": _closed(
                    {
                        "name": _enum(
                            "platformRules",
                            "instruction",
                            "outputLanguage",
                            "outputContract",
                            "data",
                        ),
                        "chars": _INT0,
                        "tokens": _INT0,
                    },
                    ["name", "chars"],
                ),
            },
            "charsTotal": _INT0,
            "tokensTotal": _INT0,
            "selected": _STRINGS,
            "excluded": {
                "type": "array",
                "items": _closed(
                    {"key": _STR1, "reason": _enum("condition_false", "condition_error")},
                    ["key", "reason"],
                ),
            },
            "blocks": {
                "type": "array",
                "items": _closed(
                    {"key": _STR1, "chars": _INT0, "truncated": _BOOL},
                    ["key", "chars", "truncated"],
                ),
            },
            "composedPromptId": _STR1,
        },
        ["layers", "charsTotal", "selected", "excluded", "blocks"],
    ),
    "model.request": _closed(
        {
            "provider": _STR1,
            "model": _STR1,
            "attempt": _INT1,
            "fallback": _BOOL,
            "stream": _BOOL,
            "parameters": _closed({"temperature": _NUM0, "maxTokens": _INT1}),
        },
        ["provider", "model", "attempt", "fallback", "stream"],
    ),
    "guardrail.inbound": _GUARDRAIL,
    "guardrail.outbound": _GUARDRAIL,
    "output.validated": _closed(
        {"valid": _BOOL, "problems": _STRINGS, "field": _FIELD}, ["valid", "problems"]
    ),
}


# ---------------------------------------------------------------------------------------------
# Validation (the interpreter of the subset)
# ---------------------------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _matches_type(type_: str, value: Any) -> bool:
    if type_ == "string":
        return isinstance(value, str)
    if type_ == "number":
        return _is_number(value) and value == value and value not in (float("inf"), float("-inf"))
    if type_ == "integer":
        return _is_number(value) and float(value).is_integer()
    if type_ == "boolean":
        return isinstance(value, bool)
    if type_ == "object":
        return isinstance(value, dict)
    if type_ == "array":
        return isinstance(value, list)
    if type_ == "null":
        return value is None
    return False


def _strict_equal(a: Any, b: Any) -> bool:
    """JavaScript ``===`` for the JSON scalars a schema names (a boolean is never a number)."""
    return type(a) is type(b) and a == b if isinstance(a, bool) or isinstance(b, bool) else a == b


def _js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _schema_problems(schema: Mapping[str, Any], value: Any, path: str) -> list[str]:
    if "anyOf" in schema:
        return _any_of_problems(schema["anyOf"], value, path)
    problems: list[str] = []
    if "const" in schema and not _strict_equal(schema["const"], value):
        problems.append(f"{path} must be {_js(schema['const'])}")
    type_ = schema.get("type")
    if type_ is not None and not _matches_type(type_, value):
        article = "n" if type_[0] in "aeiou" else ""
        return [*problems, f"{path} must be a{article} {type_}"]
    if "enum" in schema and not any(_strict_equal(e, value) for e in schema["enum"]):
        problems.append(f"{path} must be one of {' | '.join(str(e) for e in schema['enum'])}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            problems.append(f"{path} must be at least {schema['minLength']} character(s)")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            problems.append(f"{path} must be at most {schema['maxLength']} characters")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            problems.append(f"{path} does not match {schema['pattern']}")
    if _is_number(value) and "minimum" in schema and value < schema["minimum"]:
        problems.append(f"{path} must be ≥ {schema['minimum']}")
    if isinstance(value, list) and "items" in schema:
        for index, entry in enumerate(value):
            problems.extend(_schema_problems(schema["items"], entry, f"{path}[{index}]"))
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in value:
                problems.append(f"{path}.{key} is required")
        additional = schema.get("additionalProperties")
        for key, entry in value.items():
            if key in properties:
                problems.extend(_schema_problems(properties[key], entry, f"{path}.{key}"))
            elif additional is False:
                problems.append(f"{path}: unexpected property '{key}'")
            elif isinstance(additional, dict):
                problems.extend(_schema_problems(additional, entry, f"{path}.{key}"))
    return problems


def _any_of_problems(branches: Sequence[Mapping[str, Any]], value: Any, path: str) -> list[str]:
    kinds = [((b.get("properties") or {}).get("kind") or {}).get("const") for b in branches]
    if all(k is not None for k in kinds) and isinstance(value, dict):
        for kind, branch in zip(kinds, branches, strict=True):
            if _strict_equal(kind, value.get("kind")):
                return _schema_problems(branch, value, path)
        return [f"{path}.kind must be one of {' | '.join(str(k) for k in kinds)}"]
    if any(not _schema_problems(b, value, path) for b in branches):
        return []
    return [f"{path} matches none of its allowed shapes"]


_ENVELOPE_KEYS = ("seq", "runId", "type", "ts", "nodeId", "data")
_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def _valid_ts(value: Any) -> bool:
    if not isinstance(value, str) or _DATE_TIME.match(value) is None:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def run_event_audience(event: Mapping[str, Any]) -> str:
    """The audience of ONE event (the stored ``vis``): the type's, narrowed for an admin
    ``output.data``."""
    data = event.get("data")
    if (
        event.get("type") == "output.data"
        and isinstance(data, dict)
        and data.get("visibility") == "admin"
    ):
        return "admin"
    return RUN_EVENT_VISIBILITY.get(str(event.get("type")), "admin")


def run_event_problems(
    value: Any, *, run_kind: str | None = None, plane: str | None = None
) -> list[str]:
    """Every problem with a candidate run event; ``[]`` = conforms. Never raises."""
    if not isinstance(value, dict):
        return ["run event must be a JSON object"]
    problems = [f"unexpected property '{key}'" for key in value if key not in _ENVELOPE_KEYS]
    type_ = value.get("type")
    known = isinstance(type_, str) and type_ in RUN_EVENT_VISIBILITY
    if not known:
        problems.append(
            "type must be one of the run protocol v2 event types "
            f"(received {_js(type_) if type_ is not None else 'undefined'})"
        )
    synthetic = known and type_ in SYNTHETIC_RUN_EVENT_TYPES
    seq = value.get("seq")
    if not (_is_number(seq) and float(seq).is_integer()) or seq < 0:
        problems.append("seq must be a non-negative integer")
    elif known and not synthetic and seq < 1:
        problems.append("seq must be ≥ 1 on a stored event (only ping and run.resync may carry 0)")
    run_id = value.get("runId")
    if not isinstance(run_id, str) or not run_id or len(run_id) > 255:
        problems.append("runId must be a non-empty string of at most 255 characters")
    if not _valid_ts(value.get("ts")):
        problems.append("ts must be an ISO-8601 date-time string")
    has_node_id = "nodeId" in value
    node_id = value.get("nodeId")
    if has_node_id and (not isinstance(node_id, str) or not node_id or len(node_id) > 255):
        problems.append("nodeId must be a non-empty string of at most 255 characters")
    if known:
        scope = RUN_EVENT_NODE_SCOPE[str(type_)]
        if scope == "required" and not has_node_id:
            problems.append(f"nodeId is required on {type_}")
        if scope == "forbidden" and has_node_id:
            problems.append(f"nodeId must be absent on {type_} (a run-level event)")
        if run_kind == "agent" and has_node_id and node_id != AGENT_RUN_NODE_ID:
            problems.append(
                f"nodeId must be '{AGENT_RUN_NODE_ID}' on every step event of an agent run "
                f"(received {_js(node_id)})"
            )
    data = value.get("data")
    if not isinstance(data, dict):
        problems.append("data must be a JSON object")
    elif known:
        problems.extend(_schema_problems(RUN_EVENT_DATA_SCHEMAS[str(type_)], data, "data"))
        snapshot = data.get("snapshot")
        if type_ == "run.resync" and isinstance(snapshot, dict) and snapshot.get("lastSeq") != seq:
            problems.append(
                "run.resync seq must equal data.snapshot.lastSeq "
                "(the stream continues at lastSeq + 1)"
            )
        error = data.get("error")
        if (
            type_ in ("run.failed", "node.failed")
            and isinstance(error, dict)
            and isinstance(error.get("code"), str)
        ):
            label = run_error_message(error["code"])
            if error.get("message") != label:
                problems.append(
                    f"data.error.message must be the fixed label of {error['code']} "
                    f"({_js(label)}); free text belongs in detail"
                )
            if plane == "public" and "detail" in error:
                problems.append(
                    "data.error.detail is admin-trace only and never reaches the public plane"
                )
        if plane == "public" and run_event_audience(value) != "public":
            problems.append(
                f"{type_} with this audience is admin-trace only and never reaches the public plane"
            )
    return problems


class RunProtocolError(ValueError):
    """A non-conforming event a producer tried to emit — never written."""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)
        super().__init__(f"Not a run protocol v2 event: {'; '.join(self.problems)}")


def _ordered(event: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "seq": event["seq"],
        "runId": event["runId"],
        "type": event["type"],
        "ts": event["ts"],
    }
    if event.get("nodeId") is not None:
        out["nodeId"] = event["nodeId"]
    out["data"] = event["data"]
    return out


def to_sse_frame(event: Mapping[str, Any]) -> str:
    problems = run_event_problems(event)
    if problems:
        raise RunProtocolError(problems)
    return f"event: {event['type']}\nid: {event['seq']}\ndata: {_js(_ordered(event))}\n\n"


def to_public_run_event(event: Mapping[str, Any]) -> dict[str, Any] | None:
    if run_event_audience(event) != "public":
        return None
    out = dict(event)
    if event.get("type") in ("run.failed", "node.failed"):
        data = dict(event["data"])
        data["error"] = {k: v for k, v in data["error"].items() if k != "detail"}
        out["data"] = data
    return out


# ---------------------------------------------------------------------------------------------
# The ONE sequencer — byte-for-byte the fixture's `sequencer.lua`
# ---------------------------------------------------------------------------------------------

RUN_STREAM_KEY_PREFIX = "wf:run:"
RUN_STREAM_MAX_LEN = 10_000
RUN_STREAM_FIELDS = ("seq", "type", "ts", "nodeId", "vis", "body")
RUN_STREAM_CLOSED_ERROR = "RUN_STREAM_CLOSED"
TERMINAL_RUN_EVENT_TYPES = ("run.completed", "run.failed", "run.cancelled")


def run_seq_key(run_id: str) -> str:
    return f"{RUN_STREAM_KEY_PREFIX}{run_id}:seq"


def run_events_key(run_id: str) -> str:
    return f"{RUN_STREAM_KEY_PREFIX}{run_id}:events"


def run_dedupe_key(run_id: str) -> str:
    return f"{RUN_STREAM_KEY_PREFIX}{run_id}:dedupe"


RUN_APPEND_LUA = "\n".join(
    [
        "-- HOPE run protocol v2: the ONE run-event sequencer (TASK-1038).",
        "-- KEYS: [1] wf:run:<runId>:seq  [2] wf:run:<runId>:events  [3] wf:run:<runId>:dedupe",
        "-- ARGV: [1] maxLen  [2] retention seconds ('0' = not terminal)  [3] dedupe key ('' = none)",
        "--       [4..] field/value pairs after seq: type, ts, [nodeId], vis, body",
        "local dedupe = ARGV[3]",
        "if dedupe ~= '' then",
        "  local prior = redis.call('HGET', KEYS[3], dedupe)",
        "  if prior then",
        "    local s, id = string.match(prior, '^(%d+) (.+)$')",
        "    return {tonumber(s), id, 1}",
        "  end",
        "end",
        "if redis.call('PTTL', KEYS[2]) >= 0 then",
        "  return redis.error_reply('RUN_STREAM_CLOSED')",
        "end",
        "local seq = redis.call('INCR', KEYS[1])",
        "local xadd = {'XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], '*', 'seq', tostring(seq)}",
        "for i = 4, #ARGV do xadd[#xadd + 1] = ARGV[i] end",
        "local id = redis.call(unpack(xadd))",
        "if dedupe ~= '' then redis.call('HSET', KEYS[3], dedupe, seq .. ' ' .. id) end",
        "local ttl = tonumber(ARGV[2])",
        "if ttl > 0 then",
        "  for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ttl) end",
        "end",
        "return {seq, id, 0}",
        "",
    ]
)


@dataclass(frozen=True)
class RunAppendCommand:
    keys: list[str]
    args: list[str]


def build_run_append(
    *,
    run_id: str,
    type: str,  # noqa: A002 — the envelope's own field name
    ts: str,
    data: Mapping[str, Any],
    node_id: str | None = None,
    dedupe_key: str | None = None,
    retention_seconds: int | None = None,
    max_len: int | None = None,
    allow_missing_retention: bool = False,
) -> RunAppendCommand:
    """Validate one event and build its ``EVAL`` arguments (mirrors ``buildRunAppend``).

    ``allow_missing_retention`` is the one-release transition for a run started before the
    gateway injected ``retentionSeconds``: its terminal event is appended with ``'0'`` and the
    gateway's ``EXPIRE … NX`` terminal backstop starts the retention clock instead.
    """
    if type in SYNTHETIC_RUN_EVENT_TYPES:
        raise RunProtocolError([f"{type} is synthetic and is never stored"])
    candidate: dict[str, Any] = {"seq": 1, "runId": run_id, "type": type, "ts": ts}
    if node_id is not None:
        candidate["nodeId"] = node_id
    candidate["data"] = dict(data)
    problems = run_event_problems(candidate)
    terminal = type in TERMINAL_RUN_EVENT_TYPES
    valid_retention = (
        isinstance(retention_seconds, int)
        and not isinstance(retention_seconds, bool)
        and retention_seconds >= 1
    )
    if (
        terminal
        and not valid_retention
        and not (allow_missing_retention and retention_seconds is None)
    ):
        problems.append(
            f"retentionSeconds (a positive integer) is required on the terminal event {type}"
        )
    if not terminal and retention_seconds is not None:
        problems.append(
            f"retentionSeconds is only allowed on a terminal event (received it on {type})"
        )
    bound = RUN_STREAM_MAX_LEN if max_len is None else max_len
    if not isinstance(bound, int) or bound < 1:
        problems.append("maxLen must be a positive integer")
    if dedupe_key is not None and not dedupe_key:
        problems.append("dedupeKey must be non-empty when given")
    if problems:
        raise RunProtocolError(problems)
    fields = ["type", type, "ts", ts]
    if node_id is not None:
        fields += ["nodeId", node_id]
    fields += ["vis", run_event_audience(candidate), "body", _js(candidate["data"])]
    return RunAppendCommand(
        keys=[run_seq_key(run_id), run_events_key(run_id), run_dedupe_key(run_id)],
        args=[str(bound), str(retention_seconds or 0), dedupe_key or "", *fields],
    )


_STORED_SEQ = re.compile(r"^[1-9][0-9]*$")


def parse_stored_run_event(run_id: str, fields: Sequence[str]) -> dict[str, Any]:
    """One stream entry's flat field list → ``{kind: event|legacy|invalid, …}``."""
    entry = {fields[i]: fields[i + 1] for i in range(0, len(fields) - 1, 2)}
    raw_seq = entry.get("seq")
    if raw_seq is None:
        return {"kind": "legacy"}
    problems: list[str] = []
    if _STORED_SEQ.match(raw_seq) is None:
        problems.append(f"stored seq must be a positive integer (received {_js(raw_seq)})")
    try:
        data = json.loads(entry.get("body", ""))
    except ValueError:
        problems.append("stored body is not JSON")
        data = None
    if problems:
        return {"kind": "invalid", "problems": problems}
    event: dict[str, Any] = {
        "seq": int(raw_seq),
        "runId": run_id,
        "type": entry.get("type"),
        "ts": entry.get("ts"),
    }
    if "nodeId" in entry:
        event["nodeId"] = entry["nodeId"]
    event["data"] = data
    problems.extend(run_event_problems(event))
    if event["type"] in SYNTHETIC_RUN_EVENT_TYPES:
        problems.append(f"{event['type']} is synthetic and is never stored")
    if problems:
        return {"kind": "invalid", "problems": problems}
    visibility = run_event_audience(event)
    if entry.get("vis") != visibility:
        return {
            "kind": "invalid",
            "problems": [f"stored vis {_js(entry.get('vis'))} disagrees with {visibility}"],
        }
    return {"kind": "event", "event": event, "visibility": visibility}
