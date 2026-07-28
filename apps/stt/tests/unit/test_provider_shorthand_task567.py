"""TASK-567: `provider :: model` shorthand parses for the new cloud engines.

Tier-1 (YAML/DTO) test — no mocks, no network. Also locks forward-tolerance:
the shorthand vocabulary stays consistent with ``_PROVIDER_ALIASES``.
"""

import pytest

from stt.pipeline.dto import AiModelFormat, ModelRef


@pytest.mark.parametrize(
    ("shorthand", "engine", "model_id"),
    [
        ("sarvam :: saaras-v3", AiModelFormat.SARVAM, "saaras-v3"),
        ("openai :: gpt-4o-transcribe", AiModelFormat.OPENAI, "gpt-4o-transcribe"),
        ("openai :: gpt-4o-mini-transcribe", AiModelFormat.OPENAI, "gpt-4o-mini-transcribe"),
    ],
)
def test_shorthand_resolves_to_cloud_engine(shorthand, engine, model_id):
    ref = ModelRef.from_value(shorthand)
    assert ref.is_inline
    assert ref.inline is not None
    assert ref.inline.engine == engine
    assert ref.inline.hf_model_id == model_id


def test_new_providers_registered_in_aliases():
    assert ModelRef._PROVIDER_ALIASES["sarvam"] == "SARVAM"
    assert ModelRef._PROVIDER_ALIASES["openai"] == "OPENAI"


def test_new_formats_are_enum_members():
    assert AiModelFormat("SARVAM") is AiModelFormat.SARVAM
    assert AiModelFormat("OPENAI") is AiModelFormat.OPENAI
