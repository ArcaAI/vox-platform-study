"""TASK-799 lane D — guardrail's last env-owned policy plane, and the knob duplicates.

Four defects, all of the same family: a configuration value that a platform admin
cannot change without a restart, or the SAME value declared in two places so the
two can disagree.

* D.2a — `GUARDRAIL_V2_GROUNDEDNESS_*` was the last policy plane living in env.
  The clinical gate's on/off switch and its VERDICT-DECIDING
  `entailment_threshold` were pydantic defaults, so changing either meant a
  redeploy. Every other guardrail threshold already rides
  `AiModel._metadata.policy` under a declared `failMode` (`core/policy.py`).
  The threshold joins them; the gate switch and the batch geometry ride the
  control-plane pull route this service ALREADY consumes.

  Note the split is not arbitrary. The threshold is MODEL-COUPLED — it thresholds
  the scores of the specific NLI checkpoint the selection resolved, so it belongs
  on that model's row. The gate switch is not: putting it on the model row would
  be circular, because the switch decides whether the selection is resolved at all.

* D.2b — the judge tuning duplicates. `judgeTemperature` and `judgeMaxInputChars`
  were declared and bounded in `_SPECS` with ZERO readers anywhere, while the
  live values came from `AiRuntimeProfile` / `JudgePolicy`. A declared knob that
  nothing reads is worse than an absent one: it reads as configurable.

* D.2c — `_DEFAULT_BENIGN` existed as two DIFFERENT literals in two modules, both
  already overridden by `labelTaxonomy.benignLabels`.

* D.2d — `GUARDRAIL_DB_CONFIG_ENABLED`'s only non-default value 503s every route
  rather than selecting an env engine (guardrail hosts no LLM). A knob whose
  "off" position bricks the service is not configuration.

* D.2e — `GUARDRAIL_V2_CORS_ENABLED` is derivable: CORS is on exactly when
  origins are named.
"""

from __future__ import annotations

import pytest

from guardrail.core.config import Settings
from guardrail.core.policy import GuardrailPolicy


