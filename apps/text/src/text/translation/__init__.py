"""Text translation capability — extensible translate-provider registry.

Text is a text-generative router; alongside ``generate`` it exposes a
``translate`` capability behind the same conventions (per-provider ``TEXT_<X>_``
config, per-request ``provider_overrides`` BYOK, ``X-Service-Token`` auth,
lazy provider registry). Sarvam is the first translate provider.
"""

from __future__ import annotations

from text.translation.base import (
    TranslateProvider,
    TranslateProviderNotFoundError,
    TranslateProviderRegistry,
)
from text.translation.sarvam import (
    SarvamCredentialError,
    SarvamTranslateError,
    SarvamTranslateProvider,
)

__all__ = [
    "SarvamCredentialError",
    "SarvamTranslateError",
    "SarvamTranslateProvider",
    "TranslateProvider",
    "TranslateProviderNotFoundError",
    "TranslateProviderRegistry",
]
