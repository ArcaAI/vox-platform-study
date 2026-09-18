"""``ObservabilityConfig`` — the one env contract (R-2).

The findings these tests pin: F-02 (NLP had three correct OTel variables set
and exported nothing, because a separate boolean disagreed with the endpoint
beside it) and F-09 (a helper whose environment default was ``"production"``
stamped laptop spans as production).
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from hope_obs import ObservabilityConfig


class TestEnableSignal:
    def test_no_endpoint_means_tracing_off(self) -> None:
        config = ObservabilityConfig(service_name="stt")
        assert config.otlp_endpoint is None
        assert config.tracing_enabled is False

    def test_endpoint_presence_is_the_enable_signal(self) -> None:
        config = ObservabilityConfig(service_name="stt", otlp_endpoint="http://collector:4317")
        assert config.tracing_enabled is True

    def test_empty_endpoint_is_not_an_enable_signal(self) -> None:
        assert ObservabilityConfig(service_name="stt", otlp_endpoint="").tracing_enabled is False

    def test_from_env_reads_the_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        assert ObservabilityConfig.from_env("stt").tracing_enabled is False
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4317")
        resolved = ObservabilityConfig.from_env("stt")
        assert resolved.tracing_enabled is True
        assert resolved.otlp_endpoint == "http://collector:4317"

    def test_there_is_no_enable_boolean(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """F-02: an ``*_OTEL_ENABLED`` flag can never contradict the endpoint again."""
        monkeypatch.setenv("STT_OTEL_ENABLED", "false")
        monkeypatch.setenv("OTEL_ENABLED", "false")
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4317")
        assert ObservabilityConfig.from_env("stt").tracing_enabled is True


class TestInsecure:
    @pytest.mark.parametrize(
        ("endpoint", "expected"),
        [
            ("http://collector:4317", True),
            ("https://collector:4317", False),
            ("collector:4317", True),
            (None, True),
        ],
    )
    def test_insecure_is_derived_from_the_scheme(
        self, endpoint: str | None, expected: bool
    ) -> None:
        config = ObservabilityConfig(service_name="stt", otlp_endpoint=endpoint)
        assert config.insecure is expected


class TestServiceIdentity:
    def test_service_name_comes_from_the_argument(self) -> None:
        assert ObservabilityConfig.from_env("guardrail").service_name == "guardrail"

    def test_otel_service_name_overrides_the_argument(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_SERVICE_NAME", "hope-stt-v2")
        assert ObservabilityConfig.from_env("stt").service_name == "hope-stt-v2"

    def test_service_version_is_a_keyword_argument(self) -> None:
        config = ObservabilityConfig.from_env("stt", service_version="2.0.0")
        assert config.service_version == "2.0.0"

    def test_namespace_default(self) -> None:
        assert ObservabilityConfig.from_env("stt").service_namespace == "hope"


class TestEnvironment:
    def test_default_is_development_never_production(self) -> None:
        """F-09: a mislabelled dev span is noise; a mislabelled prod span
        corrupts an audit trail."""
        assert ObservabilityConfig.from_env("stt").deployment_environment == "development"
        assert ObservabilityConfig(service_name="stt").deployment_environment == "development"

    def test_node_env_is_used_when_deployment_environment_is_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("NODE_ENV", "test")
        assert ObservabilityConfig.from_env("stt").deployment_environment == "test"

    def test_deployment_environment_wins_over_node_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("NODE_ENV", "test")
        monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "dev")
        assert ObservabilityConfig.from_env("stt").deployment_environment == "dev"


class TestSampler:
    def test_default_ratio_is_one(self) -> None:
        assert ObservabilityConfig.from_env("stt").traces_sampler_ratio == 1.0

    def test_ratio_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "0.25")
        assert ObservabilityConfig.from_env("stt").traces_sampler_ratio == 0.25

    def test_unparseable_ratio_falls_back_to_one(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "aggressive")
        assert ObservabilityConfig.from_env("stt").traces_sampler_ratio == 1.0

    def test_out_of_range_ratio_is_clamped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "7")
        assert ObservabilityConfig.from_env("stt").traces_sampler_ratio == 1.0


class TestLogLevel:
    def test_default_is_info(self) -> None:
        assert ObservabilityConfig.from_env("stt").log_level == "info"

    def test_level_by_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LOG_LEVEL", "INFO")
        assert ObservabilityConfig.from_env("stt").log_level == "INFO"

    def test_level_by_number(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Both spellings are in live use across the fleet's env files."""
        monkeypatch.setenv("LOG_LEVEL", "20")
        assert ObservabilityConfig.from_env("stt").log_level == "20"

    def test_service_scoped_override_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LOG_LEVEL", "warning")
        monkeypatch.setenv("STT_LOG_LEVEL", "debug")
        assert ObservabilityConfig.from_env("stt").log_level == "debug"

    def test_service_scoped_override_is_keyed_on_the_argument_not_otel_service_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`<SVC>_LOG_LEVEL` follows the service's own identity.

        `OTEL_SERVICE_NAME` renames the telemetry RESOURCE (in-cluster STT is
        `hope-stt-v2`); it must not move the log-level variable an operator
        would reasonably look for, which is `STT_LOG_LEVEL`.
        """
        monkeypatch.setenv("OTEL_SERVICE_NAME", "hope-stt-v2")
        monkeypatch.setenv("STT_LOG_LEVEL", "error")
        assert ObservabilityConfig.from_env("stt").log_level == "error"


class TestImmutability:
    def test_config_is_frozen(self) -> None:
        config = ObservabilityConfig(service_name="stt")
        with pytest.raises(FrozenInstanceError):
            config.service_name = "text"  # type: ignore[misc]
