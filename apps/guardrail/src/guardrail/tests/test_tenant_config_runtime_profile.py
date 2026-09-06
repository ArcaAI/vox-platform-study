"""Guardrail applies per-tenant tuning to the delegating judge client.

Guardrail keeps its SQL resolver rather than adopting the HTTP pull client.
Since TASK-862 the tuning (temperature / maxTokens / timeoutS) rides on the
winning `AiRoutingPolicy.configJson` — the `AiRuntimeProfile` table it used to
come from is retired — but the `GuardrailTenantConfig` contract below is
unchanged: the fields are optional and absent tuning keeps the policy defaults.

The existing fail-safe posture must not be weakened: profile fields stay optional
everywhere, and an absent profile leaves the judge policy's own defaults in force.
Since the profile lands on the DELEGATING client rather than on
an env engine sub-config — the tuning contract is unchanged, its destination moved.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import GuardrailTenantConfig, build_judge_client


@pytest.fixture
def settings() -> Settings:
    return Settings()


# the criteria that decides the verdict is CONFIG (policy key
# `medicalValidationCriteria`, failMode=closed) with no code default, so the
# resolved config must carry one before a judge can be built at all. TASK-878 put
# the judge's temperature and max-tokens on the SAME footing: they are
# model-coupled, so they live on the selected row's `_metadata.policy`, fail
# CLOSED, and are what an absent profile field now falls back to.
_POLICY_TEMPERATURE = 0.05
_POLICY_MAX_TOKENS = 300
_POLICY = {
    "medicalValidationCriteria": "you are a medical context validator",
    "judgeTemperature": _POLICY_TEMPERATURE,
    "judgeMaxTokens": _POLICY_MAX_TOKENS,
}


def _judge(settings: Settings, cfg: GuardrailTenantConfig):
    if cfg.policy is None:
        cfg = replace(cfg, policy=_POLICY)
    return build_judge_client(settings, cfg, http_client=object(), tenant_id="t-1")


class TestProfileFieldsAreOptional:
    def test_config_defaults_carry_no_profile_opinion(self) -> None:
        cfg = GuardrailTenantConfig()

        assert cfg.temperature is None
        assert cfg.max_tokens is None
        assert cfg.timeout_s is None

    def test_judge_keeps_policy_values_when_no_profile_exists(self, settings: Settings) -> None:
        """ "Policy values" now means the MODEL ROW's, not `JudgePolicy` literals —
        the contract this suite pins (optional fields, absent tuning changes
        nothing) is unchanged; what an absent field falls back TO moved."""
        from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S

        client = _judge(settings, GuardrailTenantConfig(model="m"))

        assert client.temperature == _POLICY_TEMPERATURE
        assert client.max_tokens == _POLICY_MAX_TOKENS
        assert client.timeout_s == DEFAULT_JUDGE_TIMEOUT_S


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
        assert client.max_tokens == _POLICY_MAX_TOKENS, "unserved keys keep policy values"

    def test_model_override_still_applies_alongside_a_profile(self, settings: Settings) -> None:
        client = _judge(settings, GuardrailTenantConfig(model="the-model", temperature=0.2))

        assert client.model == "the-model"
        assert client.temperature == 0.2


class TestLocalPathScope:
    def test_local_path_is_gone(self) -> None:
        """`local_path` must NOT exist: TASK-890 dropped `AiModel."localPath"`.

        Guardrail forwarded it to nobody, and the column it came from no longer
        exists — re-adding the field is how the reader starts selecting a
        dropped column again.
        """
        cfg = GuardrailTenantConfig()
        assert not hasattr(cfg, "local_path")
        assert cfg.checksum is None
