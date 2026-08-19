"""Guardrail consumes AiRuntimeProfile rows.

Guardrail keeps its SQL resolver rather than adopting the HTTP pull
client; the read is EXTENDED with the provider-level
runtime profile (temperature / maxTokens / timeoutS).

The existing fail-safe posture must not be weakened: profile fields stay optional
everywhere, and an absent profile leaves the judge policy's own defaults in force.
Since TASK-735 Phase 2b the profile lands on the DELEGATING client rather than on
an env engine sub-config — the tuning contract is unchanged, its destination moved.
"""

from __future__ import annotations

import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import GuardrailTenantConfig, build_judge_client


@pytest.fixture
def settings() -> Settings:
    return Settings()


def _judge(settings: Settings, cfg: GuardrailTenantConfig):
    return build_judge_client(settings, cfg, http_client=object(), tenant_id="t-1")


class TestProfileFieldsAreOptional:
    def test_config_defaults_carry_no_profile_opinion(self) -> None:
        cfg = GuardrailTenantConfig()

        assert cfg.temperature is None
        assert cfg.max_tokens is None
        assert cfg.timeout_s is None

    def test_judge_keeps_policy_values_when_no_profile_exists(self, settings: Settings) -> None:
        client = _judge(settings, GuardrailTenantConfig(model="m"))

        assert client.temperature == settings.judge.temperature
        assert client.max_tokens == settings.judge.max_tokens
        assert client.timeout_s == settings.judge.timeout_s


class TestProfileApplication:
    def test_applies_temperature_from_the_profile(self, settings: Settings) -> None:
        client = _judge(settings, GuardrailTenantConfig(model="m", temperature=0.42))

        assert client.temperature == 0.42

    def test_applies_max_tokens_and_timeout(self, settings: Settings) -> None:
        client = _judge(settings, GuardrailTenantConfig(model="m", max_tokens=1234, timeout_s=99))

        assert client.max_tokens == 1234
        assert client.timeout_s == 99

    def test_applies_profile_even_without_a_model_override(self, settings: Settings) -> None:
        """Tuning must not be conditional on a model selection being present."""
        client = _judge(settings, GuardrailTenantConfig(temperature=0.33))

        assert client.temperature == 0.33

    def test_partial_profiles_apply_independently(self, settings: Settings) -> None:
        client = _judge(settings, GuardrailTenantConfig(model="m", temperature=0.2))

        assert client.temperature == 0.2
        assert client.max_tokens == settings.judge.max_tokens, "unserved keys keep policy values"

    def test_model_override_still_applies_alongside_a_profile(self, settings: Settings) -> None:
        client = _judge(settings, GuardrailTenantConfig(model="the-model", temperature=0.2))

        assert client.model == "the-model"
        assert client.temperature == 0.2


class TestLocalPathScope:
    def test_local_path_defaults_to_none(self) -> None:
        """`local_path` must exist and default to None, keeping
        "no DB opinion ⇒ env fallback" intact.
        """
        cfg = GuardrailTenantConfig()
        assert hasattr(cfg, "local_path")
        assert cfg.local_path is None
        assert cfg.checksum is None
