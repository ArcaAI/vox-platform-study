"""lane C — tts's provider config moves to the control plane.

Four properties, in descending order of how badly their absence would hurt:

1. The two BYOK credential guards are INTACT. They are the reference pattern the
   assessment points every other adapter at; weakening one while migrating the
   fields around it is the single worst outcome available here.
2. The service stays STATELESS — a Redis connection added for cache invalidation
   must not become a route to local tenant resolution.
3. The env path is closed structurally for every migrated knob.
4. A served value lands, and an unresolved or mistyped one does not.
"""

from __future__ import annotations

import pytest

from tts.core.config import Settings
from tts.core.control_plane import (
    CONTROL_PLANE_KEYS,
    apply_control_plane,
    bootstrap_defaults,
    moved_alias,
)


def _env_var(path: str) -> str:
    """The variable that USED to set this field, from its dotted path."""
    prefixes = {
        "azure": "TTS_AZURE_",
        "sarvam": "TTS_SARVAM_",
        "kokoro": "TTS_KOKORO_",
        "indic_parler": "TTS_PARLER_",
        "indic_f5": "TTS_INDICF5_",
    }
    if "." in path:
        group, field = path.split(".", 1)
        return f"{prefixes[group]}{field.upper()}"
    return f"TTS_{path.upper()}"


