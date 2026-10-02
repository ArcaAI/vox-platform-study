"""TASK-947 §4.1 — prompt COMPOSITION, Python half: which fragments of a composite instruction
run, and how they become one system prompt.

Hand-written mirror of ``packages/workflow-contract/src/prompt-composition.ts``, function for
function. Neither runtime can import the other's composer, so the committed fixture
``tests/contracts/prompt-composition.fixture.json`` IS the contract — loaded from BOTH
``tests/contracts/prompt-composition-parity.contract.test.ts`` and this package's
``tests/unit/temporal/interpreter/test_prompt_composition_parity.py``. That is the discipline
``templating.py`` / ``template.ts`` and ``expressions.py`` / ``expressions.ts`` already use.

A composite ``compiledConfig.resolvedPrompt`` carries every fragment's content FROZEN at publish
(the TASK-890 freeze, per fragment). At render time::

    scope := _prompt_scope(...)                         # the ONE scope (§3.3), built BEFORE any condition
    for f in fragments (authored order):
      f.when is None              -> include
      evaluate_condition(f.when)  -> error   => excluded { reason: "condition_error" }   (OD-5: never fatal)
                                  -> False   => excluded { reason: "condition_false" }
                                  -> True    -> include
    selected empty                -> PromptCompositionEmpty   (defensive — publish enforced a base, OD-6)
    parts := [render_template(f.content, scope, template_ref=f"<ref>#<key>") for f in selected]
    prompt := join.join(parts)

Two properties are load-bearing and pinned by the fixture:

- **The condition sees exactly what the template sees.** No second scope, no projection: a
  ``when`` that can read ``context.visit_type`` is one whose template can render
  ``{{context.visit_type}}``, and vice versa. That is also why a bare bound name is a STRING in
  a condition — ``{"path"}`` bindings resolve THROUGH the grammar (§3.3) — so a numeric branch
  reads the root (``context.patient_age > 65``), never the bare name.
- **Each fragment is rendered on its own, then joined.** A substituted value is never
  re-interpreted (the grammar's one-pass rule) and a ``{{`` can never pair with a ``}}`` across
  a fragment boundary.

The two pre-947 shapes (``template``, ``inline``) pass through ``compose_prompt`` unchanged, so
every renderer has ONE entry point and no ``source`` sniffing of its own.

Pure and dependency-free (no pydantic): it accepts the RAW ``resolvedPrompt`` mapping straight
off the wire, or any object exposing ``model_dump`` (the ``models.ResolvedPrompt`` mirror), and
is imported by activity-side node code only — so it carries no replay-determinism obligation of
its own.

One deliberate divergence, on an input the contract cannot produce: a ``composite`` prompt whose
``fragments`` is absent or not a list raises ``PromptCompositionEmpty`` here, where the
TypeScript half raises a ``TypeError`` from iterating ``undefined``. Both refuse; this half
refuses with the name the caller already degrades on, which is the house posture.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from harness.temporal.interpreter.expressions import evaluate_condition
from harness.temporal.interpreter.templating import (
    render_template,
    resolve_template_path,
    template_references,
)

__all__ = [
    "AGENT_CONDITION_ROOTS",
    "PROMPT_COMPOSITION_JOIN",
    "ComposedPrompt",
    "FragmentExclusion",
    "PromptCompositionEmpty",
    "build_prompt_scope",
    "compose_prompt",
    "select_prompt_fragments",
    "static_projection",
    "unresolved_prompt_variables",
]

#: The roots a ``when`` may read — the render scope's own (``_prompt_scope``), by name.
AGENT_CONDITION_ROOTS: tuple[str, ...] = (
    "context",
    "trigger",
    "input",
    "vars",
    "nodes",
    "variables",
)

#: The fixed joiner (OD-7). Stamped into the artifact as ``join`` so a later release can widen it
#: without a shape change.
PROMPT_COMPOSITION_JOIN = "\n\n"

_CONDITION_FALSE = "condition_false"
_CONDITION_ERROR = "condition_error"


@dataclass(frozen=True)
class FragmentExclusion:
    """One fragment that did NOT contribute, and why.

    ``detail`` is the evaluator's own message for ``condition_error``. Diagnostic only — it is
    NOT pinned across languages, and it never leaves the process on a telemetry path (OD-11:
    keys only).
    """

    key: str
    reason: str
    detail: str | None = None


@dataclass(frozen=True)
class ComposedPrompt:
    """The composed system prompt plus the evidence of which fragments made it."""

    #: The system prompt, or ``None`` when the agent carries no instruction at all.
    prompt: str | None
    #: Selected fragment KEYS in order — empty for the two single-body shapes.
    selected: list[str] = field(default_factory=list)
    excluded: list[FragmentExclusion] = field(default_factory=list)


class PromptCompositionEmpty(Exception):
    """Every fragment's condition was false or failed. Publish enforces a base fragment (OD-6),
    so this is defensive — and named, because an empty system prompt is worse than a refusal."""

    def __init__(self, excluded: list[FragmentExclusion], template_ref: str | None = None) -> None:
        if template_ref is None:
            message = f"No prompt fragment was selected ({len(excluded)} excluded)."
        else:
            message = (
                f"No prompt fragment of `{template_ref}` was selected ({len(excluded)} excluded)."
            )
        super().__init__(message)
        self.template_ref = template_ref
        self.excluded = excluded


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    """The wire shape, whether it arrived as raw JSON or as the pydantic mirror."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        dumped = dump(by_alias=True)
        return dumped if isinstance(dumped, Mapping) else None
    return None


