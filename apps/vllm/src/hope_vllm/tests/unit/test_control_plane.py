"""OD-6: the six platform-only `asrVllm.*` descriptors overlay onto `Settings`."""

from __future__ import annotations

from typing import Any

import pytest

from hope_vllm.core.config import Settings
from hope_vllm.core.control_plane import (
    CONTROL_PLANE_KEYS,
    MOVED_SUFFIX,
    apply_control_plane,
    moved_alias,
)

#: The key table the gateway descriptors (`vllm.descriptors.ts`, lane L1) declare.
EXPECTED_KEYS = {
    "gpu_memory_utilization": "asrVllm.engine.gpuMemoryUtilization",
    "max_num_seqs": "asrVllm.engine.maxNumSeqs",
    "enforce_eager": "asrVllm.engine.enforceEager",
    "max_resident_engines": "asrVllm.engine.maxResidentEngines",
    "truncation_min_chars_per_voiced_second": "asrVllm.truncation.minCharsPerVoicedSecond",
    "truncation_voiced_dbfs": "asrVllm.truncation.voicedDbfs",
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


def test_the_key_table_is_exactly_the_six_platform_knobs() -> None:
    assert CONTROL_PLANE_KEYS == EXPECTED_KEYS


@pytest.mark.parametrize("field", sorted(EXPECTED_KEYS))
def test_every_migrated_field_exists_and_its_env_path_is_dead(field: str) -> None:
    info = Settings.model_fields[field]
    alias = info.validation_alias
    assert isinstance(alias, str) and alias.endswith(MOVED_SUFFIX)
    assert alias == moved_alias(f"VLLM_{field.upper()}")


def test_served_values_land_on_the_settings() -> None:
    settings = Settings()
    applied = apply_control_plane(
        settings,
        served(
            gpu_memory_utilization=0.35,
            max_num_seqs=128,
            enforce_eager=True,
            max_resident_engines=2,
            truncation_min_chars_per_voiced_second=5,
            truncation_voiced_dbfs=-50.5,
        ),
    )
    assert sorted(applied) == sorted(EXPECTED_KEYS.values())
    assert settings.gpu_memory_utilization == pytest.approx(0.35)
    assert settings.max_num_seqs == 128
    assert settings.enforce_eager is True
    assert settings.max_resident_engines == 2
    assert settings.truncation_min_chars_per_voiced_second == pytest.approx(5.0)
    assert settings.truncation_voiced_dbfs == pytest.approx(-50.5)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("gpu_memory_utilization", 0.01),  # below the descriptor floor 0.05
        ("gpu_memory_utilization", 0.99),  # above the ceiling 0.95
        ("max_num_seqs", 0),
        ("max_num_seqs", 2048),
        ("max_num_seqs", 12.5),  # an int knob refuses a fraction
        ("max_resident_engines", 5),
        ("truncation_min_chars_per_voiced_second", -1),
        ("truncation_voiced_dbfs", -91),
        ("truncation_voiced_dbfs", 3),
        ("enforce_eager", 1),  # a bool knob refuses a number
        ("max_num_seqs", True),  # `bool` is an int subclass — never 1
        ("gpu_memory_utilization", "0.3"),  # a string is not a number
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
            EXPECTED_KEYS["max_num_seqs"]: {
                "value": None,
                "dataType": "number",
                "source": "env-fallback",
            }
        }
    }
    assert apply_control_plane(settings, payload) == []
    assert settings.max_num_seqs == 64


def test_a_budget_the_gpu_cannot_hold_is_refused_as_a_pair() -> None:
    """Each resident engine claims `gpuMemoryUtilization` of the WHOLE card."""
    settings = Settings()
    applied = apply_control_plane(
        settings, served(gpu_memory_utilization=0.6, max_resident_engines=2)
    )
    assert "asrVllm.engine.gpuMemoryUtilization" not in applied
    assert "asrVllm.engine.maxResidentEngines" not in applied
    assert settings.gpu_memory_utilization == pytest.approx(0.20)
    assert settings.max_resident_engines == 1


def test_a_budget_change_is_judged_against_the_value_already_in_force() -> None:
    settings = Settings()
    apply_control_plane(settings, served(max_resident_engines=4))  # 4 × 0.20 fits
    assert settings.max_resident_engines == 4
    assert apply_control_plane(settings, served(gpu_memory_utilization=0.5)) == []
    assert settings.gpu_memory_utilization == pytest.approx(0.20)


@pytest.mark.parametrize(
    "payload",
    [None, [], "nope", {}, {"settings": None}, {"settings": {"unknown.key": {"value": 1}}}],
)
def test_a_malformed_or_foreign_payload_changes_nothing(payload: Any) -> None:
    settings = Settings()
    assert apply_control_plane(settings, payload) == []
    assert settings.max_num_seqs == 64
