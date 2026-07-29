"""Control-plane values reach SMR's live runtime state.

Two things are locked here:
  1. A refreshed `maxConcurrent`/`timeoutS` actually moves the live semaphore and
     timeout map (without swapping the semaphore object).
  2. The stateless-gateway contract is NOT eroded — effective-config must never
     introduce provider/model selection into SMR.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from smr.core.effective_config import EffectiveConfigClient, EffectiveConfigSnapshot
from smr.services.resizable_semaphore import ResizableSemaphore
from smr.services.runtime_limits import apply_provider_limits, refresh_runtime_limits


def snapshot(profiles: list[dict]) -> EffectiveConfigSnapshot:
    return EffectiveConfigSnapshot(raw={"service": "smr", "runtimeProfiles": profiles}, ok=True)


def profile(provider: str, **over) -> dict:
    return {"provider": provider, "modelSlug": "", "maxConcurrent": None, "timeoutS": None, **over}


class TestApplyProviderLimits:
    def test_resizes_the_live_semaphore(self) -> None:
        semaphores = {"ollama": ResizableSemaphore(4)}
        timeouts: dict[str, int] = {}

        apply_provider_limits(snapshot([profile("ollama", maxConcurrent=12)]), semaphores, timeouts)

        assert semaphores["ollama"].limit == 12

    def test_keeps_the_semaphore_object_identity(self) -> None:
        """Call sites hold this object; swapping it would strand in-flight permits."""
        semaphores = {"ollama": ResizableSemaphore(4)}
        before = semaphores["ollama"]

        apply_provider_limits(snapshot([profile("ollama", maxConcurrent=12)]), semaphores, {})

        assert semaphores["ollama"] is before

    def test_applies_the_timeout_override(self) -> None:
        timeouts: dict[str, int] = {}

        apply_provider_limits(snapshot([profile("ollama", timeoutS=45)]), {}, timeouts)

        assert timeouts["ollama"] == 45

    def test_leaves_env_values_alone_when_the_profile_has_no_opinion(self) -> None:
        semaphores = {"ollama": ResizableSemaphore(4)}
        timeouts: dict[str, int] = {}

        apply_provider_limits(snapshot([profile("ollama")]), semaphores, timeouts)

        assert semaphores["ollama"].limit == 4, "a null maxConcurrent must not change the limit"
        assert timeouts == {}, "a null timeoutS must not register an override"

    def test_ignores_providers_this_process_does_not_serve(self) -> None:
        semaphores = {"ollama": ResizableSemaphore(4)}

        apply_provider_limits(snapshot([profile("bedrock", maxConcurrent=9)]), semaphores, {})

        assert "bedrock" not in semaphores
        assert semaphores["ollama"].limit == 4

    def test_a_failed_fetch_changes_nothing(self) -> None:
        """Gateway down ⇒ byte-identical to today's env-driven behaviour."""
        semaphores = {"ollama": ResizableSemaphore(4)}
        timeouts = {"ollama": 300}

        apply_provider_limits(EffectiveConfigSnapshot(raw={}, ok=False), semaphores, timeouts)

        assert semaphores["ollama"].limit == 4
        assert timeouts == {"ollama": 300}

    def test_a_shrink_does_not_revoke_in_flight_permits(self) -> None:
        semaphores = {"ollama": ResizableSemaphore(4)}

        apply_provider_limits(snapshot([profile("ollama", maxConcurrent=1)]), semaphores, {})

        assert semaphores["ollama"].limit == 1

    @pytest.mark.parametrize("bad", [0, -3])
    def test_rejects_a_non_positive_limit_without_corrupting_state(self, bad: int) -> None:
        """A bad served value must never take a provider offline."""
        semaphores = {"ollama": ResizableSemaphore(4)}

        apply_provider_limits(snapshot([profile("ollama", maxConcurrent=bad)]), semaphores, {})

        assert semaphores["ollama"].limit == 4


class TestRefreshRuntimeLimits:
    async def test_pulls_and_applies_in_one_step(self) -> None:
        payload = {
            "service": "smr",
            "runtimeProfiles": [
                {"provider": "ollama", "modelSlug": "", "maxConcurrent": 7, "timeoutS": 30}
            ],
        }
        client = EffectiveConfigClient(
            base_url="http://gateway.test/api/v1",
            token="t",
            service="smr",
            transport=httpx.MockTransport(lambda _r: httpx.Response(200, json=payload)),
        )
        state = SimpleNamespace(
            effective_config_client=client,
            provider_semaphores={"ollama": ResizableSemaphore(4)},
            provider_timeouts={},
        )

        await refresh_runtime_limits(state)

        assert state.provider_semaphores["ollama"].limit == 7
        assert state.provider_timeouts["ollama"] == 30

    async def test_is_a_no_op_when_no_client_is_wired(self) -> None:
        state = SimpleNamespace(
            provider_semaphores={"ollama": ResizableSemaphore(4)}, provider_timeouts={}
        )

        await refresh_runtime_limits(state)  # must not raise

        assert state.provider_semaphores["ollama"].limit == 4

    async def test_never_raises_when_the_gateway_is_down(self) -> None:
        def boom(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        client = EffectiveConfigClient(
            base_url="http://gateway.test/api/v1",
            token="t",
            service="smr",
            transport=httpx.MockTransport(boom),
        )
        state = SimpleNamespace(
            effective_config_client=client,
            provider_semaphores={"ollama": ResizableSemaphore(4)},
            provider_timeouts={},
        )

        await refresh_runtime_limits(state)  # must not raise — request paths depend on this

        assert state.provider_semaphores["ollama"].limit == 4


class TestStatelessGatewayContract:
    """SMR must not learn to select a provider/model from its own config."""

    def test_apply_ignores_any_model_selection_field_that_appears(self) -> None:
        semaphores = {"ollama": ResizableSemaphore(4)}
        timeouts: dict[str, int] = {}
        rogue = snapshot(
            [
                profile(
                    "ollama",
                    maxConcurrent=8,
                    defaultModel="llama3:8b",
                    model="mistral",
                    selectedProvider="vllm",
                )
            ]
        )

        apply_provider_limits(rogue, semaphores, timeouts)

        state = {"semaphores": {k: v.limit for k, v in semaphores.items()}, "timeouts": timeouts}
        assert state == {
            "semaphores": {"ollama": 8},
            "timeouts": {},
        }, "only capacity/timeout may be applied; selection fields must be inert"

    def test_config_module_docstring_still_declares_the_contract(self) -> None:
        import smr.core.config as config_module

        doc = config_module.__doc__ or ""
        assert "stateless gateway" in doc
        assert "does NOT select a provider or model" in doc
