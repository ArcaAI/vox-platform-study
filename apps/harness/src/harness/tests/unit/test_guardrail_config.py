"""Phase-2 guardrail configuration tests (TASK-330 Phase 2 — FOUNDATION).

RED-first: written before the ``core/config.py`` additions exist. Phase 2 needs

* a **Granite Guardian** sub-config (``HARNESS_GRANITE_*``) for the local Ollama
  content-safety classifier,
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
    GraniteGuardConfig,
    PhiConfig,
    Settings,
    get_runtime_judge_config,
)

_GRANITE_ENV = (
    "HARNESS_GRANITE_ENABLED",
    "HARNESS_GRANITE_BASE_URL",
    "HARNESS_GRANITE_MODEL",
    "HARNESS_GRANITE_NO_THINK",
    "HARNESS_GRANITE_TIMEOUT_S",
    "HARNESS_GRANITE_HARM_CRITERIA",
)
_PHI_ENV = (
    "HARNESS_PHI_ENABLED",
    "HARNESS_PHI_FAIL_CLOSED",
    "HARNESS_PHI_CLOUD_EGRESS_PROVIDERS",
)


class TestGraniteGuardConfig:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch):
        for var in _GRANITE_ENV:
            monkeypatch.delenv(var, raising=False)
        c = GraniteGuardConfig()
        assert c.enabled is True
        # Ollama native API endpoint (NOT the OpenAI-compatible /v1 path).
        assert c.base_url == "http://localhost:11434"
        # An IBM Granite Guardian tag (family-agnostic assertion — exact tag is
        # operator-overridable; see the config docstring for the 4.1 note).
        assert "guardian" in c.model.lower()
        # Guard classifier runs in no-think mode for fast, deterministic verdicts.
        assert c.no_think is True
        assert c.timeout_s > 0
        assert isinstance(c.harm_criteria, list) and c.harm_criteria

    def test_env_override(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_GRANITE_MODEL", "elishabjm/granite-guardian-4.1:8b-q4_k_m")
        monkeypatch.setenv("HARNESS_GRANITE_BASE_URL", "http://ollama:11434")
        monkeypatch.setenv("HARNESS_GRANITE_ENABLED", "false")
        monkeypatch.setenv("HARNESS_GRANITE_NO_THINK", "false")
        monkeypatch.setenv("HARNESS_GRANITE_TIMEOUT_S", "90")
        c = GraniteGuardConfig()
        assert c.model == "elishabjm/granite-guardian-4.1:8b-q4_k_m"
        assert c.base_url == "http://ollama:11434"
        assert c.enabled is False
        assert c.no_think is False
        assert c.timeout_s == 90.0

    def test_harm_criteria_parsed_from_env_json(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_GRANITE_HARM_CRITERIA", '["harm", "violence"]')
        assert GraniteGuardConfig().harm_criteria == ["harm", "violence"]


class TestPhiConfig:
    def test_defaults_are_fail_closed(self, monkeypatch: pytest.MonkeyPatch):
        for var in _PHI_ENV:
            monkeypatch.delenv(var, raising=False)
        c = PhiConfig()
        assert c.enabled is True
        # The whole point of the PHI guard: fail CLOSED (block egress on doubt).
        assert c.fail_closed is True
        # The cloud-egress providers requiring PHI redaction before any send.
        assert "azure" in c.cloud_egress_providers
        assert "bedrock" in c.cloud_egress_providers

    def test_env_override(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("HARNESS_PHI_FAIL_CLOSED", "false")
        monkeypatch.setenv("HARNESS_PHI_CLOUD_EGRESS_PROVIDERS", '["azure"]')
        c = PhiConfig()
        assert c.fail_closed is False
        assert c.cloud_egress_providers == ["azure"]


class TestSettingsWiring:
    def test_settings_expose_granite_and_phi_subconfigs(self):
        s = Settings()
        assert isinstance(s.granite, GraniteGuardConfig)
        assert isinstance(s.phi, PhiConfig)

    def test_granite_subconfig_reads_its_prefix_through_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("HARNESS_GRANITE_MODEL", "ibm/granite3.3-guardian:8b")
        assert Settings().granite.model == "ibm/granite3.3-guardian:8b"


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
    """Sanity: a bogus Granite timeout is still a float (no silent coercion bug)."""

    def test_timeout_must_be_numeric(self):
        with pytest.raises(ValidationError):
            GraniteGuardConfig(timeout_s="not-a-number")  # type: ignore[arg-type]
