"""The backend a blob is READ from must be the one it was WRITTEN to.

The gateway is the other half of this contract and it has no `memory` mode:
`mintCompiledConfigClaimCheckRef`
(`packages/applications/src/services/workflow-exposure/claim-check.ts`) `putFile`s the
compiled config into MinIO and hardcodes `store: 's3'` on the ref it sends. The harness
default is `store = "memory"`, and `build_blob_store` selected the backend from THAT —
so on defaults every gateway-dispatched run dereferenced an s3 blob against the
process-local dict and died with `ClaimCheckNotFound`, naming a bucket/key that existed
the whole time.

`_resolve_ref` in `temporal/activities.py` already states the governing principle:

    The BUCKET comes off the recorded ref, never off current config ... Only the
    store's endpoint/region follow the cascade.

`store` is a locator exactly like `bucket`, and it was the one locator still read from
config. These tests pin it to the ref, and pin an unknown backend name to a loud failure
rather than a silent slide into the in-memory fake.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from harness.core.config import ClaimCheckConfig
from harness.temporal.claim_check import (
    ClaimCheckRef,
    UnknownBlobStore,
    build_blob_store,
    open_store,
)

_BUCKET = "harness-claim-check"


def _config(**overrides) -> ClaimCheckConfig:
    return ClaimCheckConfig(
        enabled=True,
        store=overrides.pop("store", "memory"),
        bucket=_BUCKET,
        endpoint_url="http://localhost:9000",
        access_key="key",
        secret_key="secret",
        **overrides,
    )


def _ref(store: str) -> ClaimCheckRef:
    return ClaimCheckRef(
        store=store, bucket=_BUCKET, key="a" * 64, size=3, sha256="b" * 64, content_type="text/plain"
    )


class TestBackendFollowsTheRef:
    def test_ref_naming_s3_is_read_from_s3_even_when_this_process_defaults_to_memory(self):
        """THE DEFECT: the gateway's ref says s3; harness defaults say memory."""
        store = build_blob_store(_config(store="memory"), store_name="s3")
        assert store.name == "s3"

    def test_ref_naming_memory_is_read_from_memory_even_when_config_says_s3(self):
        """The converse: a worker configured for s3 must still resolve its own dev blobs."""
        store = build_blob_store(_config(store="s3"), store_name="memory")
        assert store.name == "memory"

    def test_store_name_omitted_falls_back_to_config(self):
        """Writes have no ref yet, so they keep selecting the configured backend."""
        assert build_blob_store(_config(store="memory")).name == "memory"
        assert build_blob_store(_config(store="s3")).name == "s3"

    @pytest.mark.asyncio
    async def test_open_store_selects_the_backend_the_ref_names(self):
        store, _ = await open_store(_config(store="memory"), ref=_ref("s3"))
        assert store.name == "s3"

    @pytest.mark.asyncio
    async def test_open_store_without_a_ref_is_unchanged(self):
        store, _ = await open_store(_config(store="memory"))
        assert store.name == "memory"


class TestUnknownBackendFailsLoud:
    def test_unknown_store_on_the_ref_raises(self):
        """A ref naming a backend we do not implement must never slide into the fake."""
        with pytest.raises(UnknownBlobStore, match="gcs"):
            build_blob_store(_config(store="memory"), store_name="gcs")

    def test_config_side_is_already_closed_by_the_field_validator(self):
        """Why the guard above is the REF path's only check.

        `ClaimCheckConfig.store` is enum-validated at construction, so a typo'd
        `HARNESS_CLAIM_CHECK_STORE` can never reach `build_blob_store`. A ref's `store` is
        a plain `str` off the wire and gets no such treatment.
        """
        with pytest.raises(ValidationError, match="store must be one of"):
            _config(store="s33")
