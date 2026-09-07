"""Language-mode catalog and per-engine capability matrix.

The gateway/SDK let an end user pick a *language mode* for the STT pipeline —
a single language ("English", "Malayalam"), a bilingual code-switch mode
("Malayalam + English"), or auto-detect. Because the STT engines diverge
sharply on what they can serve (e.g. NEMO/Parakeet-v3 has no Malayalam and
ignores code-switching; OpenAI is single-language; Sarvam code-switches at the
model level; Azure via an auto-detect flag; Whisper via a separate translate
gloss), a raw language string cannot be validated uniformly.

This module is the **single, backend-authoritative source of truth**:

* ``LANGUAGE_MODE_CATALOG`` — the closed set of selectable modes.
* ``engine_supports_mode`` / ``engines_supporting_mode`` /
  ``modes_supported_by_engine`` — the capability matrix, derived from the facts
  already encoded in :mod:`stt.pipeline.dto` (``is_valid_language_for_engine``,
  ``VALID_WHISPER_LANGUAGES``, ``VALID_PARAKEET_V3_LANGUAGES``) plus each
  engine's code-switch behaviour.
* ``resolve_mode_for_engine`` — translates a mode into the existing
  :class:`~stt.pipeline.dto.InferenceConfig` fields (``language``,
  ``code_switching``, ``streaming_english_gloss``) for a concrete engine, or
  raises :class:`LanguageModeUnsupportedError` when the engine cannot serve it.

"Selection constrains providers": at session-create the mode is resolved
against the engine that will actually serve the session. An engine that cannot
serve the mode is excluded from the session's chain (the fallback path picks it
up); if no configured engine qualifies, the create request is rejected (422).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from stt.pipeline.dto import AiModelFormat, is_valid_language_for_engine

LanguageModeKind = Literal["single", "code_switch", "auto"]

# --- Code-switch capability per engine ---------------------------------------
# How each engine realises a bilingual "X + English" mode:
#   "native" — the model handles mixed-language audio itself (no flag needed).
#   "flag"   — enable an auto-detect / code-switch flag on the engine.
#   "gloss"  — native transcript + a second English-translation pass
#              (``streaming_english_gloss``); only meaningful when the secondary
#              language is English.
#   "prompt" — prime the decoder with a bilingual ``initial_prompt`` to elicit
#              native code-switch transcription (whisper.cpp: no task=translate
#              gloss, but pywhispercpp accepts an initial_prompt).
#   None     — the engine cannot code-switch at all.
CodeSwitchCapability = Literal["native", "flag", "gloss", "prompt"]

_WHISPER_FAMILY: frozenset[AiModelFormat] = frozenset(
    {
        AiModelFormat.SAFETENSOR,
        AiModelFormat.PYTORCH,
        AiModelFormat.ONNX,
        AiModelFormat.ONNX_OPTIMUM,
        AiModelFormat.CTRANSLATE2,
        AiModelFormat.FASTER_WHISPER,
    }
)

# Sarvam (saaras) is Indic + English ONLY — it is NOT a Whisper-set superset, so
# the generic Whisper-set proxy in `is_valid_language_for_engine` would wrongly
# claim e.g. Vietnamese support. Keep this in sync with
# `_SARVAM_LANGUAGE_ALIASES` in `streaming/sarvam_asr.py` (its keys + 'en').
_SARVAM_LANGUAGES: frozenset[str] = frozenset(
    {
        "as",
        "bn",
        "brx",
        "doi",
        "en",
        "gu",
        "hi",
        "kn",
        "kok",
        "ks",
        "mai",
        "ml",
        "mni",
        "mr",
        "ne",
        "od",
        "pa",
        "sa",
        "sat",
        "sd",
        "ta",
        "te",
        "ur",
    }
)

_CODE_SWITCH_CAPABILITY: dict[AiModelFormat, CodeSwitchCapability] = {
    # Sarvam saaras:v4 handles bilingual audio natively (sarvam_loader.py).
    AiModelFormat.SARVAM: "native",
    # Azure Speech: code_switching -> AutoDetectSourceLanguageConfig (azure_asr.py).
    AiModelFormat.AZURE_SPEECH: "flag",
    # whisper.cpp (pywhispercpp) has no task=translate gloss, but DOES accept an
    # initial_prompt (whisper_cpp_asr.py passes it into model.transcribe). A
    # bilingual priming prompt elicits native code-switch transcription from a
    # code-switch-capable GGUF — e.g. the seeded ArcaAI ml-en model.
    AiModelFormat.WHISPER_CPP: "prompt",
    # Whisper family: native transcript + English gloss via task=translate.
    **dict.fromkeys(_WHISPER_FAMILY, "gloss"),
    # NEMO/Parakeet ignore code_switching; parakeet.cpp has no translate/prompt;
    # OpenAI is single-language; Azure Foundry is batch/preview.
    # (absent => not code-switch capable)
}

# Every engine format in the platform catalog. The "entire engine catalog"
# scope intersects mode support across ALL of these.
CATALOG_ENGINES: tuple[AiModelFormat, ...] = tuple(AiModelFormat)


@dataclass(frozen=True)
class LanguageMode:
    """A selectable STT language mode."""

    id: str
    label: str
    kind: LanguageModeKind
    primary_language: str | None = None  # ISO 639-1; None for auto
    secondary_language: str | None = None  # for code_switch (e.g. "en")


# --- The closed catalog ------------------------------------------------------
# Extending this is DATA, not code. Ordering is display order.
LANGUAGE_MODE_CATALOG: tuple[LanguageMode, ...] = (
    LanguageMode(id="en", label="English", kind="single", primary_language="en"),
    LanguageMode(id="ml", label="Malayalam", kind="single", primary_language="ml"),
    LanguageMode(
        id="ml-en",
        label="Malayalam + English",
        kind="code_switch",
        primary_language="ml",
        secondary_language="en",
    ),
    LanguageMode(id="vi", label="Vietnamese", kind="single", primary_language="vi"),
    LanguageMode(
        id="vi-en",
        label="Vietnamese + English",
        kind="code_switch",
        primary_language="vi",
        secondary_language="en",
    ),
    LanguageMode(id="auto", label="Auto-detect", kind="auto"),
)

LANGUAGE_MODES_BY_ID: dict[str, LanguageMode] = {m.id: m for m in LANGUAGE_MODE_CATALOG}


# ISO 639-1 → human-readable language name, for the code-switch priming prompt.
# Covers every language used by the catalog above.
_LANGUAGE_DISPLAY_NAMES: dict[str, str] = {
    "en": "English",
    "ml": "Malayalam",
    "vi": "Vietnamese",
}

# Priming prompt used to elicit code-switch transcription from prompt-capable
# engines (whisper.cpp). Whisper's ``initial_prompt`` is decoder prior-context
# (≤224 tokens), NOT a chat system prompt — but a concise bilingual instruction
# reliably biases the model to transcribe (not translate) each language and to
# not commit to a single language on mixed audio. Kept short so it stays well
# within the token budget once per-utterance carry-forward text is appended.
_CODE_SWITCH_PROMPT_TEMPLATE = (
    "You are a professional transcriber, fluent in {primary} and {secondary}. "
    "You are listening to a recording in which a person is potentially speaking "
    "both {primary} and {secondary}, and no other languages. They may be "
    "speaking only one of these languages. They may have a strong accent. You "
    "are to transcribe utterances of each language accordingly."
)


def _language_name(code: str) -> str:
    """Human-readable language name for *code* (falls back to the code itself)."""
    return _LANGUAGE_DISPLAY_NAMES.get(code.split("-")[0].lower(), code)


def build_code_switch_prompt(primary_language: str, secondary_language: str) -> str:
    """Build the bilingual code-switch priming prompt for a prompt-capable engine."""
    return _CODE_SWITCH_PROMPT_TEMPLATE.format(
        primary=_language_name(primary_language),
        secondary=_language_name(secondary_language),
    )


# Single-language priming prompt — the one-language counterpart of the bilingual
# template above. Emitted for single-language modes (e.g. "English only") on
# prompt-capable engines so a code-switch-fine-tuned GGUF is told to stay in the
# chosen language rather than drifting into the other one.
_SINGLE_LANGUAGE_PROMPT_TEMPLATE = (
    "You are a professional transcriber, fluent in {language}. You are listening "
    "to a recording in which a person is speaking {language}, and no other "
    "language. They may have a strong accent. You are to transcribe their speech "
    "in {language} accurately."
)


def build_single_language_prompt(language: str) -> str:
    """Build the single-language priming prompt for a prompt-capable engine."""
    return _SINGLE_LANGUAGE_PROMPT_TEMPLATE.format(language=_language_name(language))


# TEMPORARY kill-switches: the whisper.cpp priming prompt is an instruction-style
# ``initial_prompt``, which degrades raw whisper.cpp decoding — Whisper conditions
# on it as prior context, not as an instruction, and the fine-tuned ml-en GGUF
# already code-switches natively. Disabled while we evaluate quality. whisper.cpp
# STILL serves the modes (no cloud fallback); it just resolves to the language
# settings with NO prompt.
#
# TASK-891 A3 — this used to be ONE flag covering both prompt shapes, so the two
# could not be evaluated apart. They are not the same experiment:
#
# * The PAIR prompt is the code-switch mode's ONLY bias correction. A pair pins
#   no language (pinning the primary biases the secondary's script), so with the
#   prompt off the decoder gets no language signal at all and re-runs its own LID
#   independently on every decode window — the measured "half Malayalam, half
#   English inside one sentence".
# * The SINGLE-language prompt sits on top of an already-pinned ``language=``
#   token, so it is largely redundant and mostly adds the risk that Whisper
#   transcribes the instruction text into the output.
#
# Both still default OFF: turning either on is a DECODE-QUALITY change and needs
# a measured A/B on held-out English AND Malayalam recordings on this exact
# ml-en fine-tune — which is why they were switched off in the first place.
# Flip one at a time; the behaviour of each is covered by its own test.
WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED = False
WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = False


def _is_pair_prompt_capable(engine: AiModelFormat) -> bool:
    """Whether *engine* takes the BILINGUAL priming prompt (whisper.cpp).

    Gated by :data:`WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED`; while that is off
    a code-switch pair resolves with no prompt. The capability matrix itself is
    unaffected — the engine still SERVES the code-switch modes.
    """
    return (
        WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED
        and _CODE_SWITCH_CAPABILITY.get(engine) == "prompt"
    )


def _is_single_prompt_capable(engine: AiModelFormat) -> bool:
    """Whether *engine* takes the SINGLE-LANGUAGE priming prompt (whisper.cpp).

    Gated by :data:`WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED`, independently of
    the pair switch above.
    """
    return (
        WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED
        and _CODE_SWITCH_CAPABILITY.get(engine) == "prompt"
    )


@dataclass(frozen=True)
class ResolvedInference:
    """The InferenceConfig fields a mode resolves to for a concrete engine."""

    language: str | None
    code_switching: bool
    streaming_english_gloss: bool
    # Bilingual priming prompt for prompt-capable engines (whisper.cpp); None for
    # every other engine/mode. Threaded into the session's initial_prompt.
    initial_prompt: str | None = None


class LanguageModeUnsupportedError(Exception):
    """Raised when an engine cannot serve the requested language mode.

    Carries the engines/modes context so the caller can build a 422 that tells
    the client which modes ARE available.
    """

    def __init__(self, mode_id: str, engine: AiModelFormat) -> None:
        self.mode_id = mode_id
        self.engine = engine
        self.supported_mode_ids = modes_supported_by_engine(engine)
        super().__init__(
            f"Language mode '{mode_id}' is not supported by the "
            f"{engine.value} engine. Supported modes: "
            f"{', '.join(self.supported_mode_ids) or '(none)'}"
        )


def get_language_mode(mode_id: str) -> LanguageMode:
    """Return the catalog mode for *mode_id* or raise ``KeyError``."""
    return LANGUAGE_MODES_BY_ID[mode_id]


def _engine_serves_language(language: str, engine: AiModelFormat) -> bool:
    """Whether *engine* can transcribe *language* (primary subtag).

    Special-cases Sarvam (Indic + English only) against its real language set;
    all other engines defer to the shared `is_valid_language_for_engine`.
    """
    if engine == AiModelFormat.SARVAM:
        return language.split("-")[0].lower() in _SARVAM_LANGUAGES
    return is_valid_language_for_engine(language, engine)


def engine_supports_mode(mode: LanguageMode, engine: AiModelFormat) -> bool:
    """Whether *engine* can serve *mode*."""
    if mode.kind == "auto":
        # Every engine can run without a pinned language (its own LID/default).
        return True
    if mode.kind == "single":
        assert mode.primary_language is not None
        return _engine_serves_language(mode.primary_language, engine)
    # code_switch
    capability = _CODE_SWITCH_CAPABILITY.get(engine)
    if capability is None:
        return False
    assert mode.primary_language is not None and mode.secondary_language is not None
    if capability == "gloss":
        # Whisper translate produces English; only "... + English" is meaningful.
        return mode.secondary_language == "en" and _engine_serves_language(
            mode.primary_language, engine
        )
    # native / flag: both languages must be servable by the engine.
    return _engine_serves_language(mode.primary_language, engine) and _engine_serves_language(
        mode.secondary_language, engine
    )


def resolve_mode_for_engine(mode_id: str, engine: AiModelFormat) -> ResolvedInference:
    """Resolve *mode_id* to InferenceConfig fields for *engine*.

    Raises
    ------
    KeyError
        If *mode_id* is not in the catalog.
    LanguageModeUnsupportedError
        If *engine* cannot serve the mode.
    """
    mode = get_language_mode(mode_id)
    if not engine_supports_mode(mode, engine):
        raise LanguageModeUnsupportedError(mode_id, engine)

    if mode.kind == "auto":
        return ResolvedInference(language=None, code_switching=False, streaming_english_gloss=False)
    if mode.kind == "single":
        assert mode.primary_language is not None
        # Prompt-capable engines (whisper.cpp) also get a single-language priming
        # prompt so a code-switch model stays in the chosen language; every other
        # engine relies on the pinned language token alone.
        single_prompt = (
            build_single_language_prompt(mode.primary_language)
            if _is_single_prompt_capable(engine)
            else None
        )
        return ResolvedInference(
            language=mode.primary_language,
            code_switching=False,
            streaming_english_gloss=False,
            initial_prompt=single_prompt,
        )
    # code_switch — realise per the engine's capability.
    capability = _CODE_SWITCH_CAPABILITY[engine]
    if capability == "flag":
        return ResolvedInference(
            language=mode.primary_language, code_switching=True, streaming_english_gloss=False
        )
    if capability == "gloss":
        return ResolvedInference(
            language=mode.primary_language, code_switching=False, streaming_english_gloss=True
        )
    if capability == "prompt":
        # whisper.cpp: a *pair* is "may speak either/both", so do NOT pin a
        # language — pinning the primary would bias the secondary language toward
        # the primary's script. Leave language unset and let the native
        # code-switch model, primed by the bilingual prompt, transcribe each
        # language. No translate gloss.
        assert mode.primary_language is not None and mode.secondary_language is not None
        pair_prompt = (
            build_code_switch_prompt(mode.primary_language, mode.secondary_language)
            if _is_pair_prompt_capable(engine)
            else None
        )
        return ResolvedInference(
            language=None,
            code_switching=False,
            streaming_english_gloss=False,
            initial_prompt=pair_prompt,
        )
    # native — the model handles the mix itself (Sarvam Saaras). Signal
    # code_switching so the Sarvam integration requests code-mixed output
    # (mode="codemix"). `language` is retained (the primary, e.g. "ml") and the
    # Sarvam call pins it as the normalized language_code ("ml" -> "ml-IN")
    # alongside codemix mode.
    return ResolvedInference(
        language=mode.primary_language, code_switching=True, streaming_english_gloss=False
    )


def engines_supporting_mode(mode_id: str) -> list[str]:
    """Engine ``.value`` names (catalog-wide) that can serve *mode_id*."""
    mode = get_language_mode(mode_id)
    return [e.value for e in CATALOG_ENGINES if engine_supports_mode(mode, e)]


def modes_supported_by_engine(engine: AiModelFormat) -> list[str]:
    """Catalog mode ids that *engine* can serve (catalog display order)."""
    return [m.id for m in LANGUAGE_MODE_CATALOG if engine_supports_mode(m, engine)]


def language_mode_catalog_payload() -> list[dict[str, object]]:
    """Serialisable catalog + per-mode supported engines, for the capability API."""
    return [
        {
            "id": m.id,
            "label": m.label,
            "kind": m.kind,
            "primaryLanguage": m.primary_language,
            "secondaryLanguage": m.secondary_language,
            "supportedEngines": engines_supporting_mode(m.id),
        }
        for m in LANGUAGE_MODE_CATALOG
    ]
