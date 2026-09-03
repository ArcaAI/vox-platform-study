"""SOAP sectioning for the interpreter's realtime summary — a faithful Python mirror of
``packages/applications/src/services/consultation/live-documentation/soap-parser.ts``.

## Why a mirror rather than a new format

The interim summary is delivered on the **existing** live-summary plane
(``consultation:live-summary:{id}`` → ``GET /consultations/:id/live-summary/stream`` →
``useArcaLiveSummary``), so the payload this module produces is consumed by the SAME console
panel that renders the default engine's running note. A second sectioning convention would make
a graph-governed consultation look different from a default one for no reason, so the titles,
the "at least two headers to count as structured" rule, the ``Running Summary`` fallback and the
flat-``runningSummary`` reconstitution are all copied deliberately.

## The section titles are NOT resolved per tenant, and that is a verified decision

brief asked to "respect the tenant's ConsultationContextSchema where the existing
path already does". Checked against source on 2026-08-23: **the existing path does not.**
``soap-parser.ts:13`` hardcodes ``['Subjective','Objective','Assessment','Plan']`` and
``live-documentation.service.ts:86`` hardcodes the matching prompt instruction; no
``ConsultationContextSchema`` read exists anywhere in that service. Mirroring it is therefore
matching the shipped contract, not adding a hardcoded taxonomy — and a graph author who wants a
different form supplies ``config.systemPrompt``, which is where a workflow-governed engine's
customization belongs. Making the live plane schema-aware is one change in ONE place (the
default engine) and is recorded as a requested contract rather than forked here.
"""

from __future__ import annotations

import json
import re
from typing import Any

__all__ = [
    "RUNNING_SUMMARY_TITLE",
    "SOAP_OUTPUT_INSTRUCTION",
    "SOAP_RESPONSE_FORMAT",
    "SOAP_SECTION_TITLES",
    "build_running_summary",
    "parse_soap_json",
    "parse_soap_sections",
    "sections_for",
]

#: Canonical section order for a SOAP note (``soap-parser.ts`` ``SOAP_SECTION_TITLES``).
SOAP_SECTION_TITLES: tuple[str, ...] = ("Subjective", "Objective", "Assessment", "Plan")

#: Title used when the model's output cannot be parsed into SOAP sections.
RUNNING_SUMMARY_TITLE = "Running Summary"

_TITLE_BY_KEYWORD = {title.lower(): title for title in SOAP_SECTION_TITLES}
_KEYWORDS = "|".join(_TITLE_BY_KEYWORD)

_HEADER_WITH_COLON = re.compile(
    rf"^\s*(?:#{{1,6}}\s*|[-*>]\s*)*(?:\*\*|__)?\s*({_KEYWORDS})\s*(?:\*\*|__)?\s*:\s*(.*)$",
    re.IGNORECASE,
)
_HEADER_STANDALONE = re.compile(
    rf"^\s*(?:#{{1,6}}\s*|[-*>]\s*)*(?:\*\*|__)?\s*({_KEYWORDS})\s*(?:\*\*|__)?\s*$",
    re.IGNORECASE,
)
_CODE_FENCE = re.compile(r"^```(?:json)?\s*\n?([\s\S]*?)\n?```$", re.IGNORECASE)

#: The prose-provider instruction (``live-documentation.service.ts:86``, verbatim intent).
SOAP_OUTPUT_INSTRUCTION = (
    "Output EXACTLY these four sections, each header on its own line, in this order, "
    "and nothing else:\n\n"
    "Subjective: <patient-reported history and symptoms>\n"
    "Objective: <exam findings, vitals, labs>\n"
    "Assessment: <clinical impressions / diagnoses>\n"
    "Plan: <next steps, medications, follow-up>\n\n"
    "Leave a section blank after its header if there is nothing yet. "
    "Do not invent details or add other sections."
)

#: ``response_format`` for a json-schema-capable provider (``LIVE_SOAP_RESPONSE_FORMAT``).
SOAP_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "strict": True,
    "json_schema": {
        "title": "LiveSOAPNote",
        "type": "object",
        "properties": {
            "subjective": {"type": "string"},
            "objective": {"type": "string"},
            "assessment": {"type": "string"},
            "plan": {"type": "string"},
        },
        "required": ["subjective", "objective", "assessment", "plan"],
    },
}


def _strip_emphasis(value: str) -> str:
    return re.sub(r"[*_\s]+$", "", re.sub(r"^[*_\s]+", "", value))


def _match_header(line: str) -> tuple[str, str] | None:
    with_colon = _HEADER_WITH_COLON.match(line)
    if with_colon:
        return (
            _TITLE_BY_KEYWORD[with_colon.group(1).lower()],
            _strip_emphasis((with_colon.group(2) or "").strip()),
        )
    standalone = _HEADER_STANDALONE.match(line)
    if standalone:
        return _TITLE_BY_KEYWORD[standalone.group(1).lower()], ""
    return None


def parse_soap_sections(raw: str) -> list[dict[str, str]]:
    """Parse running-note prose into the four ordered SOAP sections.

    Requires at least two recognisable headers to count as structured; otherwise returns a
    single ``Running Summary`` section holding the whole text — the same degrade the default
    engine performs, so an unstructured model never costs the clinician the summary.
    """
    text = (raw or "").strip()
    if not text:
        return []

    collected: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        header = _match_header(line)
        if header:
            current, inline = header
            collected.setdefault(current, [])
            if inline:
                collected[current].append(inline)
        elif current is not None:
            collected[current].append(line)

    if len(collected) < 2:
        return [{"title": RUNNING_SUMMARY_TITLE, "content": text}]

    return [
        {"title": title, "content": "\n".join(collected.get(title, [])).strip()}
        for title in SOAP_SECTION_TITLES
    ]


def parse_soap_json(raw: str) -> list[dict[str, str]] | None:
    """Parse a SOAP **JSON** reply into the four ordered sections, or ``None``.

    ``None`` means "this is not SOAP-shaped JSON", so the caller falls back to the tolerant
    prose parser rather than losing the content.
    """
    text = (raw or "").strip()
    if not text:
        return None

    fenced = _CODE_FENCE.match(text)
    try:
        parsed = json.loads(fenced.group(1).strip() if fenced else text)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None

    by_lower_key = {key.lower(): key for key in parsed}
    if not any(title.lower() in by_lower_key for title in SOAP_SECTION_TITLES):
        return None

    def read(title: str) -> str:
        value = parsed.get(by_lower_key.get(title.lower(), ""))
        return value.strip() if isinstance(value, str) else ""

    return [{"title": title, "content": read(title)} for title in SOAP_SECTION_TITLES]


def build_running_summary(sections: list[dict[str, str]]) -> str:
    """Reconstitute the flat text the console renders (and offsets index against)."""
    return "\n\n".join(
        content for section in sections if (content := section.get("content", "").strip())
    )


def sections_for(raw: str) -> tuple[list[dict[str, str]], str]:
    """``(sections, runningSummary)`` for one model reply — JSON first, then prose.

    Mirrors the default engine's own order (strict ``parseSoapJson`` → tolerant
    ``parseSoapSections``) minus its bounded auto-repair retry, which belongs to the engine that
    owns the generation budget, not to a per-window realtime pass.
    """
    sections = parse_soap_json(raw) or parse_soap_sections(raw)
    return sections, build_running_summary(sections)
