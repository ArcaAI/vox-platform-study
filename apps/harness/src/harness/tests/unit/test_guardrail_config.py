"""Phase-2 guardrail configuration tests.

Phase 2 needs

* a **safety** sub-config (``HARNESS_SAFETY_*``) for the Granite Guardian
  content-safety classifier — defaulting to the LM Studio (OpenAI-compatible)
  engine with an optional ``provider`` switch (azure/bedrock),
* a fail-closed **PHI** sub-config (``HARNESS_PHI_*``) for the pre-cloud-egress
  redaction guard, and
* the existing eval :class:`~harness.eval.config.JudgeConfig` (``HARNESS_JUDGE_*``)
  **reused** (not duplicated) for the runtime groundedness/reasoning judge.

Every knob is env-driven and offline (no network at construction time).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from harness.core.config import (
    PhiConfig,
    SafetyGuardConfig,
    Settings,
    get_runtime_judge_config,
)

_SAFETY_ENV = (
    "HARNESS_SAFETY_ENABLED",
    "HARNESS_SAFETY_PROVIDER",
    "HARNESS_SAFETY_BASE_URL",
    "HARNESS_SAFETY_MODEL",
    "HARNESS_SAFETY_NO_THINK",
    "HARNESS_SAFETY_TIMEOUT_S",
    "HARNESS_SAFETY_HARM_CRITERIA",
)
_PHI_ENV = (
    "HARNESS_PHI_ENABLED",
    "HARNESS_PHI_FAIL_CLOSED",
    "HARNESS_PHI_LOCAL_PROVIDERS",
)


class TestSafetyGuardConfig:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch):
        for var in _SAFETY_ENV:
            monkeypatch.delenv(var, raising=False)
        c = SafetyGuardConfig()
        assert c.enabled is True
        # Default engine is LM Studio (OpenAI-compatible /v1 endpoint).
        assert c.provider == "lm-studio"
        assert c.base_url == "http://localhost:1234/v1"
        # Granite Guardian 4.1 slug (operator-overridable to match the loaded build).
        assert c.model == "granite-guardian-4.1-8b"
        assert "guardian" in c.model.lower()
        # Guard classifier runs in no-think mode for fast, deterministic verdicts.
        assert c.no_think is True
        assert c.timeout_s > 0
        assert isinstance(c.harm_criteria, list) and c.harm_criteria

    def test_env_override_selects_azure_engine(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_SAFETY_PROVIDER", "azure")
        monkeypatch.setenv("HARNESS_SAFETY_MODEL", "granite-guardian-deployment")
        monkeypatch.setenv("HARNESS_SAFETY_BASE_URL", "https://example.openai.azure.com")
        monkeypatch.setenv("HARNESS_SAFETY_ENABLED", "false")
        monkeypatch.setenv("HARNESS_SAFETY_NO_THINK", "false")
        monkeypatch.setenv("HARNESS_SAFETY_TIMEOUT_S", "90")
        c = SafetyGuardConfig()
        assert c.provider == "azure"
        assert c.model == "granite-guardian-deployment"
        assert c.base_url == "https://example.openai.azure.com"
        assert c.enabled is False
        assert c.no_think is False
        assert c.timeout_s == 90.0

    def test_invalid_provider_rejected(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_SAFETY_PROVIDER", "not-an-engine")
        with pytest.raises(ValidationError):
            SafetyGuardConfig()

    def test_ollama_provider_rejected(self, monkeypatch: pytest.MonkeyPatch):
        # R1 (TASK-736): Ollama is removed entirely — a deployment whose env still
        # sets HARNESS_SAFETY_PROVIDER=ollama must now fail startup validation
        # (fail-fast) rather than silently running against a removed engine.
        monkeypatch.setenv("HARNESS_SAFETY_PROVIDER", "ollama")
        with pytest.raises(ValidationError):
            SafetyGuardConfig()

    def test_harm_criteria_parsed_from_env_json(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_SAFETY_HARM_CRITERIA", '["harm", "violence"]')
        assert SafetyGuardConfig().harm_criteria == ["harm", "violence"]


class TestPhiConfig:
    def test_defaults_are_fail_closed(self, monkeypatch: pytest.MonkeyPatch):
        for var in _PHI_ENV:
            monkeypatch.delenv(var, raising=False)
        c = PhiConfig()
        assert c.enabled is True
        # The whole point of the PHI guard: fail CLOSED (block egress on doubt).
        assert c.fail_closed is True
        # The known-LOCAL providers — everything else (including a provider not
        # in this list) defaults to redact-and-confirm (default-deny; TASK-706).
        assert "lm-studio" in c.local_providers
        # R1 (TASK-736): Ollama is removed entirely, so it is no longer treated
        # as local — an ollama-routed call now falls into the default-deny
        # (redact-and-confirm) branch like any unrecognized provider.
        assert "ollama" not in c.local_providers
        assert "azure" not in c.local_providers
        assert "bedrock" not in c.local_providers

    def test_env_override(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_PHI_FAIL_CLOSED", "false")
        monkeypatch.setenv("HARNESS_PHI_LOCAL_PROVIDERS", '["lm-studio"]')
        c = PhiConfig()
        assert c.fail_closed is False
        assert c.local_providers == ["lm-studio"]

    def test_empty_local_providers_raises_when_enabled(self) -> None:
        # TASK-706 Task 4: an empty local-provider list under enabled=True would
        # redact EVERY call (including genuinely local ones) — almost certainly a
        # misconfiguration, so refuse to boot rather than silently degrade.
        with pytest.raises(ValidationError):
            PhiConfig(enabled=True, local_providers=[])

    def test_empty_local_providers_allowed_when_disabled(self) -> None:
        # The guard itself is off, so an empty list is not a footgun.
        c = PhiConfig(enabled=False, local_providers=[])
        assert c.local_providers == []

    def test_duplicate_local_providers_raises(self) -> None:
        with pytest.raises(ValidationError):
            PhiConfig(local_providers=["lm-studio", "lm-studio"])

    def test_blank_local_provider_entry_raises(self) -> None:
        with pytest.raises(ValidationError):
            PhiConfig(local_providers=["lm-studio", "  "])


class TestSettingsWiring:
    def test_settings_expose_safety_and_phi_subconfigs(self):
        s = Settings()
        assert isinstance(s.safety, SafetyGuardConfig)
        assert isinstance(s.phi, PhiConfig)

    def test_safety_subconfig_reads_its_prefix_through_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("HARNESS_SAFETY_MODEL", "granite-guardian-4.1-8b")
        assert Settings().safety.model == "granite-guardian-4.1-8b"


class TestRuntimeJudgeReuse:
    """The runtime groundedness/reasoning judge REUSES the eval JudgeConfig — it
    is not re-declared under a new prefix (single source of truth: HARNESS_JUDGE_*)."""

    def test_runtime_judge_config_is_the_eval_judge_config(self):
        from harness.eval.config import JudgeConfig

        assert isinstance(get_runtime_judge_config(), JudgeConfig)

    def test_runtime_judge_honors_harness_judge_env(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_JUDGE_MODEL", "google/gemma-4-e4b")
        assert get_runtime_judge_config().model == "google/gemma-4-e4b"


class TestUnitIntervalUnaffected:
    """Sanity: a bogus safety timeout is still a float (no silent coercion bug)."""

    def test_timeout_must_be_numeric(self):
        with pytest.raises(ValidationError):
            SafetyGuardConfig(timeout_s="not-a-number")  # type: ignore[arg-type]
