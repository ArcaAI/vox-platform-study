"""lane A.2 — the claim-check storage LOCATION comes from the cascade.

WHAT CHANGED AND WHY. The claim-check store IS platform object storage: the same
self-hosted MinIO/S3 backend `TenantStorageConfig` already describes. Before this,
harness described it a SECOND time in a parallel `HARNESS_CLAIM_CHECK_*` env block,
so an operator who moved the platform's object store had to remember to move harness
too — and nothing would tell them if they forgot. D-2 forbids a second home for a
concept that already has one.

The blocker was real and is now gone: these are `db-config` keys, and
`EffectiveSettingsService` served only `pipeline.*` / `models.*` / `global-kv`, so
declaring `consumedBy: ['harness']` would have served `null` on every pull (A.1).

WHAT DELIBERATELY DID NOT CHANGE:

* **Env remains the BOOTSTRAP FLOOR, not a rival home.** A degraded control plane
  leaves the store byte-identical to today, which is what makes this safe to land
  without a seeded SYSTEM row. Rule 09: env is the bootstrap floor; the admin surface
  is the cascade.
* **The credential stays in Vault.** `access_key`/`secret_key` are `SecretStr` fed
  from the Vault-agent `secrets_dir`; they never travel this route and no key here is
  `sensitivity: 'secret'`.
* **The `store=memory`-outside-dev guard is untouched** — it is a deployment guard on
  a different axis (dev fake vs real backend), not a location.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.core.config import ClaimCheckConfig
from harness.core.effective_config import EffectiveConfigSnapshot
from harness.temporal.claim_check import (
    STORAGE_CONTAINER_PREFIX_KEY,
    STORAGE_ENDPOINT_KEY,
    STORAGE_REGION_KEY,
    ClaimCheckLocation,
    resolve_claim_check_location,
)


def _snapshot(**values: Any) -> EffectiveConfigSnapshot:
    return EffectiveConfigSnapshot(
        raw={"settings": {key: {"value": value} for key, value in values.items()}},
        ok=True,
    )


def _bootstrap() -> ClaimCheckConfig:
    return ClaimCheckConfig(
        bucket="harness-claim-check",
        endpoint_url="http://localhost:9000",
        region="us-east-1",
        secure=False,
    )


class TestTheCascadeWins:
    def test_the_endpoint_and_region_come_from_the_platform_row(self) -> None:
        location = resolve_claim_check_location(
            _snapshot(
                **{
                    STORAGE_ENDPOINT_KEY: "https://minio.internal:9000",
                    STORAGE_REGION_KEY: "ap-south-1",
                }
            ),
            _bootstrap(),
        )
        assert location.endpoint_url == "https://minio.internal:9000"
        assert location.region == "ap-south-1"

    def test_secure_is_DERIVED_from_the_served_endpoint_scheme(self) -> None:
        """A URL is authoritative about its own scheme.

        Keeping a separate `secure` knob next to a full endpoint URL is how a store
        ends up told to speak plaintext to an `https://` host — two settings that can
        disagree about one fact. When the control plane supplies the URL, the URL wins.
        """
        served = resolve_claim_check_location(
            _snapshot(**{STORAGE_ENDPOINT_KEY: "https://minio.internal:9000"}), _bootstrap()
        )
        assert served.secure is True

        plain = resolve_claim_check_location(
            _snapshot(**{STORAGE_ENDPOINT_KEY: "http://minio.internal:9000"}), _bootstrap()
        )
        assert plain.secure is False

    def test_the_container_prefix_namespaces_the_bucket(self) -> None:
        """The cascade owns PLACEMENT; harness owns the logical bucket NAME.

        There is no `storage.platformDefault.bucket` key and there must not be one —
        the platform default describes a backend, not one service's bucket. The prefix
        is the declared mechanism ("namespace prefix applied to physical bucket names"),
        so an operator namespaces every bucket in one place.
        """
        location = resolve_claim_check_location(
            _snapshot(**{STORAGE_CONTAINER_PREFIX_KEY: "hope-"}), _bootstrap()
        )
        assert location.bucket == "hope-harness-claim-check"


class TestEnvIsTheBootstrapFloor:
    def test_no_snapshot_leaves_the_store_exactly_as_configured(self) -> None:
        base = _bootstrap()
        assert resolve_claim_check_location(None, base) == ClaimCheckLocation(
            bucket=base.bucket,
            endpoint_url=base.endpoint_url,
            region=base.region,
            secure=base.secure,
        )

    def test_a_failed_pull_leaves_the_store_exactly_as_configured(self) -> None:
        base = _bootstrap()
        location = resolve_claim_check_location(EffectiveConfigSnapshot(ok=False), base)
        assert location.endpoint_url == base.endpoint_url
        assert location.region == base.region
        assert location.bucket == base.bucket

    def test_an_unresolved_key_falls_through_per_FIELD_not_all_or_nothing(self) -> None:
        """A partially-configured control plane must not drag the rest back to env."""
        location = resolve_claim_check_location(
            _snapshot(**{STORAGE_REGION_KEY: "eu-west-1", STORAGE_ENDPOINT_KEY: None}),
            _bootstrap(),
        )
        assert location.region == "eu-west-1"
        assert location.endpoint_url == "http://localhost:9000"

    @pytest.mark.parametrize("bad", [None, "", "   ", 9000, True, [], {}])
    def test_a_missing_or_wrongly_typed_value_is_REFUSED_not_coerced(self, bad: Any) -> None:
        base = _bootstrap()
        location = resolve_claim_check_location(
            _snapshot(**{STORAGE_ENDPOINT_KEY: bad, STORAGE_REGION_KEY: bad}), base
        )
        assert location.endpoint_url == base.endpoint_url
        assert location.region == base.region
        assert location.secure == base.secure


class TestTheGuardsAreUntouched:
    def test_the_credential_never_travels_this_route(self) -> None:
        """`ClaimCheckLocation` carries LOCATION only — no key material."""
        fields = set(ClaimCheckLocation.__dataclass_fields__)
        assert fields == {"bucket", "endpoint_url", "region", "secure"}

    def test_the_store_selector_is_still_env_owned(self) -> None:
        """`store` picks the dev fake vs the real backend — a deployment axis, not a
        location. It stays put, and so does the validator that refuses `memory`
        outside development."""
        assert "store" in ClaimCheckConfig.model_fields
        assert ClaimCheckConfig().store == "memory"