class TestGroundednessThresholdIsPolicy:
    """D.2a — the verdict-deciding threshold rides the model's own policy blob."""

    def test_the_threshold_is_a_declared_tuning_key(self) -> None:
        assert GuardrailPolicy.fail_mode("groundednessEntailmentThreshold") == "open-to-default"

    def test_a_configured_threshold_wins(self) -> None:
        policy = GuardrailPolicy({"groundednessEntailmentThreshold": 0.8})
        assert policy.groundedness_entailment_threshold == 0.8

    def test_an_absent_threshold_falls_to_the_declared_default(self) -> None:
        assert GuardrailPolicy({}).groundedness_entailment_threshold == 0.5

    @pytest.mark.parametrize("bad", [-0.1, 1.1, "0.7", True, None])
    def test_an_out_of_range_or_mistyped_threshold_never_becomes_a_verdict(
        self, bad: object
    ) -> None:
        """A nonsensical threshold must not be coerced into a real gate.

        `0.0` would mark every segment GROUNDED and `1.1` every segment
        UNGROUNDED — both are silent clinical failures, so the declared default
        stands instead.
        """
        assert GuardrailPolicy({"groundednessEntailmentThreshold": bad}).groundedness_entailment_threshold == 0.5

    def test_env_can_no_longer_move_the_threshold(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The field survives as the runtime CARRIER; what is gone is the env
        PATH to it. Asserting the attribute's absence would be asserting the
        wrong thing — the verifier still has to read the value from somewhere."""
        monkeypatch.setenv("GUARDRAIL_V2_GROUNDEDNESS_ENTAILMENT_THRESHOLD", "0.9")
        assert Settings().groundedness.entailment_threshold == 0.5


class TestGroundednessGateRidesTheControlPlane:
    """D.2a — the on/off switch and batch geometry move to the pull route."""

    def test_env_can_no_longer_move_the_gate(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Most important of the three: `GUARDRAIL_V2_GROUNDEDNESS_ENABLED=true`
        must NOT switch a clinical gate on any more. The gate is on when the
        control plane says so, and nowhere else."""
        monkeypatch.setenv("GUARDRAIL_V2_GROUNDEDNESS_ENABLED", "true")
        monkeypatch.setenv("GUARDRAIL_V2_GROUNDEDNESS_BATCH_SIZE", "64")
        monkeypatch.setenv("GUARDRAIL_V2_GROUNDEDNESS_MAX_SEGMENTS", "999")

        groundedness = Settings().groundedness
        assert groundedness.enabled is False
        assert groundedness.batch_size == 16
        assert groundedness.max_segments == 200

    def test_the_carrier_is_not_a_settings_class_at_all(self) -> None:
        """Structural, not incidental: `GroundednessConfig` no longer inherits
        `BaseSettings`, so there is no env path to re-open by adding a field."""
        from pydantic_settings import BaseSettings

        from guardrail.core.config import GroundednessConfig

        assert not issubclass(GroundednessConfig, BaseSettings)

    def test_the_snapshot_reads_the_generic_settings_map(self) -> None:
        """The generic `settings` channel is the declared extension point.

        A descriptor naming `consumedBy: ['guardrail']` is served at
        `settings["<dotted.key>"]`, so a new knob needs no new frozen group.
        """
        from guardrail.core.effective_config import EffectiveConfigSnapshot

        snapshot = EffectiveConfigSnapshot(
            raw={
                "settings": {
                    "guardrail.groundedness.enabled": {"value": True, "dataType": "boolean"},
                    "guardrail.groundedness.batchSize": {"value": 32, "dataType": "number"},
                    "guardrail.groundedness.maxSegments": {"value": 500, "dataType": "number"},
                }
            },
            ok=True,
        )
        assert snapshot.groundedness() == {
            "enabled": True,
            "batch_size": 32,
            "max_segments": 500,
        }

    def test_the_gate_defaults_OFF_when_the_control_plane_has_no_opinion(self) -> None:
        """Absent ⇒ off. A safety gate is never switched on by silence."""
        from guardrail.core.effective_config import EffectiveConfigSnapshot

        assert EffectiveConfigSnapshot(raw={}, ok=False).groundedness() == {}


class TestJudgeTuningHasOneSourceEach:
    """D.2b — the declared-but-unread duplicates are gone."""

    @pytest.mark.parametrize("dead", ["judgeTemperature", "judgeMaxInputChars"])
    def test_the_dead_policy_keys_are_no_longer_declared(self, dead: str) -> None:
        """Declared and unread is worse than absent: it advertises a knob that
        cannot move the value, so an admin who sets it sees no effect and no error.

        `temperature` is served by `AiRuntimeProfile.temperature`; `max_input_chars`
        by `JudgePolicy`. Neither ever consulted these."""
        assert GuardrailPolicy.fail_mode(dead) == "closed", (
            f"{dead} is still a declared tuning key"
        )
        with pytest.raises(KeyError):
            GuardrailPolicy({}).number(dead)

    def test_the_surviving_judge_default_has_exactly_one_literal(self) -> None:
        """`judgeMinConfidence`'s default is DERIVED from `JudgePolicy`, not a
        second copy of `0.75` that can drift away from it."""
        from guardrail.core.config import JudgePolicy

        assert GuardrailPolicy({}).judge_min_confidence == JudgePolicy().min_confidence


class TestBenignLabelsHaveOneDefinition:
    """D.2c — one literal, not two that disagree."""

    def test_screening_reuses_the_analyzer_default(self) -> None:
        from guardrail.services.safety_analyzer import _DEFAULT_BENIGN as ANALYZER
        from guardrail.services.screening import _DEFAULT_BENIGN as SCREENING

        assert SCREENING is ANALYZER, (
            "screening declared its own superset — two defaults for one concept, "
            "so a label counted benign by one layer and unsafe by the other"
        )


class TestDeletedKnobs:
    def test_db_config_enabled_is_gone(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """D.2d — its only non-default value 503s every route.

        Here the attribute really must be ABSENT: unlike the groundedness fields
        there is no runtime carrier role left for it to play."""
        monkeypatch.setenv("GUARDRAIL_DB_CONFIG_ENABLED", "false")
        assert not hasattr(Settings().db, "db_config_enabled")

    def test_cors_is_derived_from_the_origins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """D.2e — CORS is on exactly when origins are named."""
        monkeypatch.delenv("GUARDRAIL_V2_CORS_ORIGINS", raising=False)
        assert Settings().cors_enabled is False

        monkeypatch.setenv("GUARDRAIL_V2_CORS_ORIGINS", '["https://admin.example.com"]')
        assert Settings().cors_enabled is True

    def test_cors_enabled_is_not_settable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A derived value with its own override is just the old bug wearing a
        property: the two could still disagree."""
        monkeypatch.delenv("GUARDRAIL_V2_CORS_ORIGINS", raising=False)
        monkeypatch.setenv("GUARDRAIL_V2_CORS_ENABLED", "true")
        assert Settings().cors_enabled is False
