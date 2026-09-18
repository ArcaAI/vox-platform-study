"""TASK-985 QW-4 / OD-F — warm the default ASR model, without ever risking boot.

Idle TTL evicts the served model between consultations: a 4.6 s cold reload was
measured inside a 5807 ms session-create against 118/224 ms warm, and the
cluster runbook documents the first session after a GPU pod rolls returning 503
because the gateway's create timeout expires during the load.

The tests below pin the three properties that make this safe, because each of
them is a way this feature could turn a routine model swap into an outage:

1. DEFAULT OFF, and a wrong-typed served value does not enable it.
2. Every failure path is a log line and a return — the task raises nothing that
   could surface in `lifespan`.
3. It warms the ASR model only.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from stt.main import _warm_default_asr_model


def _snapshot(raw: dict):
    client = SimpleNamespace()
    client.get = AsyncMock(return_value=SimpleNamespace(raw=raw, ok=True))
    return client


class TestWarmIsOffByDefault:
    @pytest.mark.asyncio
    async def test_an_absent_key_warms_nothing(self):
        with (
            patch("stt.core.effective_config.get_effective_config_client") as get_client,
            patch("stt.main.httpx.AsyncClient") as http,
        ):
            get_client.return_value = _snapshot({"settings": {}})
            await _warm_default_asr_model()
        http.assert_not_called()

    @pytest.mark.asyncio
    async def test_an_explicit_false_warms_nothing(self):
        with (
            patch("stt.core.effective_config.get_effective_config_client") as get_client,
            patch("stt.main.httpx.AsyncClient") as http,
        ):
            get_client.return_value = _snapshot(
                {"settings": {"stt.warmDefaultAsrOnBoot": {"value": False}}}
            )
            await _warm_default_asr_model()
        http.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("served", ["true", 1, "yes", None])
    async def test_a_wrongly_typed_value_leaves_the_bootstrap_behaviour_standing(self, served):
        """A plausible-looking wrong value must never be coerced into an opinion."""
        with (
            patch("stt.core.effective_config.get_effective_config_client") as get_client,
            patch("stt.main.httpx.AsyncClient") as http,
        ):
            get_client.return_value = _snapshot(
                {"settings": {"stt.warmDefaultAsrOnBoot": {"value": served}}}
            )
            await _warm_default_asr_model()
        http.assert_not_called()


class TestWarmNeverBreaksBoot:
    @pytest.mark.asyncio
    async def test_an_unreachable_control_plane_is_a_log_line(self):
        with patch("stt.core.effective_config.get_effective_config_client") as get_client:
            client = SimpleNamespace()
            client.get = AsyncMock(side_effect=RuntimeError("gateway down"))
            get_client.return_value = client
            # Must not raise: `lifespan` never awaits this task, but a raise
            # would still surface as an unretrieved task exception at shutdown.
            await _warm_default_asr_model()

    @pytest.mark.asyncio
    async def test_an_absent_spec_route_is_a_log_line(self):
        """The gateway half may not exist yet; the key is default-OFF anyway."""
        with (
            patch("stt.core.effective_config.get_effective_config_client") as get_client,
            patch("stt.main.httpx.AsyncClient") as http,
        ):
            get_client.return_value = _snapshot(
                {"settings": {"stt.warmDefaultAsrOnBoot": {"value": True}}}
            )
            http.return_value.__aenter__.return_value.get = AsyncMock(
                side_effect=RuntimeError("404 Not Found")
            )
            await _warm_default_asr_model()

    @pytest.mark.asyncio
    async def test_a_failing_model_load_is_a_log_line(self):
        """A corrupt GGUF must cost a slow first session, never the pod."""
        with (
            patch("stt.core.effective_config.get_effective_config_client") as get_client,
            patch("stt.main.httpx.AsyncClient") as http,
            patch("stt.pipeline.spec.bundle_from_resolved") as bundle_from_resolved,
            patch("stt.models.get_model_cache") as get_model_cache,
        ):
            get_client.return_value = _snapshot(
                {"settings": {"stt.warmDefaultAsrOnBoot": {"value": True}}}
            )
            http.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=SimpleNamespace(
                    raise_for_status=lambda: None, json=lambda: {"any": "spec"}
                )
            )
            bundle_from_resolved.return_value = SimpleNamespace(
                spec=SimpleNamespace(models=SimpleNamespace(asr=SimpleNamespace(slug="asr-1"))),
                model_configs={"asr-1": SimpleNamespace(slug="asr-1")},
            )
            cache = SimpleNamespace()
            cache.get_or_load = AsyncMock(side_effect=RuntimeError("corrupt gguf"))
            get_model_cache.return_value = cache

            await _warm_default_asr_model()

            cache.get_or_load.assert_awaited_once()


class TestWarmLoadsExactlyOneModel:
    @pytest.mark.asyncio
    async def test_only_the_asr_slug_is_warmed(self):
        """Silero VAD, the embedding model and punctuation stay lazy."""
        with (
            patch("stt.core.effective_config.get_effective_config_client") as get_client,
            patch("stt.main.httpx.AsyncClient") as http,
            patch("stt.pipeline.spec.bundle_from_resolved") as bundle_from_resolved,
            patch("stt.models.get_model_cache") as get_model_cache,
        ):
            get_client.return_value = _snapshot(
                {"settings": {"stt.warmDefaultAsrOnBoot": {"value": True}}}
            )
            http.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=SimpleNamespace(
                    raise_for_status=lambda: None, json=lambda: {"any": "spec"}
                )
            )
            asr_config = SimpleNamespace(slug="asr-1")
            bundle_from_resolved.return_value = SimpleNamespace(
                spec=SimpleNamespace(models=SimpleNamespace(asr=SimpleNamespace(slug="asr-1"))),
                model_configs={
                    "asr-1": asr_config,
                    "silero-vad": SimpleNamespace(slug="silero-vad"),
                    "ecapa": SimpleNamespace(slug="ecapa"),
                },
            )
            cache = SimpleNamespace()
            cache.get_or_load = AsyncMock()
            get_model_cache.return_value = cache

            await _warm_default_asr_model()

            cache.get_or_load.assert_awaited_once_with(asr_config)
