"""`AiRuntimeProfile.extraJson` must reach the engine (RED-first).

The gateway's ``applyTextRuntimeProfile`` forwards a profile's engine-specific
``extraJson`` as the request field ``extra`` — the schema comment on that column
reads "engine-specific (n_threads, n_gpu_layers, num_predict, …)". Before this
file ``GenerateRequest`` declared no such field, so pydantic silently DROPPED it
and no engine ever saw a profile extra. The first real casualty: gemma-4's
thinking mode is ON by LM Studio default, so every realtime node paid 400–1300
reasoning tokens and blew its budget, and the one switch that turns it off
(``reasoning_effort: "none"``) had no path from a platform admin to the engine.

Contract:
* ``GenerateRequest.extra`` is an optional free-form mapping.
* The OpenAI-compatible family (LM Studio, vLLM, generic) merges it into the
  SDK's sanctioned ``extra_body`` ride-along, for ``generate`` and streaming.
* The platform's OWN dedicated knobs (LM Studio's retention ``ttl``) win over a
  same-named key in ``extra`` — a profile extra can add, never hijack.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from text.models.requests import GenerateRequest
from text.tests.conftest import stub_client


def _completion() -> MagicMock:
    usage = MagicMock(prompt_tokens=3, completion_tokens=4, total_tokens=7)
    choice = MagicMock()
    choice.message.content = "ok"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


def _registry():
    from text.main import _register_provider_factories
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    _register_provider_factories(registry, MagicMock())
    return registry


class TestRequestModel:
    def test_extra_is_accepted_and_kept(self):
        request = GenerateRequest(
            prompt="hi", model="m", provider="lm-studio", extra={"reasoning_effort": "none"}
        )
        assert request.extra == {"reasoning_effort": "none"}

    def test_extra_defaults_to_none(self):
        assert GenerateRequest(prompt="hi", model="m", provider="lm-studio").extra is None


class TestExtrasReachTheEngine:
    @pytest.mark.asyncio
    async def test_lm_studio_merges_extra_next_to_its_ttl(self):
        provider = _registry().get("lm-studio")
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(
            GenerateRequest(
                prompt="hi", model="m", provider="lm-studio", extra={"reasoning_effort": "none"}
            )
        )

        assert create.await_args.kwargs["extra_body"] == {"ttl": 900, "reasoning_effort": "none"}

    @pytest.mark.asyncio
    async def test_generic_openai_compat_sends_extra_alone(self):
        """A generic server gets exactly what the admin declared — nothing else."""
        provider = _registry().get("openai_compat")
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(
            GenerateRequest(
                prompt="hi", model="m", provider="openai_compat", extra={"reasoning_effort": "none"}
            )
        )

        assert create.await_args.kwargs["extra_body"] == {"reasoning_effort": "none"}

    @pytest.mark.asyncio
    async def test_dedicated_retention_knob_wins_over_a_same_named_extra(self):
        provider = _registry().get("lm-studio")
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(
            GenerateRequest(prompt="hi", model="m", provider="lm-studio", extra={"ttl": 1})
        )

        assert create.await_args.kwargs["extra_body"] == {"ttl": 900}

    @pytest.mark.asyncio
    async def test_no_extra_changes_nothing(self):
        provider = _registry().get("openai_compat")
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="openai_compat"))

        assert "extra_body" not in create.await_args.kwargs

    def test_streaming_kwargs_carry_the_same_merge(self):
        """The streaming path builds its kwargs separately; it must apply the
        same merge, so the shared helper is exercised on a stream-shaped dict."""
        provider = _registry().get("lm-studio")
        provider.apply_retention({"ttl_seconds": 900})
        kwargs = {"model": "m", "stream": True}
        provider._apply_retention_hint(kwargs)
        provider._apply_request_extras(
            kwargs,
            GenerateRequest(
                prompt="hi", model="m", provider="lm-studio", extra={"reasoning_effort": "none"}
            ),
        )
        assert kwargs["extra_body"] == {"ttl": 900, "reasoning_effort": "none"}
