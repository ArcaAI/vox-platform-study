"""Tests for core/config.py — the bootstrap floor, its validators and its derivations.

The per-provider config classes this file used to exercise (`AzureOpenAIConfig`,
`BedrockConfig`, `OpenAIConfig`, `AnthropicConfig`, `VertexConfig`, plus
`RedisConfig` / `CircuitBreakerConfig` / `QueueConfig`) no longer exist:
lane B moved every one of those values onto the connection and control planes.
What is left to test here is what is left to configure — nine bootstrap values —
plus the PHI boot guard and the properties that DERIVE process facts instead of
declaring them as a second, drift-prone copy.

The exhaustive "no field beyond the floor" assertion lives in
`test_task799_config_surface.py`; this file covers behaviour.
"""

from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from text.core.config import (
    ExternalGuardrailConfig,
    InternalAccessConfig,
    Settings,
    TelemetryPhiGuardConfig,
    get_settings,
)


def _clear_text_env(monkeypatch):
    """Remove all TEXT_* env vars so pydantic-settings reads only code defaults."""
    for key in list(os.environ):
        if key.startswith("TEXT_"):
            monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def _isolate_text_env(monkeypatch):
    _clear_text_env(monkeypatch)


class TestTelemetryPhiGuardConfig:
    """PHI-safe telemetry boot guard.

    Mirrors the gateway's `assertGenaiContentCaptureDisabled` posture:
    `NODE_ENV=production` + a content-capture value other than the literal
    `NO_CONTENT` (including unset, i.e. the empty-string default) must refuse
    to construct. Every other environment is unenforced, matching the
    env-sample flow pinning `NO_CONTENT` as a template default rather than a
    hard runtime requirement outside production.

    Constructed via keyword args (the `init_settings` source outranks env), so
    these tests do not depend on ambient process env / .env.test content.
    `_isolate_text_env` (module-level, autouse) only clears `TEXT_*` names, so
    this class adds its own autouse isolation for the two bare names this config
    reads.
    """

    @pytest.fixture(autouse=True)
    def _isolate_bare_env(self, monkeypatch):
        monkeypatch.delenv("NODE_ENV", raising=False)
        monkeypatch.delenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", raising=False)

    def test_defaults_are_unenforced(self):
        cfg = TelemetryPhiGuardConfig()
        assert cfg.node_env == "development"
        assert cfg.genai_capture_message_content == ""

    def test_passes_outside_production_when_unset(self):
        cfg = TelemetryPhiGuardConfig(node_env="development")
        assert cfg.genai_capture_message_content == ""

    def test_passes_outside_production_with_permissive_value(self):
        cfg = TelemetryPhiGuardConfig(
            node_env="test", genai_capture_message_content="SPAN_AND_EVENT"
        )
        assert cfg.genai_capture_message_content == "SPAN_AND_EVENT"

    def test_passes_in_production_when_exactly_no_content(self):
        cfg = TelemetryPhiGuardConfig(
            node_env="production", genai_capture_message_content="NO_CONTENT"
        )
        assert cfg.genai_capture_message_content == "NO_CONTENT"

    def test_refuses_in_production_when_unset(self):
        with pytest.raises(
            ValidationError, match="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
        ):
            TelemetryPhiGuardConfig(node_env="production")

    def test_refuses_in_production_with_permissive_value(self):
        with pytest.raises(
            ValidationError, match="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
        ):
            TelemetryPhiGuardConfig(
                node_env="production", genai_capture_message_content="SPAN_AND_EVENT"
            )

    def test_refuses_in_production_on_near_miss_case(self):
        with pytest.raises(ValidationError):
            TelemetryPhiGuardConfig(
                node_env="production", genai_capture_message_content="no_content"
            )

    def test_reads_bare_env_names_not_service_prefixed(self, monkeypatch):
        # These are cross-process conventions — TEXT_NODE_ENV / TEXT_OTEL_... must
        # NOT be what this class reads (Settings' env_prefix_target="all" would
        # otherwise silently prefix them).
        monkeypatch.setenv("NODE_ENV", "test")
        monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "NO_CONTENT")
        monkeypatch.setenv("TEXT_NODE_ENV", "production")
        monkeypatch.setenv(
            "TEXT_OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "SPAN_AND_EVENT"
        )
        cfg = TelemetryPhiGuardConfig()
        assert cfg.node_env == "test"
        assert cfg.genai_capture_message_content == "NO_CONTENT"

    def test_settings_construction_refuses_in_production(self, monkeypatch):
        _clear_text_env(monkeypatch)
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.delenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", raising=False)
        with pytest.raises(
            ValidationError, match="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
        ):
            Settings()

    def test_settings_construction_passes_in_production_when_pinned(self, monkeypatch):
        _clear_text_env(monkeypatch)
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "NO_CONTENT")
        s = Settings()
        assert s.telemetry_phi_guard.genai_capture_message_content == "NO_CONTENT"


