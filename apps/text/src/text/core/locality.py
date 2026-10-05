"""Provider locality — may a prompt leave the platform with real identifiers in it?

TASK-1035 §5.0 freezes the rules. The caller (gateway / harness) stamps
``provider_locality`` per provider from ``AiModel.deploymentKind`` and the
engine-served provider set; this module decides, per provider actually called:

1. stamp ``local`` AND the provider is not a known cloud vendor ⇒ ``local``;
2. no stamp AND the provider is engine-served or ``built-in`` ⇒ ``local``;
3. everything else ⇒ ``cloud`` — fail closed.

A stamp can never downgrade a known cloud vendor: a mis-stamp must cost a
redaction, never an unredacted prompt on a vendor's wire.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final, Literal

Locality = Literal["local", "cloud"]

LOCAL: Final = "local"
CLOUD: Final = "cloud"

#: Vendors whose endpoints are, by definition, off-platform.
KNOWN_CLOUD_PROVIDERS: Final[frozenset[str]] = frozenset(
    {
        "azure",
        "azure-openai",
        "bedrock",
        "openai",
        "anthropic",
        "vertex",
        "google",
        "gemini",
        "mistral",
        "cohere",
        "groq",
        "together",
        "openrouter",
    }
)

#: Engines the platform runs itself (mirrors `ENGINE_SERVED_PROVIDERS` in
#: `packages/applications/.../ai-provider-connection/constants.ts`) plus the
#: `built-in` sentinel for the platform's own model-serving services.
LOCAL_BY_DEFAULT_PROVIDERS: Final[frozenset[str]] = frozenset(
    {"lm-studio", "lmstudio", "ollama", "vllm", "llama-cpp", "built-in"}
)


def resolve_locality(provider: str, stamps: Mapping[str, str] | None) -> Locality:
    """The locality of ``provider`` under the frozen §5.0 rules."""
    stamp = (stamps or {}).get(provider)
    if stamp == LOCAL and provider not in KNOWN_CLOUD_PROVIDERS:
        return LOCAL
    if stamp is None and provider in LOCAL_BY_DEFAULT_PROVIDERS:
        return LOCAL
    return CLOUD
