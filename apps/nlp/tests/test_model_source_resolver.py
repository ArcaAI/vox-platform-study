"""Conformance suite for the nlp model source resolver (TASK-855 L6).

This mirrors the same named quartet of cases in
`apps/stt/tests/unit/test_model_source_resolver.py` (mirrored-implementation
discipline: a behavioural drift in any one service's copy shows up as a named
test failure rather than a production surprise).

The S3 double is a stubbed client injected at the LAZY-IMPORT SEAM
(``_make_s3_client``) — there is no ``moto`` anywhere in the workspace and the
suite stays hermetic (no network, no live MinIO).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pytest
from structlog.testing import capture_logs

from nlp.models.source_resolver import (
    ModelSourceConfig,
    ModelSourceError,
    ModelWeightIdentity,
    resolve_model_dir,
)

pytestmark = pytest.mark.asyncio

# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


class StubS3Object:
    def __init__(self, object_name: str) -> None:
        self.object_name = object_name


class StubS3Client:
    """Minimal stand-in for the ``minio.Minio`` surface the resolver uses."""

    def __init__(self, files: dict[str, bytes] | None = None) -> None:
        # object key (below the prefix) -> bytes
        self.files = files if files is not None else {"model.gguf": b"weights"}
        self.download_calls = 0
        self.fail_on_download = False

    def list_objects(self, bucket: str, prefix: str = "", recursive: bool = True):
        for key in self.files:
            yield StubS3Object(f"{prefix.rstrip('/')}/{key}" if prefix else key)

    def fget_object(self, bucket: str, object_name: str, file_path: str) -> None:
        self.download_calls += 1
        if self.fail_on_download:
            raise RuntimeError("simulated network failure mid-download")
        key = object_name.split("/")[-1]
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "wb") as fh:
            fh.write(self.files[key])


@pytest.fixture
def config(tmp_path: Path) -> ModelSourceConfig:
    return ModelSourceConfig(
        cache_dir=str(tmp_path / "cache"),
        hf_cache_dir=str(tmp_path / "hf"),
        hf_token=None,
        s3_endpoint="minio.local:9000",
        s3_access_key="key",
        s3_secret_key="secret",
    )


def identity(**kwargs) -> ModelWeightIdentity:
    base = {
        "slug": "minicheck-flan-t5-large",
        "source_uri": "s3://models/minicheck",
        "source": "S3",
        "source_revision": None,
        "local_path": None,
        "checksum": None,
    }
    base.update(kwargs)
    return ModelWeightIdentity(**base)


@pytest.fixture
def stub_s3(monkeypatch) -> StubS3Client:
    client = StubS3Client()
    monkeypatch.setattr("nlp.models.source_resolver._make_s3_client", lambda cfg: client)
    return client


# ---------------------------------------------------------------------------
# 1-2. localPath precedence
# ---------------------------------------------------------------------------


async def test_local_path_wins_without_network(
    tmp_path: Path, config: ModelSourceConfig, monkeypatch
) -> None:
    """`local_path` is the operator override: highest precedence, no client built."""
    staged = tmp_path / "staged"
    staged.mkdir()

    def _explode(cfg):  # pragma: no cover - must never run
        raise AssertionError("resolver constructed an S3 client despite local_path")

    monkeypatch.setattr("nlp.models.source_resolver._make_s3_client", _explode)

    resolved = await resolve_model_dir(identity(local_path=str(staged)), config=config)

    assert resolved == staged


async def test_local_path_missing_falls_through_with_warning(
    tmp_path: Path, config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    """A set-but-missing override falls THROUGH (never a hard failure)."""
    missing = tmp_path / "not-there"

    with capture_logs() as events:
        resolved = await resolve_model_dir(identity(local_path=str(missing)), config=config)

    assert resolved != missing
    assert stub_s3.download_calls == 1
    warnings = [e for e in events if e["log_level"] == "warning"]
    assert any(
        e["event"] == "nlp.model_source.local_path_missing" for e in warnings
    ), f"expected the dotted local_path_missing warning, got {events}"


# ---------------------------------------------------------------------------
# 3-5. s3:// download semantics
# ---------------------------------------------------------------------------


async def test_s3_downloads_once_then_cache_hits(
    config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    first = await resolve_model_dir(identity(), config=config)
    assert stub_s3.download_calls == 1
    assert (first / "model.gguf").exists()

    second = await resolve_model_dir(identity(), config=config)
    assert second == first
    assert stub_s3.download_calls == 1, "cache hit must not re-download"


async def test_s3_single_flight_concurrent_resolves_download_once(
    config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    results = await asyncio.gather(
        resolve_model_dir(identity(), config=config),
        resolve_model_dir(identity(), config=config),
    )

    assert results[0] == results[1]
    assert stub_s3.download_calls == 1, "single-flight lock must collapse the race"


async def test_s3_checksum_mismatch_hard_error(
    config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    """Poisoned bucket / weight substitution: hard error, model never served."""
    wrong = "0" * 64

    with pytest.raises(ModelSourceError) as exc:
        await resolve_model_dir(identity(checksum=wrong), config=config)

    assert "checksum" in str(exc.value).lower()

    cache_root = Path(config.cache_dir) / "s3"
    final_dirs = [d for d in cache_root.glob("*") if not d.name.endswith(".tmp")]
    assert final_dirs == [], "a checksum-failed download must leave no final dir"


async def test_s3_checksum_match_is_accepted(
    config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    good = hashlib.sha256(b"weights").hexdigest()

    resolved = await resolve_model_dir(identity(checksum=good), config=config)

    assert (resolved / "model.gguf").exists()


async def test_partial_download_leaves_no_final_dir(
    config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    """Crash mid-download leaves only temp debris; the next resolve retries clean."""
    stub_s3.fail_on_download = True

    with pytest.raises(ModelSourceError):
        await resolve_model_dir(identity(), config=config)

    cache_root = Path(config.cache_dir) / "s3"
    final_dirs = [d for d in cache_root.glob("*") if ".tmp-" not in d.name]
    assert final_dirs == []

    # A subsequent healthy resolve succeeds — no poisoned half-state blocks it.
    stub_s3.fail_on_download = False
    resolved = await resolve_model_dir(identity(), config=config)
    assert (resolved / "model.gguf").exists()


# ---------------------------------------------------------------------------
# 6. file:// scheme
# ---------------------------------------------------------------------------


async def test_file_scheme_verify_and_use(tmp_path: Path, config: ModelSourceConfig) -> None:
    staged = tmp_path / "onprem"
    staged.mkdir()
    (staged / "model.gguf").write_bytes(b"weights")

    resolved = await resolve_model_dir(identity(source_uri=f"file://{staged}"), config=config)

    assert resolved == staged, "file:// is used in place, never copied"


async def test_file_scheme_missing_path_raises(config: ModelSourceConfig) -> None:
    with pytest.raises(ModelSourceError):
        await resolve_model_dir(identity(source_uri="file:///definitely/not/here"), config=config)


# ---------------------------------------------------------------------------
# 7. HuggingFace offline
# ---------------------------------------------------------------------------


async def test_hf_offline_uncached_raises_cleanly(config: ModelSourceConfig, monkeypatch) -> None:
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")

    def _snapshot(**kwargs):  # pragma: no cover - offline guard fires first
        raise AssertionError("resolver attempted a hub call while offline")

    monkeypatch.setattr("nlp.models.source_resolver._hf_snapshot_download", _snapshot)

    with pytest.raises(ModelSourceError) as exc:
        await resolve_model_dir(
            identity(source_uri="hf:openai/whisper-large-v3", source="HUGGINGFACE"),
            config=config,
        )

    assert "HF_HUB_OFFLINE" in str(exc.value)


async def test_hf_bare_id_is_accepted(config: ModelSourceConfig, monkeypatch) -> None:
    seen: dict = {}

    def _snapshot(**kwargs):
        seen.update(kwargs)
        return "/hf/snapshot"

    monkeypatch.setattr("nlp.models.source_resolver._hf_snapshot_download", _snapshot)

    resolved = await resolve_model_dir(
        identity(source_uri="openai/whisper-large-v3", source="HUGGINGFACE"),
        config=config,
    )

    assert resolved == Path("/hf/snapshot")
    assert seen["repo_id"] == "openai/whisper-large-v3"


async def test_hf_blocked_when_network_disallowed(config: ModelSourceConfig) -> None:
    """`allow_network=False` (clinical gate posture) refuses hub pulls."""
    with pytest.raises(ModelSourceError) as exc:
        await resolve_model_dir(
            identity(source_uri="hf:some/repo", source="HUGGINGFACE"),
            config=config,
            allow_network=False,
        )

    assert "network" in str(exc.value).lower()


async def test_s3_allowed_when_network_disallowed(
    config: ModelSourceConfig, stub_s3: StubS3Client
) -> None:
    """s3:// is in-deployment + checksum-verified, so the clinical gate permits it."""
    resolved = await resolve_model_dir(identity(), config=config, allow_network=False)

    assert (resolved / "model.gguf").exists()


