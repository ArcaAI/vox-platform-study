"""TASK-1001 (owner decision OD-12, 2026-09-23) — the note's OUTPUT language on the DURABLE lane.

    *"ALaaS still sends the language: `ml-en` indicates code-mixed/code-switch enabled for
    realtime/job transcription, Malayalam as main language. The summarization (both pre-summary
    and summary) is still in English by admin configuration OR by default."*

A consultation's declared ``language`` (``ml-en``, the STT code-switch mode) is the SOURCE
language — what is spoken. It never chooses what a note is written in. The OUTPUT language
resolves in exactly two tiers, and the source tag is in neither:

1. the tenant's POLICY — a composite-instruction fragment under the platform-reserved key
   :data:`OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY`, when it is SELECTED for the generation. Its text
   owns the language, so nothing is added;
2. otherwise the PLATFORM DEFAULT — the registry key :data:`CONSULTATION_OUTPUT_LANGUAGE_KEY`
   (``global-kv``, platform scope, English unless a platform admin changes it), which the runtime
   STATES with :func:`default_output_language_step`.

The live (realtime) lane has done this since TASK-1001 L5, in ``operatingFrame``
(``live-documentation.service.ts`` in ``packages/applications``). The durable lane had no such
step, so a SYSTEM agent whose body says "write … in the conversation language ({{language}})" —
``general-medicine-summarization``, which ``platform-default-summarization`` runs durably — let
the source tag decide the note's language. This module is the Python half of that rule;
``nodes/core.py::_run_text_generation`` applies it.

Hand-written mirror of the gateway's own definitions, each pinned by a parity test that reads the
TypeScript source (``tests/unit/temporal/interpreter/test_task1001_default_output_language.py``):

* :data:`OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY` — ``packages/types/src/agent.ts``;
* :data:`CONSULTATION_OUTPUT_LANGUAGE_KEY` — ``consultation-output-language.descriptors.ts``;
* :data:`OUTPUT_LANGUAGE_DEFAULT`, :data:`OUTPUT_LANGUAGE_PATTERN_SOURCE` (the OUTPUT grammar,
  ``SUMMARY_LANGUAGE_PATTERN``) and :data:`LANGUAGE_NAMES` (``summaryLanguageName``) —
  ``consultation/consultation/summary-language.ts``;
* the step's wording — ``defaultOutputLanguageStep`` in ``live-documentation.service.ts``.

Pure: no I/O and no Temporal import. The setting is READ by the ``interpreter.core_agent``
activity (``core._output_language_snapshot``) and handed to :func:`resolve_platform_output_language`
as a snapshot, so nothing here can reach workflow code or carry a replay obligation.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import structlog

from harness.temporal.interpreter.prompt_composition import PROMPT_COMPOSITION_JOIN

__all__ = [
    "CONSULTATION_OUTPUT_LANGUAGE_KEY",
    "DEFAULT_OUTPUT_LANGUAGE_STEP_TEMPLATE",
    "LANGUAGE_NAMES",
    "OUTPUT_LANGUAGE_DEFAULT",
    "OUTPUT_LANGUAGE_PATTERN_SOURCE",
    "OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY",
    "OutputLanguage",
    "append_default_output_language_step",
    "default_output_language_step",
    "output_language_policy_selected",
    "parse_output_language_tag",
    "platform_output_language",
    "resolve_platform_output_language",
    "summary_language_name",
]

logger = structlog.get_logger(__name__)

#: The PLATFORM-RESERVED fragment key a tenant states its note output-language policy under.
#: Mirrors ``OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY`` in ``packages/types/src/agent.ts``.
OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY = "output_language_policy"

#: The registry key of the platform-default note output language, served to this service on
#: ``GET /internal/effective-config?service=harness`` (``consumedBy: ['harness']``).
CONSULTATION_OUTPUT_LANGUAGE_KEY = "consultation.summary.outputLanguage"

#: The descriptor's code default — the answer when the control plane has no usable value.
OUTPUT_LANGUAGE_DEFAULT = "en"

#: The OUTPUT-language grammar, verbatim from ``SUMMARY_LANGUAGE_PATTERN`` (flag ``i``): a BCP-47
#: subset that REFUSES an STT code-switch mode (``ml-en``) — a note is written in ONE language.
OUTPUT_LANGUAGE_PATTERN_SOURCE = (
    r"^[A-Za-z]{2,3}(?!-(?:en|ml|hi|ta|kn|te)(?:-|$))(-[A-Za-z0-9]{2,8}){0,3}$"
)
_OUTPUT_LANGUAGE_PATTERN = re.compile(OUTPUT_LANGUAGE_PATTERN_SOURCE, re.IGNORECASE)

#: Primary subtag → the NAME a prompt states. Deliberately tiny, like ``summaryLanguageName``: a
#: tag outside it is stated verbatim — a model reads ``fr`` correctly; it cannot read a wrong name.
LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "ml": "Malayalam",
    "hi": "Hindi",
    "ta": "Tamil",
    "kn": "Kannada",
    "te": "Telugu",
}

#: The live lane's proven text, with ``{language_name}`` where the TypeScript template literal
#: has ``${languageName}``. Three clauses, each load-bearing (see ``defaultOutputLanguageStep``):
#: the language BY NAME; the override NAMED, because a generic label loses to the clinical
#: corpus's specific "write in the conversation language" clause; and the headings clause,
#: verbatim, because a translated heading makes ALaaS insert a twin section (finding S-4).
DEFAULT_OUTPUT_LANGUAGE_STEP_TEMPLATE = (
    "Write every section value in {language_name}, whatever language was spoken, regardless of "
    "any instruction elsewhere in this prompt to write content in the conversation language. "
    "Keep the section keys and headings exactly as given, in English."
)


@dataclass(frozen=True)
class OutputLanguage:
    """A resolved note output language: the tag, and the name a prompt states."""

    tag: str
    name: str


def parse_output_language_tag(value: Any) -> str | None:
    """A non-blank OUTPUT-grammar tag (trimmed), or ``None``. Mirrors ``parseLanguageTag``."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed if trimmed and _OUTPUT_LANGUAGE_PATTERN.match(trimmed) else None


