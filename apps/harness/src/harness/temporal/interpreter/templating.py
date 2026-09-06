"""TASK-890 §3.2 — the ONE prompt-template grammar, Python half.

Hand-written mirror of ``packages/workflow-contract/src/template.ts``. Both are held to ONE
committed fixture (``tests/contracts/prompt-template.fixture.json``) by two loaders, which is the
discipline ``expressions.py`` / ``expressions.ts`` already use for the CEL subset — neither
runtime can import the other's renderer, so the fixture IS the contract.

Why this module exists at all: before TASK-890 the SAME ``core.agent`` node was rendered by two
different grammars (§2.4 flavours 5 and 6). The durable lane resolved dotted paths; the gateway's
realtime lane did flat-key lookup, so ``{{trigger.patientAge}}`` came out as a value on one lane
and as the literal text ``{{trigger.patientAge}}`` on the other. ``nodes/core.py``'s
``interpolate_template`` (which left an unresolved path VERBATIM) is superseded by this: an
unresolved variable is now a NAMED failure, because a prompt that silently lost a patient's age
is worse than one that refuses to render.

Grammar::

    template    := ( text | escape | placeholder )*
    escape      := "{{{{"                                   ; renders the literal "{{"
    placeholder := "{{" WS? path ( WS? "|" WS? filter )? WS? "}}"
    path        := ident ( "." ident )*
    ident       := [A-Za-z_][A-Za-z0-9_]*
    filter      := "default" WS? "(" string ")"             ; the ONLY filter
    string      := '"' ( [^"\\] | "\\" . )* '"'
    WS          := [ \t]+

Load-bearing semantics (the TypeScript docstring says the same, deliberately):

- Exactly ONE pass — a ``{{`` inside a substituted VALUE is never re-interpreted.
- A SINGLE brace is literal; the deleted ``{var}`` grammar has no fallback pass.
- Own-property traversal over ``dict`` only. A list is a VALUE, not a namespace.
- ``None`` is missing, so ``default(...)`` covers it.
- Non-string values render as canonical JSON — sorted keys, no spaces, non-ASCII kept — which is
  byte-identical to the TypeScript ``canonicalJson``.

Pure, total apart from the two named errors, and dependency-free: it is imported by activity-side
node code, never by workflow-definition code, so it carries no replay-determinism obligation of
its own.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

__all__ = [
    "PromptTemplateSyntaxError",
    "PromptVariableUnresolved",
    "TemplateReference",
    "render_template",
    "template_references",
    "template_syntax_problems",
]

_IDENT_START = re.compile(r"[A-Za-z_]")
_IDENT_CHAR = re.compile(r"[A-Za-z0-9_]")
_WS = (" ", "\t")

# Sentinel distinct from `None`: `None` IS a legitimate JSON value, and §3.2 says a `None` leaf
# counts as missing — so the renderer needs a third state to keep the two apart internally.
_MISSING = object()


class PromptTemplateSyntaxError(Exception):
    """The template does not parse. Publish reports it as ``PROMPT_TEMPLATE_SYNTAX`` (ERROR)."""

    def __init__(self, message: str, offset: int) -> None:
        super().__init__(message)
        self.offset = offset


class PromptVariableUnresolved(Exception):
    """A placeholder resolved to nothing and carried no ``default(...)``. Named, never silent."""

    def __init__(self, path: str, template_ref: str | None) -> None:
        if template_ref is None:
            message = f"Prompt variable `{path}` did not resolve and declares no `default(...)`."
        else:
            message = (
                f"Prompt variable `{path}` did not resolve in `{template_ref}` "
                "and declares no `default(...)`."
            )
        super().__init__(message)
        self.path = path
        self.template_ref = template_ref


@dataclass(frozen=True)
class TemplateReference:
    """One placeholder: its dotted path, whether it defaults, and where it starts."""

    path: str
    has_default: bool
    offset: int


@dataclass(frozen=True)
class _Placeholder:
    path: str
    default_value: str | None
    offset: int
    #: Index just past the closing `}}`. Carried from the parser rather than re-found by
    #: searching for `}}`, which a `default("a}}b")` literal would defeat.
    end: int


@dataclass(frozen=True)
class _Scan:
    segments: list[Any]
    problems: list[str]
    first_problem_offset: int


def _skip_ws(content: str, index: int) -> int:
    i = index
    while i < len(content) and content[i] in _WS:
        i += 1
    return i


def _read_ident(content: str, index: int) -> tuple[str, int] | None:
    if index >= len(content) or not _IDENT_START.match(content[index]):
        return None
    i = index + 1
    while i < len(content) and _IDENT_CHAR.match(content[i]):
        i += 1
    return content[index:i], i


def _read_string(content: str, index: int) -> tuple[str, int] | None:
    """``'"' ( [^"\\] | "\\" . )* '"'`` — a backslash yields the NEXT CHARACTER VERBATIM.

    No C-style escape table, in either language: a default string is display text, and two
    hand-written parsers agree on "take the next character" far more reliably than on a table.
    """
    if index >= len(content) or content[index] != '"':
        return None
    i = index + 1
    out: list[str] = []
    while i < len(content):
        ch = content[i]
        if ch == "\\":
            if i + 1 >= len(content):
                return None
            out.append(content[i + 1])
            i += 2
            continue
        if ch == '"':
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    return None


def _parse_placeholder(content: str, start: int) -> _Placeholder | str:
    """Parses one placeholder starting AT its ``{{``; returns a problem string on any deviation."""
    near = f"at offset {start}"
    i = _skip_ws(content, start + 2)

    first = _read_ident(content, i)
    if first is None:
        found = json.dumps(content[i : i + 8], ensure_ascii=False)
        return (
            f"`{{{{` {near}: expected a variable path "
            f"(`[A-Za-z_][A-Za-z0-9_]*`, dot-separated), found {found}."
        )
    path, i = first
    while i < len(content) and content[i] == ".":
        segment = _read_ident(content, i + 1)
        if segment is None:
            return f"`{{{{` {near}: `{path}.` is not followed by an identifier."
        path = f"{path}.{segment[0]}"
        i = segment[1]

    default_value: str | None = None
    j = _skip_ws(content, i)
    if j < len(content) and content[j] == "|":
        j = _skip_ws(content, j + 1)
        filter_read = _read_ident(content, j)
        if filter_read is None or filter_read[0] != "default":
            name = filter_read[0] if filter_read is not None else content[j : j + 8]
            return (
                f"`{{{{{path}}}}}` {near}: `{name}` is not a filter — "
                '`default("…")` is the only one.'
            )
        j = _skip_ws(content, filter_read[1])
        if j >= len(content) or content[j] != "(":
            return f'`{{{{{path}}}}}` {near}: `default` must be called — `default("…")`.'
        j = _skip_ws(content, j + 1)
        literal = _read_string(content, j)
        if literal is None:
            return f"`{{{{{path}}}}}` {near}: `default(…)` takes ONE double-quoted string."
        default_value, j = literal
        j = _skip_ws(content, j)
        if j >= len(content) or content[j] != ")":
            return f'`{{{{{path}}}}}` {near}: `default("…")` is not closed.'
        j = _skip_ws(content, j + 1)

    if content[j : j + 2] != "}}":
        return f"`{{{{{path}}}}}` {near}: unterminated placeholder — expected `}}}}`."
    return _Placeholder(path=path, default_value=default_value, offset=start, end=j + 2)


def _scan(content: str) -> _Scan:
    """One left-to-right pass.

    A malformed placeholder records a problem and the scan RESUMES two characters later, so a
    template with three mistakes reports three — the house `problems` idiom, which exists so an
    author fixes everything in one edit instead of three round-trips.
    """
    segments: list[Any] = []
    problems: list[str] = []
    first_problem_offset = -1
    buffer: list[str] = []
    i = 0

    def flush() -> None:
        if buffer:
            segments.append("".join(buffer))
            buffer.clear()

    while i < len(content):
        if content[i : i + 2] != "{{":
            buffer.append(content[i])
            i += 1
            continue
        if content[i : i + 4] == "{{{{":
            buffer.append("{{")
            i += 4
            continue
        parsed = _parse_placeholder(content, i)
        if isinstance(parsed, str):
            problems.append(parsed)
            if first_problem_offset < 0:
                first_problem_offset = i
            buffer.append("{{")
            i += 2
            continue
        flush()
        segments.append(parsed)
        i = parsed.end

    flush()
    return _Scan(segments=segments, problems=problems, first_problem_offset=first_problem_offset)


def _resolve_path(scope: Any, path: str) -> Any:
    """Dotted traversal, own-key, ``dict`` only.

    Returns ``_MISSING`` for all four ways a path fails to resolve: an absent key, a non-dict on
    the way down, a list (an index is not a namespace), and a ``None`` leaf.
    """
    current = scope
    for segment in path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return _MISSING
        current = current[segment]
    return _MISSING if current is None else current


def _canonical_json(value: Any) -> str:
    """Object keys SORTED, array order PRESERVED, no spaces, non-ASCII kept — byte-identical to
    the TypeScript ``canonicalJson`` this mirrors."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def render_template(content: str, scope: dict[str, Any], *, template_ref: str | None = None) -> str:
    """Render ``content`` against ``scope``.

    Raises ``PromptTemplateSyntaxError`` if the template does not parse and
    ``PromptVariableUnresolved`` on the first unresolved, undefaulted placeholder. It never
    returns a partially-substituted string.
    """
    scanned = _scan(content)
    if scanned.problems:
        raise PromptTemplateSyntaxError(scanned.problems[0], scanned.first_problem_offset)

    out: list[str] = []
    for segment in scanned.segments:
        if isinstance(segment, str):
            out.append(segment)
            continue
        value = _resolve_path(scope, segment.path)
        if value is _MISSING:
            if segment.default_value is None:
                raise PromptVariableUnresolved(segment.path, template_ref)
            out.append(segment.default_value)
            continue
        out.append(value if isinstance(value, str) else _canonical_json(value))
    return "".join(out)


def template_references(content: str) -> list[TemplateReference]:
    """Every placeholder the template references, in source order. Malformed ones are skipped."""
    return [
        TemplateReference(
            path=segment.path, has_default=segment.default_value is not None, offset=segment.offset
        )
        for segment in _scan(content).segments
        if isinstance(segment, _Placeholder)
    ]


def template_syntax_problems(content: str) -> list[str]:
    """Every way the template fails to parse; ``[]`` means ``render_template`` will not raise a
    syntax error."""
    return list(_scan(content).problems)