# ---------------------------------------------------------------------------
# 8. Unknown scheme
# ---------------------------------------------------------------------------


async def test_unknown_scheme_rejected(config: ModelSourceConfig) -> None:
    with pytest.raises(ModelSourceError) as exc:
        await resolve_model_dir(identity(source_uri="azure-blob://container/prefix"), config=config)

    message = str(exc.value)
    assert "azure-blob" in message
    assert "OD-4" in message, "the error must name the owner decision, not fall back"


async def test_empty_source_uri_rejected(config: ModelSourceConfig) -> None:
    with pytest.raises(ModelSourceError):
        await resolve_model_dir(identity(source_uri=""), config=config)


async def test_s3_without_credentials_errors_cleanly(
    tmp_path: Path,
) -> None:
    """Unset S3 bootstrap credentials must error, never silently fall back."""
    bare = ModelSourceConfig(
        cache_dir=str(tmp_path / "cache"),
        hf_cache_dir=str(tmp_path / "hf"),
        hf_token=None,
    )

    with pytest.raises(ModelSourceError) as exc:
        await resolve_model_dir(identity(), config=bare)

    assert "S3" in str(exc.value)


# ---------------------------------------------------------------------------
# 9. `config_for_model` — the credentialed config builder (TASK-855 L6 follow-on)
# ---------------------------------------------------------------------------


