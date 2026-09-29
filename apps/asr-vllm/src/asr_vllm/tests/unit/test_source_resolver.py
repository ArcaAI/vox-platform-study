"""OD-7 registry-first loading: vLLM is only ever handed a LOCAL DIRECTORY.

`localPath` (the published models bucket) loads in place; otherwise the HF `sourceUri` is
pulled with the MODEL OWNER's registry credential (RESOLVED → token, ABSENT → anonymous)
and the downloaded snapshot directory is what vLLM gets. DENIED / UNAVAILABLE fail closed
and are never retried anonymously.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr

from asr_vllm.core.model_credentials import CredentialOutcome, ModelRegistryCredential
from asr_vllm.models.source_resolver import ModelSourceError, ModelSourceResolver
from asr_vllm.spec import AsrModelSlice, ResolvedVllmAsrSpec
from asr_vllm.tests.conftest import spec_payload

OWNER = "50000000-0000-0000-0000-000000000000"
REPO = "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16"


class FakeCredentials:
    def __init__(self, credential: ModelRegistryCredential) -> None:
        self.credential = credential
        self.calls: list[tuple[str, str]] = []

    async def resolve(self, provider: str, tenant_id: str) -> ModelRegistryCredential:
        self.calls.append((provider, tenant_id))
        return self.credential


class FakeHub:
    """Stands in for `huggingface_hub.snapshot_download`; materialises a snapshot dir."""

    def __init__(self, root: Path, *, fail: Exception | None = None) -> None:
        self.root = root
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    def snapshot_download(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        if self.fail is not None:
            raise self.fail
        snapshot = self.root / "models--taphuynh--whisper" / "snapshots" / "abc123"
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / "config.json").write_text("{}")
        return str(snapshot)


RESOLVED = ModelRegistryCredential(
    outcome=CredentialOutcome.RESOLVED, api_key=SecretStr("hf_owner_token")
)
ABSENT = ModelRegistryCredential(outcome=CredentialOutcome.ABSENT)
DENIED = ModelRegistryCredential(outcome=CredentialOutcome.DENIED, reason="vetoed")
UNAVAILABLE = ModelRegistryCredential.unavailable("gateway down")


def model(**overrides: object) -> AsrModelSlice:
    return ResolvedVllmAsrSpec.model_validate(spec_payload(**overrides)).model


def resolver(
    credential: ModelRegistryCredential, hub: FakeHub, cache: Path | None = None
) -> tuple[ModelSourceResolver, FakeCredentials]:
    credentials = FakeCredentials(credential)
    return (
        ModelSourceResolver(
            credentials,
            cache_dir=str(cache) if cache else None,
            snapshot_download=hub.snapshot_download,
        ),
        credentials,
    )


def publish(directory: Path, weights: bytes = b"weights") -> str:
    """A published checkpoint dir as the gateway's download processor writes it."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "config.json").write_text("{}")
    (directory / "model.safetensors").write_bytes(weights)
    digest = hashlib.sha256(weights).hexdigest()
    (directory / "manifest.json").write_text(
        json.dumps({"primaryObject": "model.safetensors", "objects": []})
    )
    return digest


# ── localPath: published weights, in place ─────────────────────────────────


async def test_an_existing_local_path_loads_in_place_with_no_credential_or_pull(
    tmp_path: Path,
) -> None:
    published = tmp_path / "bucket" / "snapshots" / "sha"
    publish(published)
    hub = FakeHub(tmp_path / "cache")
    subject, credentials = resolver(RESOLVED, hub)

    assert await subject.resolve(model(localPath=str(published))) == published
    assert credentials.calls == [] and hub.calls == []


async def test_a_local_path_that_is_a_file_is_refused(tmp_path: Path) -> None:
    weights = tmp_path / "ggml.bin"
    weights.write_bytes(b"x")
    subject, _ = resolver(RESOLVED, FakeHub(tmp_path))
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=str(weights)))
    assert caught.value.code == "MODEL_SOURCE_NOT_A_DIRECTORY"


# ── HuggingFace: owner's credential, then a LOCAL directory ────────────────


async def test_a_missing_local_path_pulls_with_the_owners_token(tmp_path: Path) -> None:
    hub = FakeHub(tmp_path / "hub")
    subject, credentials = resolver(RESOLVED, hub, cache=tmp_path / "cache")

    path = await subject.resolve(
        model(localPath=str(tmp_path / "gone"), tenantId=OWNER, sourceRevision="abc123")
    )

    assert credentials.calls == [("huggingface", OWNER)]  # the OWNER funds it, never the caller
    (call,) = hub.calls
    assert call == {
        "repo_id": REPO,
        "revision": "abc123",
        "token": "hf_owner_token",
        "cache_dir": str(tmp_path / "cache"),
    }
    assert path == tmp_path / "hub" / "models--taphuynh--whisper" / "snapshots" / "abc123"
    assert path.is_dir()  # a LOCAL directory — the only thing vLLM is ever handed


