"""lane A.3 — `STORAGE_PROVIDER` becomes a control-plane selection.

WHY THIS IS NOT AN `stt.*` KNOB. Every other migrated field in `CONTROL_PLANE_KEYS`
is stt's own tuning and lives under `stt.<group>.<knob>` in
`stt-runtime.descriptors.ts`. The object-store backend is not stt's: it is the
PLATFORM's, described by the SYSTEM `TenantStorageConfig` row and read by apps/api
through the same cascade. Minting an `stt.storage.provider` twin of it would be the
second-home failure D-2 exists to prevent, so this table points at the existing
`storage.platformDefault.provider` key instead — which is `tier: 'db-config'`, and
resolvable on the pull route only because lane A.1 opened that tier.

The env path closes for the same reason it closed for the other seventy: a variable
an operator can set and the next config pull silently overwrites is worse than no
variable at all.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from stt.core.config.settings import Settings
from stt.core.control_plane import (
    CONTROL_PLANE_KEYS,
    PLATFORM_CASCADE_KEYS,
    apply_control_plane,
    moved_alias,
)

_REPO_ROOT = Path(__file__).resolve().parents[4]
_STORAGE_DESCRIPTORS = (
    _REPO_ROOT
    / "packages/applications/src/services/settings-registry/descriptors/storage.descriptors.ts"
)


def _payload(key: str, value: Any) -> dict[str, Any]:
    return {"settings": {key: {"value": value, "dataType": "enum", "source": "db"}}}


class TestTheTableIsWellFormed:
    def test_it_names_a_real_settings_field(self) -> None:
        unknown = sorted(f for f in PLATFORM_CASCADE_KEYS if f not in Settings.model_fields)
        assert unknown == [], f"PLATFORM_CASCADE_KEYS names fields that do not exist: {unknown}"

    def test_it_holds_only_platform_scoped_keys_never_stt_scoped_ones(self) -> None:
        """The split from `CONTROL_PLANE_KEYS` is the point: that table's invariant is
        "every key is `stt.*` and lives in stt-runtime.descriptors.ts", and these keys
        satisfy neither. Merging them would have forced that invariant to be weakened."""
        assert all(not k.startswith("stt.") for k in PLATFORM_CASCADE_KEYS.values())
        assert set(PLATFORM_CASCADE_KEYS) & set(CONTROL_PLANE_KEYS) == set()

    def test_the_descriptor_exists_and_serves_stt(self) -> None:
        source = _STORAGE_DESCRIPTORS.read_text(encoding="utf-8")
        for key in PLATFORM_CASCADE_KEYS.values():
            assert f"'{key}'" in source, f"{key} has no descriptor"
        # A closed env path with no `consumedBy` is a knob nobody can ever set.
        block = re.search(r"key: 'storage\.platformDefault\.provider',.*?\n  \},", source, re.S)
        assert block is not None
        assert "consumedBy" in block.group(0) and "'stt'" in block.group(0)


class TestEnvPathIsStructurallyClosed:
    def test_STORAGE_PROVIDER_no_longer_sets_the_field(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("STORAGE_PROVIDER", "azure_blob")
        assert Settings().storage_provider == "minio"

    def test_the_alias_names_a_variable_nobody_will_set(self) -> None:
        field = Settings.model_fields["storage_provider"]
        assert field.validation_alias == moved_alias("storage_provider")


class TestAServedValueLands:
    def test_the_platform_provider_reaches_the_field(self) -> None:
        settings = Settings()
        applied = apply_control_plane(
            settings, _payload("storage.platformDefault.provider", "azure_blob")
        )
        assert applied == ["storage_provider"]
        assert settings.storage_provider == "azure_blob"

    def test_an_unresolved_value_keeps_the_bootstrap_default(self) -> None:
        settings = Settings()
        assert (
            apply_control_plane(settings, _payload("storage.platformDefault.provider", None)) == []
        )
        assert settings.storage_provider == "minio"

    @pytest.mark.parametrize("bad", ["gcs", "MINIO", "", "s3", 1, True])
    def test_a_value_OUTSIDE_the_declared_literal_is_refused(self, bad: Any) -> None:
        """The gateway validates `dataType`, not the VOCABULARY.

        `storage.platformDefault.provider` is a `db-config` enum whose stored value is
        an admin-editable string, so "is it a string" is not enough: writing `"gcs"`
        into a `Literal["minio","aws_s3","azure_blob"]` field would leave stt silently
        on the MinIO branch (`!= "azure_blob"`) with a field value no code path expects.
        A refused value keeps the bootstrap one and says so in the log.
        """
        settings = Settings()
        assert (
            apply_control_plane(settings, _payload("storage.platformDefault.provider", bad)) == []
        )
        assert settings.storage_provider == "minio"
