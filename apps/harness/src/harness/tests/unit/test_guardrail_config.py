"""Phase-2 guardrail configuration tests.

Phase 2 needs

* NO safety sub-config at all — ``HARNESS_SAFETY_*`` and its Granite Guardian engine
  plane were DELETED (TASK-799 A.1 / F-02); the content-safety screen is delegated to
  ``apps/guardrail``. ``TestSafetyEnginePlaneDeleted`` locks that,
* a fail-closed **PHI** sub-config (``HARNESS_PHI_*``) for the pre-cloud-egress
  redaction guard, and
* the existing eval :class:`~harness.eval.config.JudgeConfig` (``HARNESS_JUDGE_*``)
  **reused** (not duplicated) for the runtime groundedness/reasoning judge.

Every knob is env-driven and offline (no network at construction time).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

import harness.core.config as harness_config
from harness.core.config import (
    PhiConfig,
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


class TestSafetyEnginePlaneDeleted:
    """`HARNESS_SAFETY_*` is gone, and must not come back (rule 06, rule 00 §Config).

    It declared a complete guardian ENGINE plane in environment — provider
    (`lm-studio`|`ollama`|`azure`|`bedrock`), base_url, a hardcoded
    `granite-guardian-4.1-8b` model id, and a 7-item clinical risk TAXONOMY in a JSON env
    array. All of that is `apps/guardrail`'s, resolved per tenant. These assertions are
    the regression lock: reintroducing the class or the sub-config field fails here.
    """

    def test_safety_guard_config_class_is_gone(self) -> None:
        assert not hasattr(harness_config, "SafetyGuardConfig")

    def test_settings_carry_no_safety_subconfig(self) -> None:
        assert "safety" not in Settings.model_fields

    @pytest.mark.parametrize("var", _SAFETY_ENV)
    def test_no_field_binds_a_harness_safety_var(
        self, var: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Setting any of the deleted vars changes nothing about the resolved settings."""
        monkeypatch.setenv(var, "should-be-ignored")
        assert not _reachable_env_names(Settings) & {var}


def _reachable_env_names(model: type) -> set[str]:
    """Every env var name the settings tree can bind, prefix-aware, recursively."""
    from pydantic_settings import BaseSettings

    prefix = model.model_config.get("env_prefix", "")
    names: set[str] = set()
    for field, info in model.model_fields.items():
        names.add(f"{prefix}{field}".upper())
        annotation = info.annotation
        if isinstance(annotation, type) and issubclass(annotation, BaseSettings):
            names |= _reachable_env_names(annotation)
    return names


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
        # Owner decision 2026-08-20 (TASK-736/TASK-740 D-740-3): Ollama provider
        # logic stays available, and it is a local (non-egress) engine like
        # lm-studio/vllm/llama-cpp — it belongs back on the PHI local allowlist.
        assert "ollama" in c.local_providers
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
    def test_settings_expose_the_phi_subconfig(self):
        assert isinstance(Settings().phi, PhiConfig)


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
    """Sanity: a bogus peer timeout is still a float (no silent coercion bug)."""

    def test_timeout_must_be_numeric(self):
        with pytest.raises(ValidationError):
            Settings(guardrail_timeout_s="not-a-number")  # type: ignore[arg-type]
