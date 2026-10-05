"""Phase-2 guardrail configuration tests.

Phase 2 needs

* NO safety sub-config at all — ``HARNESS_SAFETY_*`` and its Granite Guardian engine
  plane were DELETED ( A.1 / F-02); the content-safety screen is delegated to
  ``apps/guardrail``. ``TestSafetyEnginePlaneDeleted`` locks that,
* NO **PHI** sub-config either — ``HARNESS_PHI_*`` was DELETED by TASK-1035: LLM egress
  redaction is ``apps/text``'s job, the run-effective PHI flags are ``HarnessPolicy`` (DB
  tier) and the direct-judge local set is code. ``TestPhiEnvPlaneDeleted`` locks that, and
* the existing eval :class:`~harness.eval.config.JudgeConfig` (``HARNESS_JUDGE_*``)
  **reused** (not duplicated) for the runtime groundedness/reasoning judge.

Every knob is env-driven and offline (no network at construction time).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

import harness.core.config as harness_config
from harness.core.config import (
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


class TestPhiEnvPlaneDeleted:
    """TASK-1035 — `HARNESS_PHI_*` is gone (no configuration in env).

    `HARNESS_PHI_LOCAL_PROVIDERS` was a PHI allow-list in environment, and both flags duplicated
    the per-tenant `HarnessPolicy.phiEnabled` / `phiFailClosed` the activities actually read.
    """

    def test_phi_config_class_is_gone(self) -> None:
        assert not hasattr(harness_config, "PhiConfig")

    def test_settings_carry_no_phi_subconfig(self) -> None:
        assert "phi" not in Settings.model_fields

    @pytest.mark.parametrize("var", _PHI_ENV)
    def test_no_field_binds_a_harness_phi_var(
        self, var: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
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
