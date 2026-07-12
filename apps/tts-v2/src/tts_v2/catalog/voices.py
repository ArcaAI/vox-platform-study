"""Stable internal voice catalog.

Callers reference stable internal voice IDs (e.g. ``ml-female-1``); each maps
to a locale and per-provider voice bindings. This keeps the SDK/gateway free of
provider-specific voice names and lets failover pick an equivalent voice on the
fallback provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field


class VoiceNotFoundError(KeyError):
    """Raised when a voice id is not in the catalog (endpoint maps to 404)."""


@dataclass(frozen=True)
class Voice:
    """A stable internal voice: id + locale + per-provider voice bindings."""

    id: str
    locale: str
    bindings: dict[str, str] = field(default_factory=dict)


# Day-1 catalog. Malayalam female binds Azure + local Parler (Phase 0 speaker);
# ml-male has no vetted local Parler speaker yet → Azure only until Phase 4.
DEFAULT_VOICES: tuple[Voice, ...] = (
    Voice("en-female-1", "en-IN", {"azure": "en-IN-NeerjaNeural", "kokoro": "af_heart"}),
    Voice("en-male-1", "en-IN", {"azure": "en-IN-PrabhatNeural", "kokoro": "am_adam"}),
    Voice("ml-female-1", "ml-IN", {"azure": "ml-IN-SobhanaNeural", "sarvam": "ishita", "indic_parler": "Anjali", "indic_f5": "ml-ref-1"}),
    Voice("ml-male-1", "ml-IN", {"azure": "ml-IN-MidhunNeural", "sarvam": "shubh"}),
)


class VoiceCatalog:
    """Lookup for stable internal voices."""

    def __init__(self, voices: tuple[Voice, ...] | list[Voice] | None = None) -> None:
        source = voices if voices is not None else DEFAULT_VOICES
        self._voices: dict[str, Voice] = {v.id: v for v in source}

    def get(self, voice_id: str) -> Voice:
        try:
            return self._voices[voice_id]
        except KeyError as exc:
            raise VoiceNotFoundError(voice_id) from exc

    def list_voices(self) -> list[Voice]:
        return list(self._voices.values())
