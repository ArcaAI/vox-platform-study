"""Activity-level tests for interpreter.load_config (Task 5, S-2).

Same monkeypatching pattern as test_activities_claim_check.py: get_settings/open_store
are monkeypatched on the interpreter.activities module so the real activity body runs against
an InMemoryBlobStore, no network / live MinIO. (`open_store` replaced the bare
`build_blob_store` seam in A.2 — it resolves the platform storage location first.)
"""

from __future__ import annotations

import hashlib
import json

import pytest

from harness.core.config import ClaimCheckConfig, Settings
from harness.temporal.claim_check import (
    ClaimCheckRef,
    InMemoryBlobStore,
    resolve_claim_check_location,
    store_blob,
)
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.compiled_config import (
    CompiledWorkflowConfig,
    canonical_json,
)

_BUCKET = "harness-claim-check"


def _settings() -> Settings:
    return Settings(claim_check=ClaimCheckConfig(enabled=True, store="memory", min_bytes=1))


def _fake_open_store(store: InMemoryBlobStore):
    """Stand in for `open_store` — the fake store at the bootstrap location."""

    async def _open(cc: ClaimCheckConfig, ref: ClaimCheckRef | None = None):
        # `ref` mirrors the real signature (the backend follows the ref it is
        # about to read); this fake serves the one in-memory store either way.
        return store, resolve_claim_check_location(None, cc)

    return _open


def _valid_document() -> str:
    body = {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "smoke-test",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "summarization",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [],
        "gates": [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": 3600, "maxNodeSeconds": 900, "maxAttempts": 5},
    }
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return json.dumps({**body, "checksum": checksum})


class TestLoadConfigRoundTrip:
    @pytest.mark.asyncio
    async def test_store_ref_load_round_trips_to_identical_config(self, monkeypatch):
        store = InMemoryBlobStore()
        monkeypatch.setattr(interpreter_activities, "get_settings", lambda: _settings())
        monkeypatch.setattr(interpreter_activities, "open_store", _fake_open_store(store))

        doc = _valid_document()
        ref = await store_blob(doc, store=store, bucket=_BUCKET)

        config = await interpreter_activities.load_config(ref)
        assert isinstance(config, CompiledWorkflowConfig)
        assert config.slug == "smoke-test"

    @pytest.mark.asyncio
    async def test_corrupted_blob_raises_integrity_error(self, monkeypatch):
        from harness.temporal.claim_check import ClaimCheckIntegrityError

        store = InMemoryBlobStore()
        monkeypatch.setattr(interpreter_activities, "get_settings", lambda: _settings())
        monkeypatch.setattr(interpreter_activities, "open_store", _fake_open_store(store))

        doc = _valid_document()
        ref = await store_blob(doc, store=store, bucket=_BUCKET)
        # Corrupt the stored bytes AFTER the ref was minted (size/sha now mismatch).
        store._data[(_BUCKET, ref.key)] = b"corrupted"

        with pytest.raises(ClaimCheckIntegrityError):
            await interpreter_activities.load_config(ref)