def _fragments(data: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw = data.get("fragments")
    if not isinstance(raw, Sequence) or isinstance(raw, str | bytes):
        return []
    return [entry for entry in (_as_mapping(item) for item in raw) if entry is not None]


def _content(fragment: Mapping[str, Any]) -> str:
    content = fragment.get("content")
    return content if isinstance(content, str) else ""


def select_prompt_fragments(
    fragments: Sequence[Mapping[str, Any]], scope: Mapping[str, Any]
) -> tuple[list[Mapping[str, Any]], list[FragmentExclusion]]:
    """Select the fragments whose ``when`` holds over ``scope``.

    Pure; never raises; the scope is READ, not written. Mirrors ``selectPromptFragments``.
    """
    selected: list[Mapping[str, Any]] = []
    excluded: list[FragmentExclusion] = []
    context = dict(scope)
    for fragment in fragments:
        when = fragment.get("when")
        if when is None:
            selected.append(fragment)
            continue
        taken, error = evaluate_condition(when, context)
        if error is not None:
            # OD-5 — a branch input this encounter does not carry is "no opinion", not a broken
            # prompt. Excluded and named; never fatal.
            excluded.append(
                FragmentExclusion(
                    key=str(fragment.get("key")), reason=_CONDITION_ERROR, detail=error
                )
            )
            continue
        if not taken:
            excluded.append(
                FragmentExclusion(key=str(fragment.get("key")), reason=_CONDITION_FALSE)
            )
            continue
        selected.append(fragment)
    return selected, excluded


def compose_prompt(
    resolved_prompt: Any, scope: Mapping[str, Any], *, template_ref: str | None = None
) -> ComposedPrompt:
    """The §4.1 algorithm. Raises only what ``render_template`` raises, plus
    ``PromptCompositionEmpty``."""
    data = _as_mapping(resolved_prompt)
    if data is None:
        return ComposedPrompt(prompt=None)

    if data.get("source") != "composite":
        return ComposedPrompt(
            prompt=render_template(_content(data), dict(scope), template_ref=template_ref)
        )

    selected, excluded = select_prompt_fragments(_fragments(data), scope)
    if not selected:
        raise PromptCompositionEmpty(excluded, template_ref)

    join = data.get("join")
    if not isinstance(join, str):
        join = PROMPT_COMPOSITION_JOIN
    # ONE render pass PER fragment, then join — never join-then-render: a `{{` must not be able
    # to pair with a `}}` across a fragment boundary.
    parts = [
        render_template(
            _content(fragment),
            dict(scope),
            template_ref=_fragment_ref(template_ref, str(fragment.get("key"))),
        )
        for fragment in selected
    ]
    return ComposedPrompt(
        prompt=join.join(parts),
        selected=[str(fragment.get("key")) for fragment in selected],
        excluded=excluded,
    )


def _fragment_ref(template_ref: str | None, key: str) -> str:
    return f"#{key}" if template_ref is None else f"{template_ref}#{key}"


def static_projection(
    fragments: Sequence[Mapping[str, Any]], join: str = PROMPT_COMPOSITION_JOIN
) -> str:
    """The unconditional fragments' RAW content joined — what publish stamps as ``content``
    (OD-3), so a reader that predates fragments renders the base prompt rather than none."""
    return join.join(_content(fragment) for fragment in fragments if fragment.get("when") is None)


def unresolved_prompt_variables(resolved_prompt: Any, scope: Mapping[str, Any]) -> list[str]:
    """The placeholders THIS call would fail on, all of them, before rendering — sorted,
    de-duplicated, defaulted ones excluded. Mirrors ``unresolvedPromptVariables``.

    Selection runs first, over the same scope ``compose_prompt`` uses, so a fragment this call
    excludes never asks for anything. An empty selection returns ``[]``: that case is
    ``PromptCompositionEmpty``, a different failure with its own name.
    """
    data = _as_mapping(resolved_prompt)
    if data is None:
        return []
    if data.get("source") == "composite":
        selected, _ = select_prompt_fragments(_fragments(data), scope)
        templates = [_content(fragment) for fragment in selected]
    else:
        templates = [_content(data)]

    # A path is REQUIRED when any one of its occurrences carries no default.
    required: dict[str, bool] = {}
    for template in templates:
        if not template:
            continue
        for reference in template_references(template):
            required[reference.path] = required.get(reference.path, False) or (
                not reference.has_default
            )
    lookup = dict(scope)
    return sorted(
        path
        for path, is_required in required.items()
        if is_required and resolve_template_path(lookup, path) is None
    )


def build_prompt_scope(
    *,
    variables: Mapping[str, Any] | None = None,
    trigger: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
    input: Mapping[str, Any] | None = None,  # noqa: A002 - the scope root is named `input`
    vars: Mapping[str, Any] | None = None,  # noqa: A002 - the scope root is named `vars`
    nodes: Mapping[str, Any] | None = None,
    template_ref: str | None = None,
) -> dict[str, Any]:
    """The ONE render scope. Mirrors ``buildPromptScope`` in ``@arcaai/workflow-contract``.

    ``context`` is the canonical root and ``trigger`` its alias: whichever ONE of the two a
    caller supplies, both resolve to the same object, so a prompt written against either spelling
    renders on every lane. When BOTH are supplied (a workflow run whose trigger is the envelope and
    whose context is its single-kind unwrap) they are kept as given.

    Roots are bound only when present (an absent root is not ``{}``), and BEFORE the bare names, so
    an agent that declares a variable called ``context`` still wins its own name. Each
    ``variables`` entry is a binding — ``{"value": str}`` a literal, ``{"path": str}`` resolved
    against the roots — or a plain value; the resolved map is also exposed as ``variables``.
    """
    scope: dict[str, Any] = {}
    trigger_view = dict(trigger) if isinstance(trigger, Mapping) else None
    context_view = dict(context) if isinstance(context, Mapping) else None
    if trigger_view is not None:
        scope["trigger"] = trigger_view
        scope["context"] = trigger_view
    if context_view is not None:
        scope["context"] = context_view
        if trigger_view is None:
            scope["trigger"] = context_view
    for name, root in (("input", input), ("vars", vars), ("nodes", nodes)):
        if isinstance(root, Mapping):
            scope[name] = dict(root)

    declared = variables if isinstance(variables, Mapping) else {}
    resolved = {
        name: _resolve_binding(
            binding,
            scope,
            template_ref if template_ref is not None else f"instruction.variables.{name}",
        )
        for name, binding in declared.items()
    }
    scope.update(resolved)
    scope["variables"] = resolved
    return scope


def _resolve_binding(binding: Any, scope: dict[str, Any], template_ref: str) -> Any:
    """``{"value": str}`` is a literal, ``{"path": str}`` a reference resolved through the grammar
    (an unresolved one raises ``PromptVariableUnresolved`` naming the path); anything else is the
    value itself."""
    if not isinstance(binding, Mapping):
        return binding
    if isinstance(binding.get("value"), str):
        return binding["value"]
    path = binding.get("path")
    if isinstance(path, str):
        return render_template("{{" + path + "}}", scope, template_ref=template_ref)
    return binding