class TestSettings:
    def test_defaults(self, monkeypatch):
        _clear_text_env(monkeypatch)
        s = Settings()
        assert s.port == 8862
        assert s.log_level == "info"
        assert s.gateway_url == "http://localhost:8868/api/v1"
        assert s.redis_url == "redis://localhost:6379/0"
        # EMPTY, not an address: export is enabled by the PRESENCE of a
        # collector, so a default address would turn it on everywhere.
        assert s.otel_exporter_endpoint == ""
        assert s.otel_enabled is False

    def test_sub_configs_instantiated(self):
        s = Settings()
        assert isinstance(s.external_guardrail, ExternalGuardrailConfig)
        assert isinstance(s.internal_access, InternalAccessConfig)
        assert isinstance(s.telemetry_phi_guard, TelemetryPhiGuardConfig)

    def test_log_level_normalised_to_lowercase(self):
        s = Settings(log_level="DEBUG")
        assert s.log_level == "debug"

    def test_log_level_mixed_case(self):
        s = Settings(log_level="Warning")
        assert s.log_level == "warning"

    def test_no_provider_sub_configs_remain(self):
        """The eight per-provider blocks are gone, not renamed."""
        assert not {
            "ollama",
            "azure",
            "bedrock",
            "openai",
            "anthropic",
            "vertex",
            "openai_compat",
            "vllm",
            "llama_cpp",
            "sarvam",
            "tei_embed",
        } & set(Settings.model_fields)


class TestDerivedProcessFacts:
    """A process fact is derived, never declared twice.

    Each of these replaced its own env var. The property is the whole point: a
    separate `TEXT_OTEL_INSECURE` can disagree with the endpoint it describes,
    and a separate `TEXT_OTEL_DEPLOYMENT_ENVIRONMENT` can tag a laptop's spans as
    production. A derivation cannot contradict its own source.
    """

    def test_otel_export_follows_the_presence_of_an_endpoint(self, monkeypatch):
        _clear_text_env(monkeypatch)
        assert Settings(otel_exporter_endpoint="http://collector:4317").otel_enabled is True
        assert Settings(otel_exporter_endpoint="").otel_enabled is False
        assert Settings(otel_exporter_endpoint="   ").otel_enabled is False

    def test_otel_tls_follows_the_endpoint_scheme(self, monkeypatch):
        _clear_text_env(monkeypatch)
        assert Settings(otel_exporter_endpoint="http://collector:4317").otel_insecure is True
        assert Settings(otel_exporter_endpoint="https://collector:4317").otel_insecure is False
        # Case must not decide TLS.
        assert Settings(otel_exporter_endpoint="HTTPS://collector:4317").otel_insecure is False

    def test_service_identity_is_a_constant(self, monkeypatch):
        _clear_text_env(monkeypatch)
        monkeypatch.setenv("TEXT_OTEL_SERVICE_NAME", "impostor")
        monkeypatch.setenv("TEXT_OTEL_SERVICE_NAMESPACE", "impostor")
        s = Settings()
        assert s.otel_service_name == "text"
        assert s.otel_service_namespace == "hope"

    def test_deployment_environment_and_debug_follow_node_env(self, monkeypatch):
        _clear_text_env(monkeypatch)
        monkeypatch.setenv("NODE_ENV", "development")
        s = Settings()
        assert s.otel_deployment_environment == "development"
        assert s.debug is True

        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "NO_CONTENT")
        s = Settings()
        assert s.otel_deployment_environment == "production"
        assert s.debug is False


class TestInternalAccessToken:
    """One shared internal credential; the legacy per-pair tokens are retired."""

    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
        monkeypatch.delenv("TEXT_SERVICE_TOKEN", raising=False)
        monkeypatch.delenv("SERVICE_TOKEN", raising=False)

    def test_the_shared_token_is_accepted_and_presented(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "shared-token")
        s = Settings()
        assert s.accepted_service_tokens == ("shared-token",)
        assert s.peer_service_token() == "shared-token"

    def test_the_legacy_per_service_token_is_no_longer_accepted(self, monkeypatch):
        """`TEXT_SERVICE_TOKEN` was declared as a transition window that nothing
        on the other side ever used. A second accepted credential is a second
        thing to rotate, so it is closed rather than left dangling."""
        monkeypatch.setenv("TEXT_SERVICE_TOKEN", "legacy-token")
        s = Settings()
        assert s.accepted_service_tokens == ()
        assert s.peer_service_token() == ""

    def test_an_unfilled_placeholder_is_not_a_credential(self, monkeypatch):
        """`CHANGE_ME` must never be ACCEPTED as a token — a plain truthiness
        chain would return it and 401 every internal hop."""
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "CHANGE_ME")
        s = Settings()
        assert s.accepted_service_tokens == ()
        assert s.peer_service_token() == ""


class TestGetSettings:
    def test_returns_settings_instance(self):
        s = get_settings()
        assert isinstance(s, Settings)

    def test_returns_fresh_instance_each_call(self):
        s1 = get_settings()
        s2 = get_settings()
        assert s1 is not s2