class TestByokGuardsAreIntact:
    """The one thing this ticket must not break.

    `apps/tts`'s cloud credentials have NO env path: the `validation_alias` names
    a variable nobody will ever set, and `populate_by_name` is off so the field
    name cannot populate it either. The assessment calls this "the pattern F-01
    should be fixed *to*" — every other adapter in the monorepo is supposed to
    converge on it, so a regression here would take the reference with it.
    """

    @pytest.mark.parametrize("provider", ["azure", "sarvam"])
    def test_no_env_var_can_supply_a_cloud_key(
        self, provider: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(f"TTS_{provider.upper()}_API_KEY", "leaked-from-env")
        monkeypatch.setenv("API_KEY", "leaked-from-env")

        settings = Settings()

        assert getattr(settings, provider).api_key.get_secret_value() == ""

    @pytest.mark.parametrize("provider", ["azure", "sarvam"])
    def test_the_dead_alias_is_still_declared(self, provider: str) -> None:
        config = getattr(Settings(), provider)
        alias = type(config).model_fields["api_key"].validation_alias
        assert isinstance(alias, str)
        assert alias.endswith("__ENV_REMOVED_TASK_602"), (
            "the structural BYOK guard is the reference pattern for the whole "
            "monorepo — do not replace it with a convention"
        )

    @pytest.mark.parametrize("provider", ["azure", "sarvam"])
    def test_populate_by_name_stays_off(self, provider: str) -> None:
        """The other half: `populate_by_name=True` would re-open every field at once."""
        config = getattr(Settings(), provider)
        assert type(config).model_config.get("populate_by_name") is not True


class TestStatelessPostureIsIntact:
    def test_the_service_holds_no_database_configuration(self) -> None:
        """No DB URL, no pool, no tenant resolver — tts resolves nothing locally.

        Its per-tenant config (credentials, voice bindings, provider chain)
        arrives per request from the gateway. Adding a Redis client for cache
        invalidation must not quietly turn this into a second guardrail-style
        local resolver.
        """
        fields = set(Settings.model_fields)
        assert not {f for f in fields if "database" in f or "tenant" in f}

    def test_redis_is_declared_and_is_bootstrap_transport_only(self) -> None:
        """`redis_url` is env-tier for the same reason `gateway_url` is.

        It is the ADDRESS of a propagation channel, not a value carried on one —
        a process cannot fetch the address of the thing it fetches addresses
        from. It is therefore NOT in the control-plane key table.
        """
        assert "redis_url" in Settings.model_fields
        assert "redis_url" not in CONTROL_PLANE_KEYS


class TestLegacyTokenIsRetired:
    def test_the_per_service_token_field_is_gone(self) -> None:
        """One credential, so there is nothing left to bypass (assessment F-06).

        The legacy field survived as a "zero-cost backward-compatibility
        fallback", but the cost was that two call sites read it DIRECTLY instead
        of through the accessor — so a deployment configured the way owner
        decision D-D specifies sent an empty token and 401'd, silently, forever.
        """
        assert "service_token" not in Settings.model_fields

    def test_the_shared_token_is_accepted_and_presented(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "shared-internal")
        settings = Settings()
        assert settings.accepted_service_tokens == ("shared-internal",)
        assert settings.peer_service_token() == "shared-internal"

    def test_an_unfilled_placeholder_is_never_presented_as_a_credential(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The sentinel is a NON-EMPTY string, so a truthiness chain would send it."""
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "CHANGE_ME")
        settings = Settings()
        assert settings.accepted_service_tokens == ()
        assert settings.peer_service_token() == ""


class TestEnvPathIsStructurallyClosed:
    @pytest.mark.parametrize("path", sorted(CONTROL_PLANE_KEYS))
    def test_the_legacy_env_var_no_longer_sets_the_field(
        self, path: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        before = bootstrap_defaults(Settings())[path]
        monkeypatch.setenv(_env_var(path), "0")

        after = bootstrap_defaults(Settings())[path]

        assert after == before, (
            f"{_env_var(path)} still reaches `{path}` — the knob is DB-owned and "
            "must have no env path at all"
        )

    def test_the_alias_names_the_full_variable(self) -> None:
        """`validation_alias` bypasses `env_prefix`, so it must be spelled in full.

        Deriving it from the field name alone would produce `REGION__MOVED…` for
        several providers at once and tell an operator grepping for
        `TTS_AZURE_REGION` nothing at all.
        """
        alias = type(Settings()).model_fields["max_input_chars"].validation_alias
        assert alias == moved_alias("TTS_MAX_INPUT_CHARS")

    def test_a_value_that_moved_onto_a_ROW_says_so_rather_than_naming_the_control_plane(
        self,
    ) -> None:
        """Two dead-alias suffixes, because they send an operator to two different places.

        TASK-879 moved a second class of value off env — not to the control plane but onto the
        registry model, its provider connection or the agent. An operator grepping for
        `TTS_SARVAM_MODEL` must land on something that says WHERE the value went; pointing them at
        "the control plane" would send them to a settings key that no longer exists.
        """
        from tts.core.control_plane import moved_to_row_alias

        for owner, field, env_var in (
            (Settings().sarvam, "model", "TTS_SARVAM_MODEL"),
            (Settings().sarvam, "base_url", "TTS_SARVAM_BASE_URL"),
            (Settings().azure, "region", "TTS_AZURE_REGION"),
            (Settings().indic_parler, "hf_model", "TTS_PARLER_HF_MODEL"),
            (Settings().indic_f5, "ref_audio_path", "TTS_INDICF5_REF_AUDIO_PATH"),
        ):
            assert type(owner).model_fields[field].validation_alias == moved_to_row_alias(env_var)


class TestProviderEnableFlagsAreGone:
    """The five `*_ENABLED` flags left the service entirely (TASK-879).

    They were the one HALF-migrated family here: served by the control plane AND still readable
    from env, because closing the env path needed the k8s ConfigMaps in
    `arca/hope-v2-deployment` to stop setting `TTS_KOKORO_ENABLED` first — and doing it in the
    wrong order put `hope-tts` back to answering 503 forever with no Service endpoints.

    TASK-879 dissolved the coupling instead of sequencing it. "May this engine serve" is an
    `AiProviderConnection` row's three-state `enabled`, resolved per request into the pushed
    spec's `connection` block, so there is no field, no key, no environment variable and no
    manifest left to coordinate. A stale `TTS_KOKORO_ENABLED` is simply ignored.
    """

    @pytest.mark.parametrize(
        ("group", "env_var"),
        [
            ("azure", "TTS_AZURE_ENABLED"),
            ("sarvam", "TTS_SARVAM_ENABLED"),
            ("kokoro", "TTS_KOKORO_ENABLED"),
            ("indic_parler", "TTS_PARLER_ENABLED"),
            ("indic_f5", "TTS_INDICF5_ENABLED"),
        ],
    )
    def test_the_field_is_gone_and_a_stale_env_var_reaches_nothing(
        self, group: str, env_var: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(env_var, "true")
        assert not hasattr(getattr(Settings(), group), "enabled")

    def test_no_enable_flag_is_left_on_the_control_plane_key_table(self) -> None:
        assert {p for p in CONTROL_PLANE_KEYS if p.endswith(".enabled")} == set()

    def test_nothing_is_half_migrated_any_more(self) -> None:
        """`ENV_BOOTSTRAP_KEYS` is empty, and empty is the finished state.

        The mechanism stays: a future half-migrated key belongs here, and must leave in the SAME
        change that closes its env path. What must not stay is a key whose env path nobody
        remembers to close.
        """
        from tts.core.control_plane import ENV_BOOTSTRAP_KEYS

        assert ENV_BOOTSTRAP_KEYS == frozenset()


class TestVoiceNamesLiveOnlyInTheCatalog:
    @pytest.mark.parametrize(
        ("group", "field"),
        [
            ("azure", "voice_en"),
            ("azure", "voice_ml"),
            ("sarvam", "voice_ml"),
            ("sarvam", "voice_en"),
            ("kokoro", "voice"),
            ("indic_parler", "speaker_ml"),
            ("indic_parler", "speaker_en"),
        ],
    )
    def test_the_duplicated_voice_field_is_gone(self, group: str, field: str) -> None:
        config = getattr(Settings(), group)
        assert field not in type(config).model_fields

    def test_the_catalog_still_carries_every_binding_those_fields_held(self) -> None:
        """Deleting them is only safe because the catalog already had the values."""
        from tts.catalog.voices import VoiceCatalog

        catalog = VoiceCatalog()
        assert catalog.default_binding("azure", "en") == "en-IN-NeerjaNeural"
        assert catalog.default_binding("azure", "ml") == "ml-IN-SobhanaNeural"
        assert catalog.default_binding("kokoro", "en") == "af_heart"
        assert catalog.default_binding("indic_parler", "ml") == "Anjali"
        assert catalog.default_binding("sarvam", "ml") == "ishita"

    def test_an_unbound_provider_locale_yields_none_rather_than_a_guess(self) -> None:
        """Inventing a name here would do the catalog's job without the catalog."""
        from tts.catalog.voices import VoiceCatalog

        assert VoiceCatalog().default_binding("indic_parler", "en") is None


class TestOverlay:
    def _snapshot(self, block: dict[str, object]) -> dict[str, object]:
        return {"service": "tts", "settings": block}

    def test_a_served_value_reaches_a_nested_provider_field(self) -> None:
        settings = Settings()
        apply_control_plane(
            settings,
            self._snapshot(
                {"tts.indicParler.device": {"value": "cuda", "dataType": "string", "source": "db"}}
            ),
        )
        assert settings.indic_parler.device == "cuda"

    def test_a_null_value_keeps_the_bootstrap_value(self) -> None:
        settings = Settings()
        before = settings.indic_parler.device
        applied = apply_control_plane(
            settings,
            self._snapshot(
                {
                    "tts.indicParler.device": {
                        "value": None,
                        "dataType": "string",
                        "source": "env-fallback",
                    }
                }
            ),
        )
        assert settings.indic_parler.device == before
        assert applied == []

    # The specimen has changed twice: `tts.azure.timeoutS` (removed by TASK-872 for having no
    # reader) then `tts.sarvam.timeoutS` (moved onto the connection row by TASK-879). The
    # remaining numeric key is read for real, so the test still pins type discipline on a knob
    # that matters.
    def test_a_type_mismatch_is_refused_not_coerced(self) -> None:
        settings = Settings()
        before = settings.max_input_chars
        apply_control_plane(
            settings,
            self._snapshot(
                {
                    "tts.limits.maxInputChars": {
                        "value": "soon",
                        "dataType": "number",
                        "source": "db",
                    }
                }
            ),
        )
        assert settings.max_input_chars == before

    def test_a_bool_is_never_read_as_a_number(self) -> None:
        settings = Settings()
        before = settings.max_input_chars
        apply_control_plane(
            settings,
            self._snapshot(
                {"tts.limits.maxInputChars": {"value": True, "dataType": "number", "source": "db"}}
            ),
        )
        assert settings.max_input_chars == before

    def test_a_malformed_payload_changes_nothing(self) -> None:
        settings = Settings()
        assert apply_control_plane(settings, {}) == []
        assert apply_control_plane(settings, {"settings": "nope"}) == []
        assert apply_control_plane(settings, None) == []

    def test_a_key_this_service_does_not_declare_is_ignored(self) -> None:
        """An unrecognised key contributes nothing — no attribute is invented.

        The useful specimen is a key that MOVED: `tts.sarvam.model` was served here until
        TASK-879 put it on the registry row the agent binds. A stale control plane still serving
        it must change nothing — otherwise a retired key could quietly override what the spec
        said, which is the two-authorities failure the move exists to end.
        """
        settings = Settings()
        before = settings.sarvam.model
        applied = apply_control_plane(
            settings,
            self._snapshot(
                {"tts.sarvam.model": {"value": "bulbul:v2", "dataType": "string", "source": "db"}}
            ),
        )
        assert applied == []
        assert settings.sarvam.model == before


class TestKeyTable:
    def test_every_path_resolves_on_a_real_settings_object(self) -> None:
        resolved = bootstrap_defaults(Settings())
        missing = sorted(set(CONTROL_PLANE_KEYS) - set(resolved))
        assert missing == [], f"CONTROL_PLANE_KEYS names paths that do not exist: {missing}"

    def test_registry_keys_are_unique_and_tts_scoped(self) -> None:
        keys = list(CONTROL_PLANE_KEYS.values())
        assert len(keys) == len(set(keys))
        assert all(k.startswith("tts.") for k in keys)
