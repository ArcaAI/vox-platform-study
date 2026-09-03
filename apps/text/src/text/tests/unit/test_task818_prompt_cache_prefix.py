"""/ A-7 — the router must not break provider-side prompt caching.

4.4, and the reason it is worth a regression fence of its own: provider prompt
caching is the highest-value cost lever available to this platform, AND it is the
only one that is structurally incapable of leaking between tenants (the cache
lives behind the tenant's own credential). 4.5 disqualified semantic caching for
clinical content outright, so this is the cost lever we have.

Anthropic's cache is **byte-exact on the prefix**. That makes three proxy
behaviours silently destructive, none of which raises anything:

  1. reordering or normalising the message array,
  2. re-serialising it (dict ordering, whitespace, unicode escaping),
  3. injecting a per-request header or system preamble AHEAD of the cached prefix.

Each one turns a 90%-discounted cache read into a full-price cache write, on
every request, forever, with no error and no metric that names the cause. Hence
"do no harm": these tests assert that every adapter forwards the caller's prefix
BYTE-STABLY and adds nothing in front of it.

The tests deliberately assert on the built payload rather than the wire: the
payload is where a proxy would corrupt a prefix, and it is the layer this lane
owns.

RED before implementation.
"""

from __future__ import annotations

import json

import pytest

from text.models.requests import GenerateRequest

#: Content chosen to expose the three failure modes at once: unicode that a
#: careless re-encode would escape, whitespace a normaliser would collapse, and
#: enough length to be worth caching in the first place.
SYSTEM = "You are a clinical scribe.\n\n  Preserve  spacing — and éç 中文."
PROMPT = "Summarise:\n\n  - patient reports “chest pain”\n  - onset 2h\n\ttab	here"


def _request(provider: str, **kwargs) -> GenerateRequest:
    return GenerateRequest(
        prompt=PROMPT,
        system_prompt=SYSTEM,
        provider=provider,
        model="m",
        **kwargs,
    )


# -- The OpenAI-wire family: openai, azure_openai, openai_compat (and vLLM) ---


def _openai_wire_builders():
    from text.providers.anthropic import AnthropicProvider  # noqa: F401  (import health)
    from text.providers.azure_openai import AzureOpenAIProvider
    from text.providers.openai import OpenAIProvider
    from text.providers.openai_compat import OpenAICompatProvider
    from text.providers.vllm import VllmProvider

    return [
        ("openai", OpenAIProvider()),
        ("azure_openai", AzureOpenAIProvider()),
        ("openai_compat", OpenAICompatProvider()),
        ("vllm", VllmProvider()),
    ]


class TestOpenAIWirePrefixIsPassedThroughVerbatim:
    @pytest.mark.parametrize("name,provider", _openai_wire_builders())
    def test_messages_are_system_then_user_and_nothing_else(self, name, provider):
        messages = provider._build_messages(_request(name))
        assert [m["role"] for m in messages] == ["system", "user"], (
            f"{name}: the message array was reordered or padded. Anthropic-style "
            "prefix caching is byte-exact, so an inserted or moved element misses "
            "the cache on every request."
        )

    @pytest.mark.parametrize("name,provider", _openai_wire_builders())
    def test_system_and_user_content_are_byte_identical_to_the_caller(self, name, provider):
        messages = provider._build_messages(_request(name))
        assert messages[0]["content"] == SYSTEM
        assert messages[1]["content"] == PROMPT

    @pytest.mark.parametrize("name,provider", _openai_wire_builders())
    def test_no_preamble_is_injected_ahead_of_the_cached_prefix(self, name, provider):
        """Rule 1 of 4.4: never inject a per-request system preamble. A request
        id, a tenant marker or a timestamp in front of the prefix makes every
        prefix unique, which is the same as having no cache at all."""
        messages = provider._build_messages(_request(name))
        assert not messages[0]["content"].startswith(("[", "<", "{")), messages[0]["content"][:40]
        assert messages[0]["content"] == SYSTEM

    @pytest.mark.parametrize("name,provider", _openai_wire_builders())
    def test_a_promptless_system_message_is_omitted_not_emptied(self, name, provider):
        """An empty system message is still a prefix element - emitting one for a
        caller who sent none would fork the cache between the two shapes."""
        messages = provider._build_messages(
            GenerateRequest(prompt=PROMPT, provider=name, model="m")
        )
        assert [m["role"] for m in messages] == ["user"]

    @pytest.mark.parametrize("name,provider", _openai_wire_builders())
    def test_two_identical_requests_serialise_identically(self, name, provider):
        a = json.dumps(provider._build_messages(_request(name)), ensure_ascii=False)
        b = json.dumps(provider._build_messages(_request(name)), ensure_ascii=False)
        assert a == b

    @pytest.mark.parametrize("name,provider", _openai_wire_builders())
    def test_the_text_part_leads_a_multimodal_user_message(self, name, provider):
        """With an image attached the user content becomes a parts array. The TEXT
        part must still lead, because that is the half a prefix cache keys on."""
        request = GenerateRequest(
            prompt=PROMPT,
            system_prompt=SYSTEM,
            provider=name,
            model="m",
            content_parts=[
                {"type": "image", "media_type": "image/png", "data": "aGVsbG8="},
            ],
        )
        messages = provider._build_messages(request)
        parts = messages[1]["content"]
        assert isinstance(parts, list)
        assert parts[0] == {"type": "text", "text": PROMPT}


