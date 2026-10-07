"""TASK-1050 §5 step 1 / §11.3 A — the judge policy keys and the shared policy-key catalogue.

* The four criteria keys are FAIL_CLOSED (no code default) and each has a reader (the judge
  runner, `services/judge_runner.py`).
* `judgeBands` is a per-check `{low, high}` map in [0, 1]; verdict-deciding, so fail-CLOSED and part
  of the policy version.
* `_SPECS` is exported to the committed `tests/contracts/policy-keys.json`; this test fails when the
  two drift (regenerate with `apps/guardrail/scripts/export_policy_keys.py`).
* The four `guardrail.judge.*` routing keys join the policy-version hash.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.policy import (
    FAIL_CLOSED,
    OPERATIONAL_KEYS,
    GuardrailPolicy,
    band_route,
    policy_key_catalogue,
)
from guardrail.core.policy_version import compute_policy_version, resolve_policy_version

CONTRACT = Path(__file__).parent / "contracts" / "policy-keys.json"
CRITERIA_KEYS = (
    "injectionJudgeCriteria",
    "unsafeContentJudgeCriteria",
    "outboundClinicalSafetyCriteria",
    "outboundLeakageCriteria",
)


@pytest.mark.parametrize("key", CRITERIA_KEYS)
def test_each_judge_criteria_key_is_declared_fail_closed(key: str) -> None:
    assert key in GuardrailPolicy.DECLARED_KEYS
    assert GuardrailPolicy.fail_mode(key) == FAIL_CLOSED
    assert key not in OPERATIONAL_KEYS
    with pytest.raises(GuardrailUndeterminedError):
        GuardrailPolicy.from_blob({}).require_criteria(key)
    assert GuardrailPolicy.from_blob({key: "  text  "}).require_criteria(key) == "text"


# ── judgeBands ────────────────────────────────────────────────────────────────


def test_judge_bands_is_a_declared_fail_closed_verdict_key() -> None:
    assert "judgeBands" in GuardrailPolicy.DECLARED_KEYS
    assert GuardrailPolicy.fail_mode("judgeBands") == FAIL_CLOSED
    assert "judgeBands" not in OPERATIONAL_KEYS


def test_a_band_reads_per_check() -> None:
    policy = GuardrailPolicy.from_blob(
        {"judgeBands": {"response_safety": {"low": 0.2, "high": 0.8}}}
    )
    assert policy.judge_band("response_safety") == (0.2, 0.8)


@pytest.mark.parametrize(
    "bands",
    [
        None,
        {},
        {"response_safety": {"low": 0.2}},
        {"response_safety": {"low": -0.1, "high": 0.5}},
        {"response_safety": {"low": 0.2, "high": 1.5}},
        {"response_safety": {"low": 0.9, "high": 0.1}},
        {"response_safety": {"low": True, "high": 0.5}},
        {"response_safety": [0.1, 0.5]},
    ],
)
def test_an_absent_or_malformed_band_is_undetermined_never_a_default(bands: Any) -> None:
    blob = {} if bands is None else {"judgeBands": bands}
    with pytest.raises(GuardrailUndeterminedError):
        GuardrailPolicy.from_blob(blob).judge_band("response_safety")


def test_band_route_decides_who_owns_the_verdict() -> None:
    band = (0.2, 0.8)
    assert band_route(0.1, band) == "pass"  # below low: the classifier passes it
    assert band_route(0.2, band) == "judge"  # in band: the judge decides
    assert band_route(0.79, band) == "judge"
    assert band_route(0.8, band) == "classifier"  # at/above high: the classifier verdict stands


# ── policy-keys.json (§11.3 A) ────────────────────────────────────────────────


def test_the_committed_catalogue_matches_specs() -> None:
    committed = json.loads(CONTRACT.read_text())
    generated = policy_key_catalogue()
    assert committed == generated, (
        "policy-keys.json drifted from core/policy.py _SPECS — run "
        "apps/guardrail/scripts/export_policy_keys.py"
    )


def test_every_catalogue_entry_has_the_typescript_shape() -> None:
    catalogue = policy_key_catalogue()
    assert catalogue["schemaVersion"] == 1
    kinds = {"criteria", "hyperparameter", "threshold", "geometry", "operational"}
    types = {"string", "number", "integer", "boolean", "string[]", "object"}
    keys = [entry["key"] for entry in catalogue["keys"]]
    assert keys == list(GuardrailPolicy.DECLARED_KEYS)
    for entry in catalogue["keys"]:
        assert set(entry) == {
            "key",
            "kind",
            "type",
            "min",
            "max",
            "failMode",
            "taskKey",
            "inPolicyVersion",
            "editable",
        }, entry
        assert entry["kind"] in kinds
        assert entry["type"] in types
        assert entry["failMode"] in {"closed", "open-to-default"}
        assert entry["taskKey"].startswith("guardrail.")


def test_catalogue_entries_for_the_judge_keys() -> None:
    by_key = {entry["key"]: entry for entry in policy_key_catalogue()["keys"]}
    # Each criterion lives on the model row ITS lane's routing key elects.
    lane_rows = dict(
        zip(
            CRITERIA_KEYS,
            (
                "guardrail.judge.injection",
                "guardrail.judge.unsafe_content",
                "guardrail.judge.clinical_safety",
                "guardrail.judge.leakage",
            ),
            strict=True,
        )
    )
    for key in CRITERIA_KEYS:
        assert by_key[key]["kind"] == "criteria"
        assert by_key[key]["failMode"] == "closed"
        assert by_key[key]["taskKey"] == lane_rows[key]
        assert by_key[key]["inPolicyVersion"] is True
        assert by_key[key]["editable"] is True
    assert by_key["medicalWindowScopeCriteria"]["taskKey"] == "guardrail.validate"
    assert by_key["judgeBands"]["type"] == "object"
    assert by_key["judgeBands"]["taskKey"] == "guardrail.safety"
    assert (by_key["judgeBands"]["min"], by_key["judgeBands"]["max"]) == (0.0, 1.0)
    # Operational keys never move the policy version; a key on an unhashed row neither.
    assert by_key["windowCacheTtlSeconds"]["inPolicyVersion"] is False
    assert by_key["groundednessEntailmentThreshold"]["inPolicyVersion"] is False


# ── the policy version ────────────────────────────────────────────────────────


class _Resolver:
    def __init__(self, configs: dict[str, Any]) -> None:
        self.configs = configs
        self.asked: list[str] = []

    async def resolve(self, tenant_id: str, task_key: str) -> Any:
        self.asked.append(task_key)
        return self.configs.get(task_key) or SimpleNamespace(model=None, policy=None)


async def test_the_judge_routing_keys_join_the_policy_version() -> None:
    resolver = _Resolver({})
    state = SimpleNamespace(tenant_config_resolver=resolver, settings=None)
    await resolve_policy_version(state, "t1")
    for key in (
        "guardrail.judge.injection",
        "guardrail.judge.unsafe_content",
        "guardrail.judge.clinical_safety",
        "guardrail.judge.leakage",
    ):
        assert key in resolver.asked


def _cfg(**extra: Any) -> SimpleNamespace:
    return SimpleNamespace(provider="lm-studio", model="m", policy={}, **extra)


def test_switching_a_lane_model_or_its_judge_mapping_moves_the_version() -> None:
    policy = GuardrailPolicy.from_blob({})
    base = compute_policy_version(
        selections={"guardrail.judge.injection": _cfg(judge={"protocol": "criteria_json"})},
        screen_policy=policy,
        judge_window_chars=2000,
    )
    remapped = compute_policy_version(
        selections={"guardrail.judge.injection": _cfg(judge={"protocol": "qwen3guard_native"})},
        screen_policy=policy,
        judge_window_chars=2000,
    )
    assert base != remapped
