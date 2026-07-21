""" (Phase 3A) item C — the seven additive agentic loop knobs.

The DB-backed ``HarnessPolicy`` (worker snapshot) gains seven nullable
knobs. ``null ⇒ env default`` (per-field fallthrough): the harness only overrides
its runtime env/code default when the policy carries an explicit non-null value.

Covers:
  - ``HarnessPolicy.from_api`` maps all seven camelCase knobs (null/missing → None).
  - ``HarnessPolicy`` model defaults the seven knobs to None.
  - the ``_resolve_flag`` per-field fallthrough helper the activities use
    (policy override beats the env default; None falls through to env).
  - the ``retrieve_context`` activity honours a policy override over the env flag.
"""

from __future__ import annotations

from harness.temporal.activities import _resolve_flag, retrieve_context
from harness.temporal.models import HarnessPolicy, RetrieveContextInput


class TestFromApiMapsAgenticKnobs:
    def test_maps_all_seven_camelcase_knobs(self):
        policy = HarnessPolicy.from_api(
            {
                "optimisticDeliveryEnabled": True,
                "atomicFactEnabled": True,
                "retrievalEnabled": True,
                "warmStartEnabled": True,
                "nerPriorsEnabled": True,
                "maxEditReruns": 9,
                "regenFeedbackEnabled": True,
            }
        )
        assert policy.optimistic_delivery_enabled is True
        assert policy.atomic_fact_enabled is True
        assert policy.retrieval_enabled is True
        assert policy.warm_start_enabled is True
        assert policy.ner_priors_enabled is True
        assert policy.max_edit_reruns == 9
        assert policy.regen_feedback_enabled is True

    def test_missing_knobs_map_to_none_env_fallthrough(self):
        policy = HarnessPolicy.from_api({})
        assert policy.optimistic_delivery_enabled is None
        assert policy.atomic_fact_enabled is None
        assert policy.retrieval_enabled is None
        assert policy.warm_start_enabled is None
        assert policy.ner_priors_enabled is None
        assert policy.max_edit_reruns is None
        assert policy.regen_feedback_enabled is None

    def test_explicit_null_knobs_map_to_none(self):
        policy = HarnessPolicy.from_api(
            {"retrievalEnabled": None, "maxEditReruns": None, "nerPriorsEnabled": None}
        )
        assert policy.retrieval_enabled is None
        assert policy.max_edit_reruns is None
        assert policy.ner_priors_enabled is None

    def test_model_defaults_are_none(self):
        policy = HarnessPolicy()
        assert policy.optimistic_delivery_enabled is None
        assert policy.atomic_fact_enabled is None
        assert policy.retrieval_enabled is None
        assert policy.warm_start_enabled is None
        assert policy.ner_priors_enabled is None
        assert policy.max_edit_reruns is None
        assert policy.regen_feedback_enabled is None


class TestResolveFlagFallthrough:
    """The per-field fallthrough the activities use to prefer policy over env."""

    def test_policy_true_overrides_env_false(self):
        assert _resolve_flag(True, env_default=False) is True

    def test_policy_false_overrides_env_true(self):
        assert _resolve_flag(False, env_default=True) is False

    def test_none_falls_through_to_env_default(self):
        assert _resolve_flag(None, env_default=True) is True
        assert _resolve_flag(None, env_default=False) is False


class TestRetrieveContextPolicyOverride:
    """The ``retrieve_context`` activity prefers the policy flag over the env flag."""

    async def test_policy_off_overrides_env_on_skips_retrieval(self, monkeypatch):
        # Env has retrieval ON, but the per-run policy override is OFF → skip (no
        # backend calls), returning an empty context.
        from harness.core import config as config_mod

        settings = config_mod.get_settings()
        monkeypatch.setattr(settings.retrieval, "enabled", True, raising=False)

        result = await retrieve_context(
            RetrieveContextInput(tenant_id="t1", retrieval_enabled=False)
        )
        assert result.chunks == []
        assert result.prompt_block == ""

    async def test_none_falls_through_to_env_off(self, monkeypatch):
        # No policy override (None) and env OFF → skip (env default governs).
        from harness.core import config as config_mod

        settings = config_mod.get_settings()
        monkeypatch.setattr(settings.retrieval, "enabled", False, raising=False)

        result = await retrieve_context(
            RetrieveContextInput(tenant_id="t1", retrieval_enabled=None)
        )
        assert result.chunks == []
