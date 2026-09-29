"""C-4: the platform-only `vllm.*` descriptors overlay onto `Settings`."""

from __future__ import annotations

import json
from typing import Any

import pytest

from hope_vllm.core.config import Settings
from hope_vllm.core.control_plane import (
    CONTROL_PLANE_KEYS,
    MOVED_SUFFIX,
    apply_control_plane,
    moved_alias,
)
from hope_vllm.engine.pool import PoolConfig

#: The key table the gateway descriptors (`vllm.descriptors.ts`, lane L1) declare.
EXPECTED_KEYS = {
    "pools": "vllm.pools",
    "truncation_min_chars_per_voiced_second": "vllm.truncation.minCharsPerVoicedSecond",
    "truncation_voiced_dbfs": "vllm.truncation.voicedDbfs",
}

ASR_POOL = {
    "acceptedKinds": ["asr"],
    "pins": ["arcaai-whisper-large-ml-en-vllm"],
    "vramBudgetGiB": 6,
    "maxResidentEngines": 1,
    "inflightFactor": 2,
}


def served(**values: Any) -> dict[str, Any]:
    """An effective-config body whose generic `settings` map serves ``values`` from the DB."""
    return {
        "service": "vllm",
        "settings": {
            EXPECTED_KEYS[field]: {"value": value, "dataType": "number", "source": "db"}
            for field, value in values.items()
        },
    }


def test_the_key_table_is_exactly_the_platform_knobs() -> None:
    assert CONTROL_PLANE_KEYS == EXPECTED_KEYS


@pytest.mark.parametrize("field", sorted(EXPECTED_KEYS))
def test_every_control_plane_field_exists_and_its_env_path_is_dead(field: str) -> None:
    info = Settings.model_fields[field]
    alias = info.validation_alias
    assert isinstance(alias, str) and alias.endswith(MOVED_SUFFIX)
    assert alias == moved_alias(f"VLLM_{field.upper()}")


def test_served_values_land_on_the_settings() -> None:
    settings = Settings()
    pools = {"default": ASR_POOL, "llm": {**ASR_POOL, "acceptedKinds": ["llm"], "pins": []}}
    applied = apply_control_plane(
        settings,
        served(
            pools=pools,
            truncation_min_chars_per_voiced_second=5,
            truncation_voiced_dbfs=-50.5,
        ),
    )
    assert sorted(applied) == sorted(EXPECTED_KEYS.values())
    assert settings.pool_config() == PoolConfig(
        accepted_kinds=frozenset({"asr"}),
        pins=("arcaai-whisper-large-ml-en-vllm",),
        vram_budget_gib=6.0,
        max_resident=1,
        inflight_factor=2,
    )
    assert settings.truncation_min_chars_per_voiced_second == pytest.approx(5.0)
    assert settings.truncation_voiced_dbfs == pytest.approx(-50.5)


def test_pools_served_as_a_json_string_are_accepted() -> None:
    settings = Settings()
    applied = apply_control_plane(settings, served(pools=json.dumps({"default": ASR_POOL})))
    assert applied == ["vllm.pools"]
    assert settings.pool_config().pins == ("arcaai-whisper-large-ml-en-vllm",)


def test_inflight_factor_is_optional_and_defaults_to_2() -> None:
    settings = Settings()
    pool = {k: v for k, v in ASR_POOL.items() if k != "inflightFactor"}
    assert apply_control_plane(settings, served(pools={"default": pool})) == ["vllm.pools"]
    assert settings.pool_config().inflight_factor == 2


@pytest.mark.parametrize(
    "pool",
    [
        {**ASR_POOL, "acceptedKinds": ["embedding"]},
        {**ASR_POOL, "acceptedKinds": []},
        {**ASR_POOL, "vramBudgetGiB": 0},
        {**ASR_POOL, "vramBudgetGiB": "6"},
        {**ASR_POOL, "maxResidentEngines": 0},
        {**ASR_POOL, "maxResidentEngines": 1.5},
        {**ASR_POOL, "inflightFactor": 0},
        {**ASR_POOL, "pins": "arcaai-whisper"},
        {**ASR_POOL, "pins": [""]},
        {**ASR_POOL, "unknownKey": 1},
        {k: v for k, v in ASR_POOL.items() if k != "vramBudgetGiB"},
    ],
)
def test_a_malformed_pool_refuses_the_whole_map(pool: dict[str, Any]) -> None:
    settings = Settings()
    before = settings.pool_config()
    assert apply_control_plane(settings, served(pools={"default": pool})) == []
    assert settings.pool_config() == before


@pytest.mark.parametrize("pools", [[], "not json", 3, {"default": None}])
def test_a_pools_value_that_is_not_a_map_of_pools_is_refused(pools: Any) -> None:
    settings = Settings()
    assert apply_control_plane(settings, served(pools=pools)) == []


def test_a_map_that_drops_this_process_pool_is_refused() -> None:
    """VLLM_POOL is fixed for the process; the control plane may not delete it underneath."""
    settings = Settings()
    assert apply_control_plane(settings, served(pools={"other": ASR_POOL})) == []
    assert settings.pool_config().vram_budget_gib == 6.0


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("truncation_min_chars_per_voiced_second", -1),
        ("truncation_voiced_dbfs", -91),
        ("truncation_voiced_dbfs", 3),
        ("truncation_voiced_dbfs", True),  # `bool` is an int subclass — never 1
        ("truncation_voiced_dbfs", "-30"),  # a string is not a number
    ],
)
def test_an_out_of_bounds_or_mistyped_value_is_refused(field: str, value: Any) -> None:
    settings = Settings()
    before = getattr(settings, field)
    assert apply_control_plane(settings, served(**{field: value})) == []
    assert getattr(settings, field) == before


def test_an_unresolved_value_keeps_the_bootstrap_value() -> None:
    """`value: null` means the control plane could not answer — never "the default"."""
    settings = Settings()
    payload = {
        "settings": {
            EXPECTED_KEYS["pools"]: {"value": None, "dataType": "json", "source": "env-fallback"}
        }
    }
    assert apply_control_plane(settings, payload) == []
    assert settings.pool_config().vram_budget_gib == 6.0


def test_the_retired_asr_vllm_keys_are_ignored() -> None:
    settings = Settings()
    payload = {"settings": {"asrVllm.engine.maxResidentEngines": {"value": 4}}}
    assert apply_control_plane(settings, payload) == []


@pytest.mark.parametrize(
    "payload",
    [None, [], "nope", {}, {"settings": None}, {"settings": {"unknown.key": {"value": 1}}}],
)
def test_a_malformed_or_foreign_payload_changes_nothing(payload: Any) -> None:
    settings = Settings()
    assert apply_control_plane(settings, payload) == []
    assert settings.truncation_voiced_dbfs == pytest.approx(-40.0)
