"""Conformance suite for the stt model source resolver.

This is the CANONICAL copy of the resolver conformance quartet. The same named
cases are mirrored in guardrail / nlp / harness (a mirrored-implementation
discipline) so a behavioural drift in any one service shows up as a named test
failure rather than a production surprise.

The S3 double is a stubbed client injected at the LAZY-IMPORT SEAM
(``_make_s3_client``) — there is no ``moto`` anywhere in the workspace and the
suites stay hermetic (no network, no live MinIO). One integration-lane test
against the real test MinIO lives in ``tests/integration/``.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import pytest
from structlog.testing import capture_logs

from stt.models.source_resolver import (
    ModelSourceConfig,
    ModelSourceError,
    ModelWeightIdentity,
    resolve_model_dir,
)

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
    monkeypatch.setattr("stt.models.source_resolver._make_s3_client", lambda cfg: client)
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

    monkeypatch.setattr("stt.models.source_resolver._make_s3_client", _explode)

    resolved = await resolve_model_dir(identity(local_path=str(staged)), config=config)

    assert resolved == staged


async def test_resolve_for_model_config_honours_local_path_before_credentials(
    tmp_path: Path, monkeypatch
) -> None:
    """TASK-858 — Mode M must not depend on the credential plane.

    `resolve_for_model_config` (the whisper.cpp / parakeet.cpp seam) resolved the
    HuggingFace + S3 credentials EAGERLY, before honouring `local_path`, so a model
    whose weights are read in place (a bucket mount, an admin-staged directory)
    failed to load whenever the gateway could not answer the credential call —
    observed live: the ArcaAI default ASR pipeline 500ed on session create with
    "no usable model-registry credential for 'huggingface'". A local path needs no
    credential; the lookup must not even be attempted.
    """
    from types import SimpleNamespace

    from stt.core.model_credentials import CredentialUnavailable
    from stt.models.source_resolver import resolve_for_model_config

    staged = tmp_path / "staged"
    staged.mkdir()

    async def _refuse(*_args, **_kwargs):
        raise CredentialUnavailable("gateway said 401")

    monkeypatch.setattr("stt.core.model_credentials.resolve_hf_token", _refuse)
    monkeypatch.setattr("stt.core.model_credentials.resolve_s3_credentials", _refuse)

    model_config = SimpleNamespace(
        slug="whisper-large-en-medical-260726-merged-gguf-q8_0",
        source_uri="taphuynh/whisper-large-en-medical-2607.26-merged-gguf",
        source="LOCAL",
        source_revision="main",
        local_path=str(staged),
        checksum=None,
        tenant_id="50000000-0000-0000-0000-000000000001",
    )
    settings = SimpleNamespace(
        huggingface_cache_dir=str(tmp_path / "hf"),
        model_s3_secure=False,
        minio_cert_check=False,
    )

    resolved = await resolve_for_model_config(model_config, settings)

    assert Path(resolved) == staged


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
        e["event"] == "stt.model_source.local_path_missing" for e in warnings
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

    def _snapshot(**kwargs):
        # A cache MISS under HF_HUB_OFFLINE: huggingface_hub raises rather than
        # reaching the network. The resolver no longer pre-empts this call (that
        # would also block a cache HIT), so this stub IS invoked, and the
        # offline-specific message is produced from the miss.
        raise OSError("no local snapshot for this repo (offline)")

    monkeypatch.setattr("stt.models.source_resolver._hf_snapshot_download", _snapshot)

    with pytest.raises(ModelSourceError) as exc:
        await resolve_model_dir(
            identity(source_uri="hf:openai/whisper-large-v3", source="HUGGINGFACE"),
            config=config,
        )

    assert "HF_HUB_OFFLINE" in str(exc.value)


async def test_hf_offline_cached_is_served_from_cache(
    config: ModelSourceConfig, monkeypatch
) -> None:
    """Offline + ALREADY CACHED must resolve, not raise.

    The sibling test above is named `..._offline_uncached_raises_cleanly`, and
    that "uncached" was always the intent: `huggingface_hub` honours
    HF_HUB_OFFLINE by serving the LOCAL CACHE and never touching the network.
    Raising before the call made the resolver's own advice -- "pre-populate the
    hub cache" -- impossible to follow, and broke every AiModel-driven load on a
    pod whose weights are mounted read-only from the model bucket.
    """
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    cached = Path(config.hf_cache_dir) / "models--openai--whisper-large-v3" / "snapshots" / "abc"
    cached.mkdir(parents=True, exist_ok=True)

    def _snapshot(**kwargs):
        return str(cached)

    monkeypatch.setattr("stt.models.source_resolver._hf_snapshot_download", _snapshot)

    resolved = await resolve_model_dir(
        identity(source_uri="hf:openai/whisper-large-v3", source="HUGGINGFACE"),
        config=config,
    )
    assert Path(resolved) == cached


async def test_hf_bare_id_is_accepted(config: ModelSourceConfig, monkeypatch) -> None:
    seen: dict = {}

    def _snapshot(**kwargs):
        seen.update(kwargs)
        return "/hf/snapshot"

    monkeypatch.setattr("stt.models.source_resolver._hf_snapshot_download", _snapshot)

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
