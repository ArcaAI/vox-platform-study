"""Guardrail consumes AiRuntimeProfile rows.

Guardrail keeps its SQL resolver rather than adopting the HTTP pull
client; the read is EXTENDED with the provider-level
runtime profile (temperature / maxTokens / timeoutS).

The existing fail-safe posture must not be weakened: a DB error still yields env
defaults, and profile fields are optional everywhere.
"""

from __future__ import annotations

import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import GuardrailTenantConfig, resolve_guardian_engine


@pytest.fixture
def settings() -> Settings:
    return Settings()


class TestProfileFieldsAreOptional:
    def test_config_defaults_carry_no_profile_opinion(self) -> None:
        cfg = GuardrailTenantConfig()

        assert cfg.temperature is None
        assert cfg.max_tokens is None
        assert cfg.timeout_s is None

    def test_engine_keeps_env_values_when_no_profile_exists(self, settings: Settings) -> None:
        """The env-only path must be byte-identical."""
        _provider, engine = resolve_guardian_engine(settings, GuardrailTenantConfig(model="m"))

        base = settings.engine
        assert engine.temperature == base.temperature
        assert engine.max_tokens == base.max_tokens
        assert engine.timeout_s == base.timeout_s


class TestProfileApplication:
    def test_applies_temperature_from_the_profile(self, settings: Settings) -> None:
        cfg = GuardrailTenantConfig(model="m", temperature=0.42)

        _provider, engine = resolve_guardian_engine(settings, cfg)

        assert engine.temperature == 0.42

    def test_applies_max_tokens_and_timeout(self, settings: Settings) -> None:
        cfg = GuardrailTenantConfig(model="m", max_tokens=1234, timeout_s=99)

        _provider, engine = resolve_guardian_engine(settings, cfg)

        assert engine.max_tokens == 1234
        assert engine.timeout_s == 99

    def test_applies_profile_even_without_a_model_override(self, settings: Settings) -> None:
        """Tuning must not be conditional on a model selection being present."""
        cfg = GuardrailTenantConfig(temperature=0.33)

        _provider, engine = resolve_guardian_engine(settings, cfg)

        assert engine.temperature == 0.33

    def test_partial_profiles_apply_independently(self, settings: Settings) -> None:
        cfg = GuardrailTenantConfig(model="m", temperature=0.2)

        _provider, engine = resolve_guardian_engine(settings, cfg)

        assert engine.temperature == 0.2
        assert engine.max_tokens == settings.engine.max_tokens, "unserved keys keep env values"

    def test_model_override_still_applies_alongside_a_profile(self, settings: Settings) -> None:
        cfg = GuardrailTenantConfig(model="the-model", temperature=0.2)

        _provider, engine = resolve_guardian_engine(settings, cfg)

        assert engine.guardrail_model == "the-model"
        assert engine.guardian_model == "the-model"
        assert engine.temperature == 0.2


class TestLocalPathScope:
    def test_local_path_landed_with_task_527(self) -> None:
        """`local_path` must exist and default to None, keeping
        "no DB opinion ⇒ env fallback" intact.
        """
        cfg = GuardrailTenantConfig()
        assert hasattr(cfg, "local_path")
        assert cfg.local_path is None
        assert cfg.checksum is None