@pytest.mark.parametrize("uri", [REPO, f"hf:{REPO}", f"hf://{REPO}", f"huggingface://{REPO}"])
async def test_every_hf_spelling_becomes_a_bare_repo_id(tmp_path: Path, uri: str) -> None:
    hub = FakeHub(tmp_path)
    subject, _ = resolver(ABSENT, hub)
    await subject.resolve(model(localPath=None, sourceUri=uri))
    assert hub.calls[0]["repo_id"] == REPO


async def test_absent_pulls_anonymously_and_never_with_an_ambient_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HF_TOKEN", "ambient-token-that-must-not-be-used")
    hub = FakeHub(tmp_path)
    subject, _ = resolver(ABSENT, hub)
    await subject.resolve(model(localPath=None))
    assert hub.calls[0]["token"] is False  # explicit: send no token at all


@pytest.mark.parametrize(
    ("credential", "code"),
    [(DENIED, "MODEL_CREDENTIAL_DENIED"), (UNAVAILABLE, "MODEL_CREDENTIAL_UNAVAILABLE")],
)
async def test_denied_or_unavailable_fails_closed_and_never_pulls(
    tmp_path: Path, credential: ModelRegistryCredential, code: str
) -> None:
    hub = FakeHub(tmp_path)
    subject, _ = resolver(credential, hub)
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=None))
    assert caught.value.code == code
    assert hub.calls == []  # never retried anonymously


async def test_a_failed_pull_is_named(tmp_path: Path) -> None:
    hub = FakeHub(tmp_path, fail=OSError("403 Client Error: gated repo"))
    subject, _ = resolver(RESOLVED, hub)
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=None))
    assert caught.value.code == "MODEL_DOWNLOAD_FAILED"
    assert "hf_owner_token" not in str(caught.value)


@pytest.mark.parametrize(
    "uri", ["s3://hope-models/whisper/", "file:///weights", "azure://speech", "just-a-name"]
)
async def test_a_source_that_is_not_huggingface_is_refused(tmp_path: Path, uri: str) -> None:
    hub = FakeHub(tmp_path)
    subject, credentials = resolver(RESOLVED, hub)
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=None, sourceUri=uri))
    assert caught.value.code == "MODEL_SOURCE_UNSUPPORTED"
    assert credentials.calls == [] and hub.calls == []


# ── checksum: verified where the published manifest names the file ──────────


async def test_a_published_checksum_is_verified_against_the_primary_object(
    tmp_path: Path,
) -> None:
    published = tmp_path / "pub"
    digest = publish(published)
    subject, _ = resolver(RESOLVED, FakeHub(tmp_path))
    assert await subject.resolve(model(localPath=str(published), checksum=digest)) == published
    upper = f"sha256:{digest.upper()}"  # the prefix and case are tolerated
    assert await subject.resolve(model(localPath=str(published), checksum=upper)) == published


async def test_a_checksum_mismatch_refuses_the_weights(tmp_path: Path) -> None:
    published = tmp_path / "pub"
    publish(published)
    subject, _ = resolver(RESOLVED, FakeHub(tmp_path))
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=str(published), checksum="0" * 64))
    assert caught.value.code == "MODEL_CHECKSUM_MISMATCH"


async def test_a_manifest_naming_a_missing_object_refuses_the_weights(tmp_path: Path) -> None:
    published = tmp_path / "pub"
    publish(published)
    (published / "model.safetensors").unlink()
    subject, _ = resolver(RESOLVED, FakeHub(tmp_path))
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=str(published), checksum="0" * 64))
    assert caught.value.code == "MODEL_CHECKSUM_MISMATCH"


async def test_a_manifest_escaping_its_directory_is_refused(tmp_path: Path) -> None:
    published = tmp_path / "pub"
    publish(published)
    (tmp_path / "outside").write_bytes(b"x")
    (published / "manifest.json").write_text(json.dumps({"primaryObject": "../outside"}))
    subject, _ = resolver(RESOLVED, FakeHub(tmp_path))
    with pytest.raises(ModelSourceError) as caught:
        await subject.resolve(model(localPath=str(published), checksum="0" * 64))
    assert caught.value.code == "MODEL_CHECKSUM_MISMATCH"


async def test_without_a_manifest_the_checksum_cannot_be_applied_and_is_skipped(
    tmp_path: Path,
) -> None:
    """An HF snapshot has no manifest naming the file the checksum describes; the Hub's
    own per-file verification is what protects that path (the STT multi-file rule)."""
    hub = FakeHub(tmp_path)
    subject, _ = resolver(RESOLVED, hub)
    path = await subject.resolve(model(localPath=None, checksum="0" * 64))
    assert path.is_dir()


async def test_no_checksum_means_no_verification(tmp_path: Path) -> None:
    published = tmp_path / "pub"
    publish(published)
    (published / "manifest.json").write_text("not json")  # never even read
    subject, _ = resolver(RESOLVED, FakeHub(tmp_path))
    assert await subject.resolve(model(localPath=str(published), checksum=None)) == published