async def test_config_for_model_populates_s3_credentials(monkeypatch) -> None:
    """`config_for_model` is the seam that turns a resolved credential into the
    `ModelSourceConfig` shape `_make_s3_client` reads. Credential-fetch
    plumbing itself has its own suite: `test_model_credentials.py`."""
    from nlp.core.model_credentials import ModelRegistryCredential

    async def _fake_resolve_s3_credentials(_tenant_id):
        return ModelRegistryCredential.from_payload(
            {
                "outcome": "resolved",
                "apiKey": "secret",
                "baseUrl": "minio:9000",
                "extras": {"accessKeyId": "hope-models"},
            }
        )

    monkeypatch.setattr(
        "nlp.core.model_credentials.resolve_s3_credentials", _fake_resolve_s3_credentials
    )

    from nlp.core.config import NLPServiceConfig
    from nlp.models.source_resolver import config_for_model

    resolved_config = await config_for_model(NLPServiceConfig())

    assert resolved_config.s3_endpoint == "minio:9000"
    assert resolved_config.s3_access_key == "hope-models"
    assert resolved_config.s3_secret_key == "secret"


async def test_config_for_model_propagates_credential_unavailable(monkeypatch) -> None:
    from nlp.core.model_credentials import CredentialUnavailable

    async def _boom(_tenant_id):
        raise CredentialUnavailable("s3 credential denied")

    monkeypatch.setattr("nlp.core.model_credentials.resolve_s3_credentials", _boom)

    from nlp.core.config import NLPServiceConfig
    from nlp.models.source_resolver import config_for_model

    with pytest.raises(CredentialUnavailable):
        await config_for_model(NLPServiceConfig())
