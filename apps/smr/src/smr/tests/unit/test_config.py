"""Tests for core/config.py — all config classes, validators, defaults, env loading."""

from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from smr.core.config import (
    AnthropicConfig,
    AzureOpenAIConfig,
    BedrockConfig,
    CircuitBreakerConfig,
    OllamaConfig,
    OpenAIConfig,
    QueueConfig,
    RedisConfig,
    Settings,
    TelemetryPhiGuardConfig,
    VertexConfig,
    get_settings,
)
from smr.tests.conftest import keyed


def _clear_smr_env(monkeypatch):
    """Remove all SMR_* env vars so pydantic-settings reads only code defaults."""
    for key in list(os.environ):
        if key.startswith("SMR_"):
            monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def _isolate_smr_env(monkeypatch):
    _clear_smr_env(monkeypatch)


class TestOllamaConfig:
    def test_defaults(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        cfg = OllamaConfig()
        assert cfg.base_url == "http://localhost:11434"
        # An OLLAMA tag, not a Hugging Face path. Pinned because the old value
        # (`google/gemma-4-e4b`) was an id no backend ever served.
        assert cfg.default_model == "gemma4:e2b-it-qat"
        assert cfg.timeout_s == 300
        assert cfg.max_concurrent == 4

    def test_override(self):
        cfg = OllamaConfig(base_url="http://gpu:11434", default_model="gemma2:7b")
        assert cfg.base_url == "http://gpu:11434"
        assert cfg.default_model == "gemma2:7b"

    def test_env_prefix(self, monkeypatch):
        # a stale SMR_*_ENABLED env is ignored (no such field now).
        monkeypatch.setenv("SMR_OLLAMA_ENABLED", "true")
        monkeypatch.setenv("SMR_OLLAMA_BASE_URL", "http://remote:11434")
        cfg = OllamaConfig()
        assert cfg.base_url == "http://remote:11434"


class TestAzureOpenAIConfig:
    def test_defaults(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        cfg = AzureOpenAIConfig()
        assert cfg.api_key.get_secret_value() == ""
        assert cfg.endpoint == ""
        # Cloud providers carry no compiled-in vendor model default —
        # provider/model SELECTION is failMode=closed (informational-only field).
        assert cfg.default_model == ""
        assert cfg.tpm_limit == 80_000
        assert cfg.rpm_limit == 480
        assert cfg.adaptive_limits is True

    def test_override(self):
        cfg = keyed(
            AzureOpenAIConfig(endpoint="https://my.openai.azure.com", deployment_name="gpt-4o"),
            "sk-test",
        )
        assert cfg.api_key.get_secret_value() == "sk-test"
        assert cfg.deployment_name == "gpt-4o"

    def test_api_key_not_read_from_env(self, monkeypatch):
        # Api_key is BYOK-only — SMR_AZURE_API_KEY no longer populates it.
        monkeypatch.setenv("SMR_AZURE_API_KEY", "env-key")
        monkeypatch.setenv("SMR_AZURE_RPM_LIMIT", "1000")
        cfg = AzureOpenAIConfig()
        assert cfg.api_key.get_secret_value() == ""  # env ignored
        assert cfg.rpm_limit == 1000  # non-secret still env-sourced


class TestBedrockConfig:
    def test_defaults(self):
        cfg = BedrockConfig()
        assert cfg.region == "us-east-1"
        assert cfg.max_pool_connections == 150
        assert cfg.tpm_limit == 100_000
        assert cfg.rpm_limit == 100
        # No compiled-in vendor model default (informational-only field).
        assert cfg.default_model == ""

    def test_override(self):
        cfg = BedrockConfig(region="eu-west-1", default_model="amazon.titan-text-express-v1")
        assert cfg.region == "eu-west-1"

    def test_env_prefix(self, monkeypatch):
        monkeypatch.setenv("SMR_BEDROCK_REGION", "ap-southeast-1")
        cfg = BedrockConfig()
        assert cfg.region == "ap-southeast-1"


class TestOpenAIConfig:
    """No compiled-in vendor model default (informational-only field)."""

    def test_defaults(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        cfg = OpenAIConfig()
        assert cfg.default_model == ""
        assert cfg.base_url == "https://api.openai.com/v1"


class TestAnthropicConfig:
    """No compiled-in vendor model default (informational-only field)."""

    def test_defaults(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        cfg = AnthropicConfig()
        assert cfg.default_model == ""


class TestVertexConfig:
    """No compiled-in vendor model default (informational-only field)."""

    def test_defaults(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        cfg = VertexConfig()
        assert cfg.default_model == ""
        assert cfg.location == "us-central1"


class TestRedisConfig:
    def test_defaults(self):
        cfg = RedisConfig()
        assert cfg.redis_url == "redis://localhost:6379/0"
        assert cfg.task_ttl_seconds == 3600
        assert cfg.stream_max_len == 10_000


class TestCircuitBreakerConfig:
    def test_defaults(self):
        cfg = CircuitBreakerConfig()
        assert cfg.failure_threshold == 5
        assert cfg.recovery_timeout_s == 30.0
        assert cfg.count_rate_limits is True
        # D6: None is the deliberate "no-op" sentinel — it preserves
        # CircuitBreaker's pre-wiring behavior (unlimited HALF_OPEN calls, no
        # failure-count decay) on an unconfigured deployment.
        assert cfg.half_open_max_calls is None
        assert cfg.reset_timeout_s is None


class TestQueueConfig:
    def test_defaults(self):
        cfg = QueueConfig()
        assert cfg.max_size == 200
        assert cfg.max_wait_s == 60.0


class TestTelemetryPhiGuardConfig:
    """PHI-safe telemetry boot guard.

    Mirrors the gateway's `assertGenaiContentCaptureDisabled` posture:
    `NODE_ENV=production` + a content-capture value other than the literal
    `NO_CONTENT` (including unset, i.e. the empty-string default) must refuse
    to construct. Every other environment is unenforced, matching the
    env-sample flow pinning `NO_CONTENT` as a template default rather than a
    hard runtime requirement outside production.

    Constructed via keyword args (the `init_settings` source outranks env),
    so these tests do not depend on ambient process env / .env.test content —
    consistent with `AzureOpenAIConfig`/`BedrockConfig` construction tests
    above. `_isolate_smr_env` (module-level, autouse) only clears `SMR_*`
    names, so this class adds its own autouse isolation for the two bare
    names this config reads.
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
        cfg = TelemetryPhiGuardConfig(node_env="test", genai_capture_message_content="SPAN_AND_EVENT")
        assert cfg.genai_capture_message_content == "SPAN_AND_EVENT"

    def test_passes_in_production_when_exactly_no_content(self):
        cfg = TelemetryPhiGuardConfig(node_env="production", genai_capture_message_content="NO_CONTENT")
        assert cfg.genai_capture_message_content == "NO_CONTENT"

    def test_refuses_in_production_when_unset(self):
        with pytest.raises(ValidationError, match="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"):
            TelemetryPhiGuardConfig(node_env="production")

    def test_refuses_in_production_with_permissive_value(self):
        with pytest.raises(ValidationError, match="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"):
            TelemetryPhiGuardConfig(node_env="production", genai_capture_message_content="SPAN_AND_EVENT")

    def test_refuses_in_production_on_near_miss_case(self):
        with pytest.raises(ValidationError):
            TelemetryPhiGuardConfig(node_env="production", genai_capture_message_content="no_content")

    def test_reads_bare_env_names_not_smr_prefixed(self, monkeypatch):
        # These are cross-process conventions — SMR_NODE_ENV / SMR_OTEL_... must
        # NOT be what this class reads (Settings' env_prefix_target="all" would
        # otherwise silently prefix them).
        monkeypatch.setenv("NODE_ENV", "test")
        monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "NO_CONTENT")
        monkeypatch.setenv("SMR_NODE_ENV", "production")
        monkeypatch.setenv("SMR_OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "SPAN_AND_EVENT")
        cfg = TelemetryPhiGuardConfig()
        assert cfg.node_env == "test"
        assert cfg.genai_capture_message_content == "NO_CONTENT"

    def test_settings_construction_refuses_in_production(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.delenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", raising=False)
        with pytest.raises(ValidationError, match="OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"):
            Settings()

    def test_settings_construction_passes_in_production_when_pinned(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.setenv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "NO_CONTENT")
        s = Settings()
        assert s.telemetry_phi_guard.genai_capture_message_content == "NO_CONTENT"


class TestSettings:
    def test_defaults(self, monkeypatch):
        _clear_smr_env(monkeypatch)
        s = Settings()
        assert s.host == "0.0.0.0"
        assert s.port == 8862
        assert s.debug is False
        assert s.log_level == "info"
        assert s.metrics_enabled is True
        assert s.cors_origins == []
        assert s.cors_enabled is False

    def test_sub_configs_instantiated(self):
        s = Settings()
        assert isinstance(s.ollama, OllamaConfig)
        assert isinstance(s.azure, AzureOpenAIConfig)
        assert isinstance(s.bedrock, BedrockConfig)
        assert isinstance(s.redis, RedisConfig)
        assert isinstance(s.circuit_breaker, CircuitBreakerConfig)
        assert isinstance(s.queue, QueueConfig)

    def test_log_level_normalised_to_lowercase(self):
        s = Settings(log_level="DEBUG")
        assert s.log_level == "debug"

    def test_log_level_mixed_case(self):
        s = Settings(log_level="Warning")
        assert s.log_level == "warning"

    def test_custom_cors_origins(self):
        s = Settings(cors_origins=["https://app.example.com", "http://localhost:8868/api/v1"])
        assert len(s.cors_origins) == 2

    def test_override_connection_pool(self):
        s = Settings(httpx_max_connections=500, httpx_max_keepalive=250)
        assert s.httpx_max_connections == 500
        assert s.httpx_max_keepalive == 250


class TestGetSettings:
    def test_returns_settings_instance(self):
        s = get_settings()
        assert isinstance(s, Settings)

    def test_returns_fresh_instance_each_call(self):
        s1 = get_settings()
        s2 = get_settings()
        assert s1 is not s2
