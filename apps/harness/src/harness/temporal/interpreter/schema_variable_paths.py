"""The concrete prompt paths a consultation context schema offers, Python half.

Hand-written mirror of ``packages/workflow-contract/src/schema-variable-paths.ts``, held to
``tests/contracts/schema-variable-paths.fixture.json`` by both languages' loaders.

From a ``ConsultationContextSchemaVersion.definition``:

- one entry per declared KIND, ``<root>.<kindKey>``, typed by its platform primitive;
- a ``STRUCTURED`` kind adds each top-level property of its ``fields`` schema,
  ``<root>.<kindKey>.<field>``, typed by the field's JSON Schema ``type`` (a union joined with
  ``|``, ``any`` when undeclared);
- ``outputs`` are ignored.

The SOLE-KIND COLLAPSE: under ``root == "context"``, a definition whose only kind is keyed
``context`` offers that kind's fields as ``context.<field>`` (and not the kind itself) — the render
scope binds the kind's own object there. Under ``trigger`` the envelope is kept.

``phi_class`` is the KIND's and is inherited by its fields; ``deprecated`` is a kind's
``deprecated`` block, a field's ``deprecated: true``, or the field's kind being deprecated. An
inline payload JSON Schema (no ``kinds``) is read one level deep with no PHI class. Sorted by path;
total — anything unreadable yields ``[]``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

__all__ = ["SchemaVariablePath", "schema_variable_paths"]

_SOLE_CONTEXT_KIND_KEY = "context"


@dataclass(frozen=True)
class SchemaVariablePath:
    path: str
    type: str
    required: bool
    phi_class: str | None
    description: str | None
    deprecated: bool

    def as_dict(self) -> dict[str, Any]:
        """The wire shape, camelCase like the TypeScript half."""
        return {
            "path": self.path,
            "type": self.type,
            "required": self.required,
            "phiClass": self.phi_class,
            "description": self.description,
            "deprecated": self.deprecated,
        }


def _as_object(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _json_type(schema: Mapping[str, Any] | None) -> str:
    kind = schema.get("type") if schema is not None else None
    if isinstance(kind, str) and kind:
        return kind
    if isinstance(kind, list):
        names = [entry for entry in kind if isinstance(entry, str) and entry]
        if names:
            return "|".join(names)
    return "any"


def _required_names(schema: Mapping[str, Any] | None) -> set[str]:
    required = schema.get("required") if schema is not None else None
    if not isinstance(required, list):
        return set()
    return {entry for entry in required if isinstance(entry, str)}


def _field_paths(
    prefix: str, schema: Any, phi_class: str | None, deprecated: bool
) -> list[SchemaVariablePath]:
    document = _as_object(schema)
    properties = _as_object(document.get("properties")) if document is not None else None
    if properties is None:
        return []
    required = _required_names(document)
    entries: list[SchemaVariablePath] = []
    for name, raw in properties.items():
        field_schema = _as_object(raw)
        entries.append(
            SchemaVariablePath(
                path=f"{prefix}.{name}",
                type=_json_type(field_schema),
                required=name in required,
                phi_class=phi_class,
                description=_string_or_none(
                    field_schema.get("description") if field_schema is not None else None
                ),
                deprecated=deprecated
                or (field_schema is not None and field_schema.get("deprecated") is True),
            )
        )
    return entries


def schema_variable_paths(definition: Any, root: str = "context") -> list[SchemaVariablePath]:
    """Mirrors ``schemaVariablePaths``."""
    document = _as_object(definition)
    if document is None:
        return []

    raw_kinds = document.get("kinds")
    if isinstance(raw_kinds, list):
        kinds = [
            kind
            for kind in (_as_object(entry) for entry in raw_kinds)
            if kind is not None and isinstance(kind.get("key"), str) and kind.get("key")
        ]
        collapse = (
            root == "context" and len(kinds) == 1 and kinds[0].get("key") == _SOLE_CONTEXT_KIND_KEY
        )
        entries: list[SchemaVariablePath] = []
        for kind in kinds:
            key = kind["key"]
            phi_class = _string_or_none(kind.get("phiClass"))
            deprecated = (
                _as_object(kind.get("deprecated")) is not None or kind.get("deprecated") is True
            )
            structured = kind.get("primitive") == "STRUCTURED"
            if collapse:
                if structured:
                    entries.extend(_field_paths(root, kind.get("fields"), phi_class, deprecated))
                continue
            primitive = kind.get("primitive")
            entries.append(
                SchemaVariablePath(
                    path=f"{root}.{key}",
                    type=primitive if isinstance(primitive, str) and primitive else "any",
                    required=kind.get("required") is True,
                    phi_class=phi_class,
                    description=_string_or_none(kind.get("description")),
                    deprecated=deprecated,
                )
            )
            if structured:
                entries.extend(
                    _field_paths(f"{root}.{key}", kind.get("fields"), phi_class, deprecated)
                )
        return sorted(entries, key=lambda entry: entry.path)

    properties = _as_object(document.get("properties"))
    if properties is None:
        return []
    required = _required_names(document)
    entries = []
    for key, raw in properties.items():
        schema = _as_object(raw)
        deprecated = schema is not None and schema.get("deprecated") is True
        entries.append(
            SchemaVariablePath(
                path=f"{root}.{key}",
                type=_json_type(schema),
                required=key in required,
                phi_class=None,
                description=_string_or_none(
                    schema.get("description") if schema is not None else None
                ),
                deprecated=deprecated,
            )
        )
        entries.extend(_field_paths(f"{root}.{key}", schema, None, deprecated))
    return sorted(entries, key=lambda entry: entry.path)
