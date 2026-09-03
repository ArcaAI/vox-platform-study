"""N-1 — input.context_binding.

Declares the run's input shape (``config.contextSchema``) and binds the run's invocation payload
(``NodeActivityInput.run_payload``) to it (``config.bindings``). Config shape:
``{contextSchema: {schemaVersion, kinds: [...], outputs?}, bindings: [{kindKey, from}]}`` — see
``contracts/nodes/input.context_binding.schema.json``.

``bindings[].from`` is a dotted path (e.g. ``'payload.text'``) resolved against
``{"payload": run_payload}`` — the literal ``'payload'`` prefix is this palette's own addressing
convention (not a JSON-Schema-defined path language), matching the seeded platform-default
definition (``packages/database/.../seed/21-workflow-definition.ts``).

Registry: ``critical=True`` (palette.md — a run that cannot bind its declared input has produced
nothing usable). A binding problem therefore returns ``DEGRADED``, which the interpreter promotes
to ``FAILED`` for a critical node — never silently proceeds with a partial/missing bind.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    MISSING,
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
    resolve_dotted_path,
)

_TEXT_PRIMITIVES = {"TEXT"}
_STRUCTURED_PRIMITIVES = {"STRUCTURED"}


def _bind(config: dict[str, Any], run_payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Pure — resolve every declared binding. Returns ``(bound, problems)``; `bound` carries
    only the kinds that resolved cleanly (a problem for a non-required kind still omits it from
    `bound` rather than binding a wrong-shaped value)."""
    context_schema = config.get("contextSchema") or {}
    kinds_by_key: dict[str, dict[str, Any]] = {
        k["key"]: k for k in context_schema.get("kinds") or []
    }
    root = {"payload": run_payload}

    bound: dict[str, Any] = {}
    problems: list[str] = []
    for binding in config.get("bindings") or []:
        kind_key = binding.get("kindKey")
        from_path = binding.get("from", "")
        kind = kinds_by_key.get(kind_key)
        if kind is None:
            problems.append(f"binding references undeclared kind {kind_key!r}")
            continue

        value = resolve_dotted_path(root, from_path)
        if value is MISSING:
            if kind.get("required", True):
                problems.append(
                    f"required kind {kind_key!r} (from {from_path!r}) missing from run payload"
                )
            continue

        primitive = kind.get("primitive")
        if primitive in _TEXT_PRIMITIVES and not isinstance(value, str):
            problems.append(f"kind {kind_key!r} declared TEXT but the bound value is not a string")
            continue
        if primitive in _STRUCTURED_PRIMITIVES and isinstance(value, str):
            # STRUCTURED accepts anything JSON-shaped that is not itself a bare string —
            # a bare string is exactly what TEXT is for; reject the ambiguity rather than
            # silently accepting either primitive for any value.
            problems.append(
                f"kind {kind_key!r} declared STRUCTURED but the bound value is a bare string"
            )
            continue

        bound[kind_key] = value

    return bound, problems


@activity.defn(name="interpreter.context_binding")
async def interpreter_context_binding(payload: NodeActivityInput) -> NodeActivityResult:
    started = now()
    bound, problems = _bind(payload.config, payload.run_payload)

    if problems:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="context_binding_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason="; ".join(problems))

    await record_and_flush(payload, status=STATUS_OK, started=started)
    # the bound kinds are published UNDER `context`, not as the whole output
    # dict. This node's `out` socket is typed `context<schemaRef>`, and every data socket must
    # name the output key it carries so `_resolve_bound_inputs` can thread it: `{kindKey: value}`
    # at the top level offered no such key, which left only the whole-object fallback — the
    # untyped bundle the port vocabulary exists to abolish. Downstream is unaffected in
    # substance: `generate.text` receives exactly the same dict, now on a typed socket.
    return NodeActivityResult(status="SUCCEEDED", output={"context": bound})