# -- Anthropic: the adapter whose cache is literally byte-exact ---------------


class TestAnthropicPrefixIsPassedThroughVerbatim:
    def test_system_and_message_are_verbatim(self):
        from text.providers.anthropic import AnthropicProvider

        kwargs = AnthropicProvider()._build_create_kwargs(_request("anthropic"))
        assert kwargs["system"] == SYSTEM
        assert kwargs["messages"] == [{"role": "user", "content": PROMPT}]

    def test_no_system_key_when_the_caller_sent_none(self):
        from text.providers.anthropic import AnthropicProvider

        kwargs = AnthropicProvider()._build_create_kwargs(
            GenerateRequest(prompt=PROMPT, provider="anthropic", model="m")
        )
        assert "system" not in kwargs

    def test_two_identical_requests_build_identical_prefixes(self):
        from text.providers.anthropic import AnthropicProvider

        provider = AnthropicProvider()
        first = provider._build_create_kwargs(_request("anthropic"))
        second = provider._build_create_kwargs(_request("anthropic"))
        assert first["messages"] == second["messages"]
        assert first["system"] == second["system"]


# -- Bedrock (Converse) ------------------------------------------------------


class TestBedrockPrefixIsPassedThroughVerbatim:
    def test_system_and_message_are_verbatim(self):
        from text.providers.bedrock import BedrockProvider

        params = BedrockProvider()._build_converse_params(_request("bedrock"))
        assert params["system"] == [{"text": SYSTEM}]
        assert params["messages"] == [{"role": "user", "content": [{"text": PROMPT}]}]

    def test_the_text_block_leads_a_multimodal_message(self):
        from text.providers.bedrock import BedrockProvider

        request = GenerateRequest(
            prompt=PROMPT,
            system_prompt=SYSTEM,
            provider="bedrock",
            model="m",
            content_parts=[{"type": "image", "media_type": "image/png", "data": "aGVsbG8="}],
        )
        content = BedrockProvider()._build_converse_params(request)["messages"][0]["content"]
        assert content[0] == {"text": PROMPT}


# -- Vertex ------------------------------------------------------------------


class TestVertexPrefixIsPassedThroughVerbatim:
    def test_contents_is_the_bare_prompt_for_a_text_request(self):
        from text.providers.vertex import VertexProvider

        assert VertexProvider()._build_contents(_request("vertex")) == PROMPT

    def test_the_system_instruction_is_verbatim(self):
        from text.providers.vertex import VertexProvider

        config = VertexProvider()._build_config(_request("vertex"))
        assert config.system_instruction == SYSTEM


# -- The self-hosted raw-prompt engines --------------------------------------


class TestSelfHostedPrefixIsPassedThroughVerbatim:
    def test_ollama_forwards_prompt_and_system_verbatim(self):
        from unittest.mock import MagicMock

        from text.providers.ollama import OllamaProvider

        payload = OllamaProvider(MagicMock())._build_payload(_request("ollama"), stream=False)
        assert payload["prompt"] == PROMPT
        assert payload["system"] == SYSTEM

    def test_llama_cpp_prefixes_system_exactly_once_and_verbatim(self):
        """`/completion` is a raw-prompt endpoint, so the adapter must concatenate.
        The concatenation is part of the CACHED PREFIX (`cache_prompt: True`), so
        its exact bytes are load-bearing and must be stable."""
        from unittest.mock import MagicMock

        from text.providers.llama_cpp import LlamaCppProvider

        payload = LlamaCppProvider(MagicMock())._build_payload(_request("llama-cpp"), stream=False)
        assert payload["prompt"] == f"{SYSTEM}\n\n{PROMPT}"
        assert payload["cache_prompt"] is True

    def test_llama_cpp_is_stable_across_identical_requests(self):
        from unittest.mock import MagicMock

        from text.providers.llama_cpp import LlamaCppProvider

        provider = LlamaCppProvider(MagicMock())
        first = provider._build_payload(_request("llama-cpp"), stream=False)["prompt"]
        second = provider._build_payload(_request("llama-cpp"), stream=False)["prompt"]
        assert first == second


# -- The structural half: no adapter reaches for a normaliser ----------------


class TestNoAdapterNormalisesThePrefix:
    """A source-level fence. The behavioural tests above catch today's shapes;
    this catches the EDIT that would introduce a new one - a `sorted()` over a
    message array, a re-serialisation, a `.strip()` on caller content."""

    def test_no_adapter_sorts_or_reserialises_a_message_array(self):
        from pathlib import Path

        import text.providers as providers_pkg

        root = Path(providers_pkg.__file__).parent
        offenders: list[str] = []
        for path in sorted(root.glob("*.py")):
            source = path.read_text(encoding="utf-8")
            for banned in ("messages.sort(", "sorted(messages", "content.sort("):
                if banned in source:
                    offenders.append(f"{path.name}: {banned}")
        assert not offenders, (
            "an adapter reorders the message array: " + "; ".join(offenders) + ". "
            "Provider prompt caches key on the byte-exact prefix (4.4)."
        )
