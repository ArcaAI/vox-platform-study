"""TASK-1036 §9.3 (OD-30/31/34) — the ``consultation.*`` READ SCHEMA, Python mirror of
``consultation-read-schema.ts``. Held to ``tests/contracts/consultation-read-schema.fixture.json``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from hope_workflow_contract.node_io import io_type_of_json_schema
from hope_workflow_contract.template import template_references

CONSULTATION_READ_SCHEMA_VERSION = 1
CONSULTATION_ROOT = "consultation"

PHI = "PHI"
NON_PHI = "NON_PHI"


def _leaf(type_: str, phi: str, description: str, **extra: Any) -> dict[str, Any]:
    return {"type": type_, **extra, "description": description, "x-phiClass": phi}


def _object(description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "description": description,
        "properties": properties,
    }


def _list(description: str, items: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "description": description, "items": items}


_ATTACHMENT = _object(
    "A file attached to the consultation, by reference.",
    {
        "mediaId": _leaf("string", NON_PHI, "The stored media id (a reference, never the bytes)."),
        "mime": _leaf(
            "string",
            NON_PHI,
            "The media type (`text/plain`, `text/markdown`, `application/pdf`, `image/jpeg`).",
        ),
        "name": _leaf("string", PHI, "The file name as uploaded — may name the patient."),
        "size": _leaf("integer", NON_PHI, "Size in bytes."),
    },
)

_VITAL = _object(
    "One measured vital sign.",
    {
        "name": _leaf(
            "string", NON_PHI, "The vital measured (blood pressure, pulse, temperature, …)."
        ),
        "value": _leaf("string", PHI, "The measured value, as recorded."),
        "unit": _leaf("string", NON_PHI, "The unit of the value."),
        "measuredAt": _leaf("string", PHI, "When it was measured.", format="date-time"),
    },
)

_TEST_RESULT = _object(
    "One investigation result.",
    {
        "name": _leaf(
            "string", PHI, "The investigation (a test name can itself disclose a condition)."
        ),
        "value": _leaf("string", PHI, "The result value, as reported."),
        "unit": _leaf("string", NON_PHI, "The unit of the value."),
        "flag": _leaf("string", PHI, "Abnormal flag or reference-range note, when reported."),
        "takenAt": _leaf(
            "string", PHI, "When the sample was taken or the result reported.", format="date-time"
        ),
    },
)

_PREVIOUS_VISIT = _object(
    "One earlier visit of this patient.",
    {
        "consultationId": _leaf("string", NON_PHI, "The earlier consultation`s id."),
        "date": _leaf("string", PHI, "When the visit took place.", format="date"),
        "department": _leaf("string", NON_PHI, "The department of that visit."),
        "summary": _leaf("string", PHI, "That visit`s note or summary."),
    },
)

_SEGMENT = _object(
    "One transcribed utterance.",
    {
        "text": _leaf("string", PHI, "What was said."),
        "speaker": _leaf("string", PHI, "Who said it (a diarization label or a role)."),
        "start": _leaf("number", NON_PHI, "Seconds from the capture start."),
        "end": _leaf("number", NON_PHI, "Seconds from the capture start."),
    },
)

_ITEM = _object(
    "One context item of the consultation, in arrival order.",
    {
        "id": _leaf("string", NON_PHI, "The context item id."),
        "kind": _leaf(
            "string",
            NON_PHI,
            "What the item is.",
            enum=["CASE_NOTE", "ATTACHMENT", "VITALS", "TEST_RESULT", "PRIOR_VISIT"],
        ),
        "text": _leaf("string", PHI, "The item`s text content (a case note, a formatted result)."),
        "createdAt": _leaf("string", PHI, "When the item was added.", format="date-time"),
        "attachment": _ATTACHMENT,
    },
)

CONSULTATION_READ_SCHEMA_V1: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://arcaai.dev/hope/consultation-read-schema.v1.json",
    "title": "consultation.* — the platform read model of one consultation (v1)",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "id": _leaf("string", NON_PHI, "The consultation id."),
        "visitType": _leaf(
            "string", NON_PHI, "The visit type (for example `new-visit`, `revisit`)."
        ),
        "department": _object(
            "The consultation`s department.",
            {
                "id": _leaf("string", NON_PHI, "The department id."),
                "code": _leaf("string", NON_PHI, "The department code."),
                "name": _leaf("string", NON_PHI, "The department name."),
            },
        ),
        "language": _leaf(
            "string",
            NON_PHI,
            "The SPOKEN language of the consultation (for example `en`, `ml-en`).",
        ),
        "outputLanguage": _object(
            "The language the note is written in (the tenant`s output-language policy).",
            {
                "code": _leaf("string", NON_PHI, "The language code."),
                "name": _leaf("string", NON_PHI, "The language name (for example `English`)."),
            },
        ),
        "patient": _object(
            "The patient, as held on the consultation.",
            {
                "age": _leaf("integer", PHI, "Age in years."),
                "gender": _leaf("string", PHI, "Gender, as recorded."),
                "dob": _leaf("string", PHI, "Date of birth.", format="date"),
            },
        ),
        "clinician": _object(
            "The treating clinician.",
            {
                "dna": _object(
                    "The clinician`s DNA writing profile.",
                    {
                        "style": _leaf(
                            "string",
                            NON_PHI,
                            "The effective writing-style guidance (style, not patient data).",
                        ),
                        "rules": _leaf("string", PHI, "The clinician`s redaction / rewrite rules."),
                    },
                )
            },
        ),
        "transcript": _object(
            "The consultation transcript so far.",
            {
                "text": _leaf(
                    "string", PHI, "The transcript text, utterances joined in spoken order."
                ),
                "segments": _list("Per-utterance timing and speaker.", _SEGMENT),
            },
        ),
        "items": _list(
            "Every context item: case notes, attachments, vitals, tests, prior visits.", _ITEM
        ),
        "notes": _object(
            "The notes generated for this consultation.",
            {
                "preSummary": _leaf("string", PHI, "The pre-summary of the prior record."),
                "summary": _leaf("string", PHI, "The current running note or summary."),
            },
        ),
        "vitals": _list("The measured vitals.", _VITAL),
        "testResults": _list("The investigation results.", _TEST_RESULT),
        "previousVisits": _list("Earlier visits of this patient, newest first.", _PREVIOUS_VISIT),
    },
}


def _phi_of(schema: Mapping[str, Any]) -> str:
    if schema.get("x-phiClass") == PHI:
        return PHI
    properties = schema.get("properties")
    if isinstance(properties, dict) and any(
        _phi_of(child if isinstance(child, dict) else {}) == PHI for child in properties.values()
    ):
        return PHI
    items = schema.get("items")
    if isinstance(items, dict) and _phi_of(items) == PHI:
        return PHI
    return NON_PHI


def _info(path: str, schema: Mapping[str, Any]) -> dict[str, Any]:
    description = schema.get("description")
    return {
        "path": path,
        "type": io_type_of_json_schema(schema),
        "phiClass": _phi_of(schema),
        "description": description if isinstance(description, str) else "",
    }


def consultation_path_info(
    path: str, schema: Mapping[str, Any] = CONSULTATION_READ_SCHEMA_V1
) -> dict[str, Any] | None:
    segments = path.split(".")
    if segments[0] != CONSULTATION_ROOT or len(segments) < 2:
        return None
    current: Any = schema
    for segment in segments[1:]:
        properties = current.get("properties") if isinstance(current, dict) else None
        if not isinstance(properties, dict) or segment not in properties:
            return None
        current = properties[segment]
        if not isinstance(current, dict):
            return None
    return _info(path, current)


def consultation_read_paths(
    schema: Mapping[str, Any] = CONSULTATION_READ_SCHEMA_V1,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk(prefix: str, node: Mapping[str, Any]) -> None:
        properties = node.get("properties")
        if not isinstance(properties, dict):
            return
        for key, child in properties.items():
            if not isinstance(child, dict):
                continue
            path = f"{prefix}.{key}"
            out.append(_info(path, child))
            walk(path, child)

    walk(CONSULTATION_ROOT, schema)
    return out


def _is_consultation_path(path: str) -> bool:
    return path == CONSULTATION_ROOT or path.startswith(f"{CONSULTATION_ROOT}.")


def _template_paths_in(value: Any, out: list[str]) -> None:
    if isinstance(value, str):
        if "{{" in value:
            out.extend(reference.path for reference in template_references(value))
        return
    if isinstance(value, list):
        for entry in value:
            _template_paths_in(entry, out)
        return
    if isinstance(value, dict):
        for entry in value.values():
            _template_paths_in(entry, out)


def node_consultation_reads(config: Mapping[str, Any] | None) -> list[dict[str, str]]:
    by_path: dict[str, str] = {}

    def note(path: str, at: str) -> None:
        if not _is_consultation_path(path):
            return
        if by_path.get(path) != "nodeStart":
            by_path[path] = at

    inputs = (config or {}).get("inputs")
    for binding in inputs.values() if isinstance(inputs, dict) else []:
        if not isinstance(binding, dict):
            continue
        if isinstance(binding.get("from"), str):
            note(binding["from"], "runStart" if binding.get("at") == "runStart" else "nodeStart")
        if isinstance(binding.get("firstOf"), list):
            for path in binding["firstOf"]:
                if isinstance(path, str):
                    note(path, "nodeStart")
    templated: list[str] = []
    _template_paths_in(config, templated)
    for path in templated:
        note(path, "nodeStart")
    return [{"path": path, "at": by_path[path]} for path in sorted(by_path)]


def declared_consultation_reads(graph: Mapping[str, Any]) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            continue
        config = node.get("config") if isinstance(node.get("config"), dict) else None
        reads = node_consultation_reads(config)
        if reads:
            out[node["id"]] = reads
    return out


PLATFORM_CONTEXT_ALIASES: dict[str, dict[str, str]] = {
    "context.current_department": {
        "path": "consultation.department.name",
        "formatting": 'The department name; "General" when unknown.',
    },
    "context.dna_redaction_rules_text": {
        "path": "consultation.clinician.dna.rules",
        "formatting": "The rules as a bullet list; empty when none.",
    },
    "context.dna_style_text": {
        "path": "consultation.clinician.dna.style",
        "formatting": "The effective style text; empty when none.",
    },
    "context.formatted_previous_visits": {
        "path": "consultation.previousVisits",
        "formatting": 'One block per visit, newest first; "" when none.',
    },
    "context.formatted_test_results": {
        "path": "consultation.testResults",
        "formatting": 'One line per result; "" when none.',
    },
    "context.language_name": {
        "path": "consultation.outputLanguage.name",
        "formatting": 'The language name; "English" by default.',
    },
    "context.safe_age": {
        "path": "consultation.patient.age",
        "formatting": 'The age as text; "Unknown" when not held.',
    },
    "context.safe_dob": {
        "path": "consultation.patient.dob",
        "formatting": 'The date as text; "Unknown" when not held.',
    },
    "context.safe_gender": {
        "path": "consultation.patient.gender",
        "formatting": 'The gender as text; "Unknown" when not held.',
    },
    "context.safe_vitals": {
        "path": "consultation.vitals",
        "formatting": 'One line per vital; "Not available" when none.',
    },
    "context.visit_type": {
        "path": "consultation.visitType",
        "formatting": "The visit type as stored.",
    },
}
