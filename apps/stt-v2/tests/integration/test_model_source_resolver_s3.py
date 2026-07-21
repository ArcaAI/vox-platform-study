"""Integration lane: `s3://` resolution against the real test MinIO.

The unit suite (`tests/unit/test_model_source_resolver.py`) stubs the client at the
lazy-import seam and stays hermetic. This file is the one place the resolver is
exercised against a REAL MinIO-compatible server (`tests/docker-compose.test.yml`,
port 9002), so the `minio` SDK call shapes — `list_objects(recursive=True)`,
`fget_object`, prefix stripping — are proven against the actual implementation
rather than a stub that could drift from it.

Never runs in unit CI: `pnpm py:stt-v2:test:integration` / `-m integration` only.
"""

import hashlib
import io

import pytest

from stt_v2.models.source_resolver import (
    ModelSourceConfig,
    ModelSourceError,
    ModelWeightIdentity,
    resolve_model_dir,
)

_BUCKET = "hope-models"


def _config(minio_config: dict, cache_dir) -> ModelSourceConfig:
    return ModelSourceConfig(
        cache_dir=str(cache_dir),
        s3_endpoint=minio_config["endpoint"],
        s3_access_key=minio_config["access_key"],
        s3_secret_key=minio_config["secret_key"],
        s3_secure=minio_config["secure"],
    )


def _put(minio_client, object_name: str, payload: bytes) -> None:
    minio_client.put_object(
        _BUCKET,
        object_name,
        io.BytesIO(payload),
        len(payload),
        content_type="application/octet-stream",
    )


@pytest.mark.integration
class TestS3ResolutionAgainstRealMinIO:
    """Real-server conformance for the `s3://` branch of `resolve_model_dir`."""

    async def test_downloads_prefix_then_serves_from_cache(
        self, minio_client, minio_config, tmp_path
    ):
        """First resolve downloads every object under the prefix; the second is a cache hit.

        The cache hit is proven by REMOVING the objects from MinIO between the two
        resolves — a second call that still succeeds cannot have gone to the server.
        """
        prefix = "task-527/cache-probe"
        _put(minio_client, f"{prefix}/weights.bin", b"weight-bytes")
        _put(minio_client, f"{prefix}/tokenizer.json", b'{"vocab": {}}')

        identity = ModelWeightIdentity(
            slug="probe-model", source_uri=f"s3://{_BUCKET}/{prefix}"
        )
        config = _config(minio_config, tmp_path)

        first = await resolve_model_dir(identity, config=config)

        assert (first / "weights.bin").read_bytes() == b"weight-bytes"
        assert (first / "tokenizer.json").read_bytes() == b'{"vocab": {}}'

        # Remove the source; a cache hit must not need it.
        minio_client.remove_object(_BUCKET, f"{prefix}/weights.bin")
        minio_client.remove_object(_BUCKET, f"{prefix}/tokenizer.json")

        second = await resolve_model_dir(identity, config=config)

        assert second == first
        assert (second / "weights.bin").read_bytes() == b"weight-bytes"

    async def test_checksum_match_verifies_single_file_artifact(
        self, minio_client, minio_config, tmp_path
    ):
        """A single-file artifact with a correct SHA256 resolves and is marked verified."""
        payload = b"gguf-weight-payload"
        prefix = "task-527/checksum-ok"
        _put(minio_client, f"{prefix}/model.gguf", payload)

        identity = ModelWeightIdentity(
            slug="checksum-ok-model",
            source_uri=f"s3://{_BUCKET}/{prefix}",
            checksum=hashlib.sha256(payload).hexdigest(),
        )

        resolved = await resolve_model_dir(identity, config=_config(minio_config, tmp_path))

        assert (resolved / "model.gguf").read_bytes() == payload
        assert (resolved / ".verified").exists(), (
            "a verified cache entry must carry the marker so re-resolves skip re-hashing"
        )

    async def test_checksum_mismatch_is_a_hard_error_and_serves_nothing(
        self, minio_client, minio_config, tmp_path
    ):
        """A substituted weight file must never be served — hard error, no final dir."""
        prefix = "task-527/checksum-bad"
        _put(minio_client, f"{prefix}/model.gguf", b"substituted-payload")

        identity = ModelWeightIdentity(
            slug="poisoned-model",
            source_uri=f"s3://{_BUCKET}/{prefix}",
            checksum=hashlib.sha256(b"the-expected-payload").hexdigest(),
        )
        cache_dir = tmp_path / "cache"

        with pytest.raises(ModelSourceError, match="Checksum mismatch"):
            await resolve_model_dir(identity, config=_config(minio_config, cache_dir))

        # Neither a promoted dir nor temp debris may remain holding the bad bytes.
        promoted = list((cache_dir / "s3").glob("*")) if (cache_dir / "s3").exists() else []
        assert all(".tmp-" in p.name for p in promoted), (
            f"checksum failure must leave no servable cache entry, found: {promoted}"
        )

    async def test_empty_prefix_is_rejected(self, minio_client, minio_config, tmp_path):
        """A prefix with no objects is an error, not a silently-empty weights dir."""
        identity = ModelWeightIdentity(
            slug="absent-model",
            source_uri=f"s3://{_BUCKET}/task-527/does-not-exist-{id(self)}",
        )

        with pytest.raises(ModelSourceError, match="contains no objects"):
            await resolve_model_dir(identity, config=_config(minio_config, tmp_path))
