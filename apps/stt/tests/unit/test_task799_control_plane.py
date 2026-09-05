"""lane C — stt's tuning knobs live in the control plane, not in env.

Three properties, each of which was false before this ticket:

1. **The env path is STRUCTURALLY closed.** A migrated knob is not merely
   "documented as DB-owned" — no environment variable can supply it at all.
   The mechanism is the one `apps/tts/src/tts/core/config.py` already uses for
   its cloud credentials (a `validation_alias` naming a var nobody sets, with
   `populate_by_name` off), generalised from credentials to tuning knobs.
2. **The bootstrap default is preserved verbatim**, so a service that starts
   with an empty control plane behaves exactly as it did before.
3. **A served value reaches the running service**, and an unresolved / wrongly
   typed one leaves the bootstrap value alone rather than substituting anything.
"""

from __future__ import annotations

import pytest

from stt.core.config.settings import Settings
from stt.core.control_plane import (
    CONTROL_PLANE_KEYS,
    apply_control_plane,
    bootstrap_defaults,
)


def _bare_env_name(field_name: str) -> str:
    """The env var that USED to set this field (no env_prefix on `Settings`)."""
    return field_name.upper()


class TestKeyTableIsWellFormed:
    def test_every_mapped_field_exists_on_settings(self) -> None:
        unknown = sorted(f for f in CONTROL_PLANE_KEYS if f not in Settings.model_fields)
        assert unknown == [], f"CONTROL_PLANE_KEYS names fields that do not exist: {unknown}"

    def test_registry_keys_are_unique_and_stt_scoped(self) -> None:
        keys = list(CONTROL_PLANE_KEYS.values())
        assert len(keys) == len(set(keys)), "duplicate registry key in CONTROL_PLANE_KEYS"
        assert all(k.startswith("stt.") for k in keys), "every stt knob is `stt.<group>.<knob>`"

    def test_bootstrap_defaults_are_the_declared_field_defaults(self) -> None:
        for field_name, value in bootstrap_defaults().items():
            assert value == Settings.model_fields[field_name].default