def summary_language_name(tag: str | None) -> str | None:
    """The human-readable NAME of a tag, or the tag itself when it is not one of the platform's own.

    Mirrors ``summaryLanguageName``: the PRIMARY subtag decides (``en-IN`` → English).
    """
    if not tag:
        return None
    return LANGUAGE_NAMES.get(tag.split("-")[0].lower(), tag)


def platform_output_language(value: Any) -> OutputLanguage:
    """The platform-default output language from the setting's resolved value.

    Mirrors ``platformOutputLanguage``: anything that is not a valid OUTPUT tag — unset, blank, a
    display name, or a code-switch mode that somehow bypassed the write lane's ``validate`` —
    falls to :data:`OUTPUT_LANGUAGE_DEFAULT`. The note must still be written in one NAMED
    language; "no instruction" is the failure this exists to remove.
    """
    tag = parse_output_language_tag(value) or OUTPUT_LANGUAGE_DEFAULT
    return OutputLanguage(tag=tag, name=summary_language_name(tag) or tag)


def resolve_platform_output_language(snapshot: Any | None) -> OutputLanguage:
    """The platform default off one control-plane snapshot — FAIL OPEN to English, never raises.

    Same degradation contract as ``resolve_judge_reasoning`` / ``resolve_sensor_thresholds``, and
    the same posture as the gateway's ``resolvePlatformOutputLanguage`` (``failMode:
    'open-to-default'``):

    * no snapshot, or a snapshot from a FAILED pull (``ok=False``) — an unreachable control plane
      must not cost a clinician a note, so the code default is stated;
    * an absent key or a ``null`` value — no opinion, so the code default;
    * a value outside the OUTPUT grammar — REFUSED and logged, then the code default. It is never
      coerced (``ml-en`` → "Malayalam" is exactly the collapse this ticket removed).
    """
    if snapshot is None or not getattr(snapshot, "ok", False):
        return platform_output_language(None)
    try:
        value = snapshot.setting(CONSULTATION_OUTPUT_LANGUAGE_KEY)
    except Exception as exc:  # noqa: BLE001 — a config read must never fail a generation
        logger.warning(
            "harness.output_language.unreadable",
            key=CONSULTATION_OUTPUT_LANGUAGE_KEY,
            error_type=type(exc).__name__,
        )
        return platform_output_language(None)
    if value is not None and parse_output_language_tag(value) is None:
        logger.warning(
            "harness.output_language.refused",
            key=CONSULTATION_OUTPUT_LANGUAGE_KEY,
            reason="not ONE BCP-47 output language tag",
        )
    return platform_output_language(value)


def default_output_language_step(language_name: str) -> str:
    """The step that states the platform default BY NAME. Mirrors ``defaultOutputLanguageStep``."""
    return DEFAULT_OUTPUT_LANGUAGE_STEP_TEMPLATE.format(language_name=language_name)


def output_language_policy_selected(selected_fragments: Sequence[str] | None) -> bool:
    """Was the tenant's output-language policy fragment SELECTED for this generation?

    "Selected" in exactly ``compose_prompt``'s sense — the keys it reports on
    ``ComposedPrompt.selected``: present, and its ``when`` absent or held. A policy whose condition
    was false or unevaluable is EXCLUDED there, so nothing in the rendered instruction states a
    language and the platform default must. A single-body instruction selects no fragment at all.
    """
    return OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY in (selected_fragments or ())


def append_default_output_language_step(
    prompt: str | None,
    selected_fragments: Sequence[str] | None,
    language: OutputLanguage,
) -> str | None:
    """The system prompt a note-writing generation SENDS: the composed instruction, then — only
    when no tenant policy was selected — the platform default's step as its own final paragraph.

    * policy SELECTED ⇒ ``prompt`` unchanged. The tenant's text owns the language; a second,
      generated statement beside it would be two answers to one question.
    * otherwise ⇒ ``prompt`` + :data:`PROMPT_COMPOSITION_JOIN` + the step. LAST on purpose: it
      follows, names and overrides any "write in the conversation language" clause the instruction
      carries (the seeded ``general-medicine-summarization`` body's item 5 does exactly that).
    * no instruction at all ⇒ the step alone, because "English by default" does not depend on
      whether the author wrote a system prompt.
    """
    if output_language_policy_selected(selected_fragments):
        return prompt
    step = default_output_language_step(language.name)
    return f"{prompt}{PROMPT_COMPOSITION_JOIN}{step}" if prompt else step
