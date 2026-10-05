"""Turn the plan's call answers into ONE note: split each answer by heading, merge in template order.

Pure and deterministic. A call writes only the sections the plan gave it — a heading it was not
given is dropped, so two parallel groups can never overwrite each other. ``section_regen`` carries
every ``preserve`` section unchanged from the latest note version.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from harness.services.note_plan.models import NotePlanV1

#: The literal body of a template heading nothing was written under — the same marker the
#: governed finalizer is told never to paraphrase.
NOT_DISCUSSED_MARKER = "Not discussed"

_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(?P<title>.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*```(?:json)?\s*(?P<body>.*?)\s*```\s*$", re.DOTALL)


@dataclass
class ParsedAnswer:
    """One call's answer, restricted to the sections that call was given."""

    sections: dict[str, str] = field(default_factory=dict)
    sources: dict[str, list[str]] = field(default_factory=dict)
    redactions: list[dict[str, Any]] = field(default_factory=list)


def _norm_title(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("_", " ")).strip().strip(":").strip().lower()


def _title_index(plan: NotePlanV1) -> dict[str, str]:
    index: dict[str, str] = {}
    for heading in plan.headings:
        index.setdefault(_norm_title(heading.title), heading.key)
        index.setdefault(_norm_title(heading.key), heading.key)
    return index


def split_sections(text: str, plan: NotePlanV1, section_keys: Sequence[str]) -> dict[str, str]:
    """``text`` split on Markdown headings into ``{sectionKey: body}`` for ``section_keys`` only.

    Text before the first heading belongs to the call's section when the call has exactly one;
    an answer with no recognised heading at all is the call's first section.
    """
    allowed = list(section_keys)
    titles = _title_index(plan)
    buffers: dict[str, list[str]] = {}
    preamble: list[str] = []
    current: str | None = None
    skipping = False
    matched_any = False
    for line in text.splitlines():
        heading = _HEADING.match(line)
        if heading:
            key = titles.get(_norm_title(heading.group("title")))
            if key is not None and key in allowed:
                current, skipping, matched_any = key, False, True
                buffers.setdefault(key, [])
            else:
                current, skipping = None, True
            continue
        if current is not None:
            buffers[current].append(line)
        elif not skipping:
            preamble.append(line)

    sections = {key: "\n".join(lines).strip() for key, lines in buffers.items()}
    lead = "\n".join(preamble).strip()
    if lead and (len(allowed) == 1 or not matched_any):
        target = allowed[0]
        sections[target] = f"{lead}\n\n{sections[target]}".strip() if sections.get(target) else lead
    return {key: body for key, body in sections.items() if body}


def _strip_fence(content: str) -> str:
    fenced = _FENCE.match(content)
    return fenced.group("body") if fenced else content


def _refs_of(entry: Mapping[str, Any]) -> list[str]:
    # The fixture names the list `refs`; the seeded finalizer schema names it `ids`.
    raw = entry.get("refs", entry.get("ids"))
    return (
        [str(item) for item in raw if isinstance(item, str) and item]
        if isinstance(raw, list)
        else []
    )


def parse_answer(content: str, plan: NotePlanV1, section_keys: Sequence[str]) -> ParsedAnswer:
    """One call's answer: the finalizer JSON ``{case_note, redactions, sources}`` or plain text."""
    data: Any = None
    try:
        data = json.loads(_strip_fence(content))
    except (TypeError, ValueError):
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("case_note"), str):
        return ParsedAnswer(sections=split_sections(content, plan, section_keys))

    answer = ParsedAnswer(sections=split_sections(data["case_note"], plan, section_keys))
    redactions = data.get("redactions")
    if isinstance(redactions, list):
        answer.redactions = [item for item in redactions if isinstance(item, dict)]
    sources = data.get("sources")
    if isinstance(sources, list):
        for entry in sources:
            if not isinstance(entry, dict):
                continue
            key = entry.get("sectionKey")
            if isinstance(key, str) and key in section_keys:
                answer.sources.setdefault(key, []).extend(_refs_of(entry))
    return answer


def _dedupe(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def merge_sections(
    plan: NotePlanV1, generated: Mapping[str, str], preserved: Mapping[str, str]
) -> str:
    """The note as headed Markdown in TEMPLATE order.

    A generated section wins; a ``preserve`` section is carried verbatim (its text is required —
    a regenerate that cannot carry the rest of the note fails closed rather than dropping it);
    anything else renders the not-discussed marker.
    """
    preserve_keys = set(plan.preserve.section_keys) if plan.preserve else set()
    missing = [key for key in preserve_keys if key not in preserved]
    if missing:
        raise ValueError(f"preserved section text missing for: {sorted(missing)}")
    parts: list[str] = []
    for heading in plan.headings:
        body = (generated.get(heading.key) or "").strip()
        if not body and heading.key in preserve_keys:
            body = preserved[heading.key].strip()
        parts.append(f"## {heading.title}\n{body or NOT_DISCUSSED_MARKER}")
    return "\n\n".join(parts)


def merge_sources(plan: NotePlanV1, sources: Mapping[str, Sequence[str]]) -> list[dict[str, Any]]:
    """``[{sectionKey, refs}]`` in template order, for sections that cite anything."""
    merged: list[dict[str, Any]] = []
    for heading in plan.headings:
        refs = _dedupe(sources.get(heading.key, ()))
        if refs:
            merged.append({"sectionKey": heading.key, "refs": refs})
    return merged