class TestEnvPathIsStructurallyClosed:
    """The property that makes the field count actually go down."""

    @pytest.mark.parametrize("field_name", sorted(CONTROL_PLANE_KEYS))
    def test_the_legacy_env_var_no_longer_sets_the_field(
        self, field_name: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        default = Settings.model_fields[field_name].default
        # A value that parses as every migrated field's type but is never equal
        # to a real default: `0` is a valid int/float/str/bool-ish token.
        monkeypatch.setenv(_bare_env_name(field_name), "0")
        monkeypatch.setenv(f"STT_{_bare_env_name(field_name)}", "0")

        settings = Settings(_env_file=None)

        assert getattr(settings, field_name) == default, (
            f"{_bare_env_name(field_name)} still reaches `Settings.{field_name}` — "
            "the knob is DB-owned and must have no env path at all"
        )

    def test_populate_by_name_stays_off(self) -> None:
        """The other half of the closure: the field NAME must not re-open env."""
        assert Settings.model_config.get("populate_by_name") is not True


class TestOverlay:
    def _snapshot(self, settings_block: dict[str, object]) -> dict[str, object]:
        return {"service": "stt", "settings": settings_block}

    # Specimens changed in TASK-872, TASK-880 and again in TASK-887. They ran first on
    # `vad_threshold` / `vad_min_speech_duration_ms` (removed in TASK-872 — the live
    # path takes its VAD parameters from `ResolvedAsrSpec`), then on
    # `vad_speech_pad_ms` and `vad_model_path` (removed in TASK-880 — the padding is
    # an agent knob and the weights are the `AiModel` row), then on
    # `segment_merge_gap_threshold_s` (removed in TASK-887 — it is the agent's
    # `audioFrontEnd.diarization.matchThreshold`). The overlay MECHANICS are what these
    # tests are for, so they are re-specimened onto knobs the control plane really does
    # serve: `segment_merge_gap_threshold_s` (float), `punctuation_max_length` (int) and
    # `punctuation_model_cache_dir` (`str | None`).
    def test_a_served_value_is_applied(self) -> None:
        settings = Settings(_env_file=None)
        key = CONTROL_PLANE_KEYS["segment_merge_gap_threshold_s"]
        applied = apply_control_plane(
            settings, self._snapshot({key: {"value": 0.77, "dataType": "number", "source": "db"}})
        )
        assert settings.segment_merge_gap_threshold_s == 0.77
        assert "segment_merge_gap_threshold_s" in applied

    def test_a_null_value_keeps_the_bootstrap_value(self) -> None:
        settings = Settings(_env_file=None)
        before = settings.segment_merge_gap_threshold_s
        key = CONTROL_PLANE_KEYS["segment_merge_gap_threshold_s"]
        applied = apply_control_plane(
            settings,
            self._snapshot({key: {"value": None, "dataType": "number", "source": "env-fallback"}}),
        )
        assert settings.segment_merge_gap_threshold_s == before
        assert applied == []

    def test_a_type_mismatch_is_refused_not_coerced(self) -> None:
        settings = Settings(_env_file=None)
        before = settings.segment_merge_gap_threshold_s
        key = CONTROL_PLANE_KEYS["segment_merge_gap_threshold_s"]
        apply_control_plane(
            settings,
            self._snapshot({key: {"value": "loud", "dataType": "number", "source": "db"}}),
        )
        assert settings.segment_merge_gap_threshold_s == before

    def test_a_bool_is_never_read_as_a_number(self) -> None:
        """`bool` is an `int` subclass — the trap `_positive_int` already guards."""
        settings = Settings(_env_file=None)
        before = settings.punctuation_max_length
        key = CONTROL_PLANE_KEYS["punctuation_max_length"]
        apply_control_plane(
            settings, self._snapshot({key: {"value": True, "dataType": "number", "source": "db"}})
        )
        assert settings.punctuation_max_length == before

    def test_an_empty_string_leaves_a_nullable_field_unset(self) -> None:
        """`''` is how a nullable string key spells "no opinion" on the wire.

        The registry has no null literal for a `string` descriptor, so the remaining
        `str | None` fields carry `default: ''`. Adopting that as a real value
        would turn `None` — which every consumer reads as "unset, resolve it
        yourself" — into an empty path or an empty region, and the resulting
        `os.makedirs("")` failure looks nothing like a config problem.
        """
        settings = Settings(_env_file=None)
        assert settings.punctuation_model_cache_dir is None

        applied = apply_control_plane(
            settings,
            self._snapshot(
                {
                    CONTROL_PLANE_KEYS["punctuation_model_cache_dir"]: {
                        "value": "",
                        "dataType": "string",
                        "source": "env-fallback",
                    }
                }
            ),
        )
        assert applied == []
        assert settings.punctuation_model_cache_dir is None

    def test_a_real_value_still_reaches_a_nullable_field(self) -> None:
        settings = Settings(_env_file=None)
        apply_control_plane(
            settings,
            self._snapshot(
                {
                    CONTROL_PLANE_KEYS["punctuation_model_cache_dir"]: {
                        "value": "/var/cache/punctuation",
                        "dataType": "string",
                        "source": "db",
                    }
                }
            ),
        )
        assert settings.punctuation_model_cache_dir == "/var/cache/punctuation"

    def test_an_empty_or_malformed_snapshot_changes_nothing(self) -> None:
        settings = Settings(_env_file=None)
        before = settings.model_dump()
        assert apply_control_plane(settings, {}) == []
        assert apply_control_plane(settings, {"settings": "not-a-dict"}) == []
        assert settings.model_dump() == before

    def test_an_unknown_key_in_the_payload_is_ignored(self) -> None:
        settings = Settings(_env_file=None)
        assert (
            apply_control_plane(
                settings,
                self._snapshot(
                    {"stt.notAKnob": {"value": 1, "dataType": "number", "source": "db"}}
                ),
            )
            == []
        )
