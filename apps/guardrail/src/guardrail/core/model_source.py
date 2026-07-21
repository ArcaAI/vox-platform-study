"""Model weight source & path resolution, guardrail mirror.

MIRROR of ``apps/stt-v2/src/stt_v2/models/source_resolver.py`` — the conformance
suite in ``tests/test_model_source_resolver.py`` is the same named quartet, so a
behavioural drift between the copies fails a named test.

One contract, mirrored across stt-v2 / guardrail / nlp / harness:

    1. ``local_path`` set AND exists    -> return it. The operator/admin override
                                           has the HIGHEST precedence everywhere
                                           (air-gapped hosts, pre-staged NFS
                                           mounts). Set-but-missing falls THROUGH
                                           with a warning — never a hard failure,
                                           matching the incumbent whisper.cpp
                                           loader behaviour this contract codifies.
    2. ``source_uri`` scheme dispatch:
           hf:<org>/<repo> | bare id  -> ``snapshot_download`` honouring
                                         ``HF_HUB_OFFLINE``
           s3://bucket/prefix         -> download once into the service cache,
                                         single-flight + SHA256-verified
           file:///abs/path           -> verify and use IN PLACE, never copied
    3. anything else                   -> ``ModelSourceError``. There is no
                                          silent fallback: ``s3://`` is the only
                                          cloud scheme supported; ``azure-blob://``
                                          is deferred.

Design constraints (rule 06):

* The S3 client is imported LAZILY inside ``_make_s3_client`` so a deployment
  that never uses ``s3://`` never imports ``minio``. That function is also the
  seam the hermetic test suites stub.
* Every blocking call (SDK I/O, hashing) runs under ``asyncio.to_thread``.
* Downloads land in ``<target>.tmp-<pid>-<uuid>`` and are promoted with an
  atomic ``os.replace``, so a crashed or checksum-failed download is invisible
  to readers and leaves only sweepable temp debris.
* ``allow_network=False`` (the guardrail clinical gate) blocks HuggingFace hub
  pulls while still permitting ``s3://`` (in-deployment MinIO, checksum-verified,
  admin-declared), ``file://`` and ``local_path``.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import structlog

logger = structlog.get_logger(__name__)

# Marker written into a verified cache entry so a re-resolve does not re-hash
# multi-gigabyte weights on every load.
_VERIFIED_MARKER = ".verified"

# Per-URI single-flight locks. Two coroutines resolving the same URI collapse
# onto one download; cross-process safety comes from temp-dir + atomic replace.
_locks: dict[str, asyncio.Lock] = {}


class ModelSourceError(Exception):
    """Raised when model weights cannot be resolved. Never a silent fallback."""


@dataclass(frozen=True)
class ModelWeightIdentity:
    """The `AiModel` columns the resolver needs — a strict subset of `AiModelConfig`."""

    slug: str
    source_uri: str
    source: str | None = None
    source_revision: str | None = None
    local_path: str | None = None
    checksum: str | None = None


@dataclass(frozen=True)
class ModelSourceConfig:
    """Per-service resolver configuration (cache dirs + bootstrap S3 credentials)."""

    cache_dir: str
    hf_cache_dir: str | None = None
    hf_token: str | None = None
    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_secure: bool = True


# ---------------------------------------------------------------------------
# Lazy-import seams (the hermetic suites stub these)
# ---------------------------------------------------------------------------


def _make_s3_client(config: ModelSourceConfig) -> Any:
    """Build a MinIO-compatible S3 client. Imported lazily and stubbed in tests."""
    if not config.s3_endpoint or not config.s3_access_key or not config.s3_secret_key:
        raise ModelSourceError(
            "Cannot resolve an S3 model source: S3 endpoint/access key/secret key "
            "are not configured for this service. Set the *_MODEL_S3_ENDPOINT / "
            "_ACCESS_KEY / _SECRET_KEY environment variables."
        )

    try:
        from minio import Minio
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ModelSourceError(
            "s3:// model sources require the 'minio' package to be installed."
        ) from exc

    return Minio(
        config.s3_endpoint,
        access_key=config.s3_access_key,
        secret_key=config.s3_secret_key,
        secure=config.s3_secure,
    )


def _hf_snapshot_download(**kwargs: Any) -> str:
    """Lazy `huggingface_hub.snapshot_download` seam."""
    from huggingface_hub import snapshot_download

    result: str = snapshot_download(**kwargs)
    return result


# ---------------------------------------------------------------------------
# Public contract
# ---------------------------------------------------------------------------


async def resolve_model_dir(
    identity: ModelWeightIdentity,
    *,
    config: ModelSourceConfig,
    allow_network: bool = True,
) -> Path:
    """Resolve `identity` to a local directory (or file path) holding the weights."""
    # 1. Operator override — highest precedence, no client construction.
    if identity.local_path:
        candidate = Path(identity.local_path)
        if candidate.exists():
            logger.debug(
                "guardrail.model_source.local_path_hit",
                slug=identity.slug,
                path=str(candidate),
            )
            return candidate
        logger.warning(
            "guardrail.model_source.local_path_missing",
            slug=identity.slug,
            path=str(candidate),
            detail="configured local_path does not exist; falling through to source_uri",
        )

    uri = (identity.source_uri or "").strip()
    if not uri:
        raise ModelSourceError(
            f"Model '{identity.slug}' has neither a usable local_path nor a source_uri."
        )

    if uri.startswith("s3://"):
        return await _resolve_s3(identity, uri, config)

    if uri.startswith("file://"):
        return _resolve_file(identity, uri)

    if uri.startswith("hf:") or _looks_like_hf_id(uri):
        return await _resolve_hf(identity, uri, config, allow_network=allow_network)

    scheme = urlparse(uri).scheme or "<none>"
    raise ModelSourceError(
        f"Unsupported model source scheme '{scheme}' for model '{identity.slug}' "
        f"(source_uri={uri!r}). Supported: 'hf:<org>/<repo>' or a bare HuggingFace "
        f"id, 'file:///abs/path', 's3://bucket/prefix'. Owner decision OD-4 scopes "
        f"this program to s3:// only — azure-blob:// and other cloud schemes are "
        f"deliberately not supported."
    )


def _looks_like_hf_id(uri: str) -> bool:
    """A bare HuggingFace id: `<org>/<repo>`, no scheme, no absolute path."""
    if "://" in uri or uri.startswith("/"):
        return False
    return uri.count("/") == 1 and all(part for part in uri.split("/"))


# ---------------------------------------------------------------------------
# file://
# ---------------------------------------------------------------------------


def _resolve_file(identity: ModelWeightIdentity, uri: str) -> Path:
    path = Path(uri[len("file://") :])
    if not path.exists():
        raise ModelSourceError(
            f"Model '{identity.slug}' declares {uri!r} but that path does not exist "
            f"on this host."
        )

    if identity.checksum:
        _verify_checksum_sync(path, identity, uri)

    logger.info("guardrail.model_source.file_hit", slug=identity.slug, path=str(path))
    return path


# ---------------------------------------------------------------------------
# HuggingFace
# ---------------------------------------------------------------------------


async def _resolve_hf(
    identity: ModelWeightIdentity,
    uri: str,
    config: ModelSourceConfig,
    *,
    allow_network: bool,
) -> Path:
    repo_id = uri[len("hf:") :] if uri.startswith("hf:") else uri

    if not allow_network:
        raise ModelSourceError(
            f"Model '{identity.slug}' resolves to HuggingFace repo {repo_id!r}, but "
            f"network model pulls are disabled at this call site (allow_network=False). "
            f"Stage the weights and set AiModel.localPath, or declare a file:// or "
            f"s3:// source_uri."
        )

    offline = os.environ.get("HF_HUB_OFFLINE", "").strip().lower() in {"1", "true", "yes"}
    if offline:
        raise ModelSourceError(
            f"HF_HUB_OFFLINE is set, so HuggingFace repo {repo_id!r} for model "
            f"'{identity.slug}' cannot be fetched. Pre-populate the hub cache "
            f"({config.hf_cache_dir}), or set AiModel.localPath / a file:// "
            f"source_uri instead."
        )

    try:
        snapshot = await asyncio.to_thread(
            _hf_snapshot_download,
            repo_id=repo_id,
            revision=identity.source_revision or None,
            cache_dir=config.hf_cache_dir,
            token=config.hf_token,
        )
    except ModelSourceError:
        raise
    except Exception as exc:
        raise ModelSourceError(
            f"Failed to fetch HuggingFace weights {repo_id!r} for model "
            f"'{identity.slug}': {exc}"
        ) from exc

    logger.info("guardrail.model_source.hf_hit", slug=identity.slug, repo_id=repo_id)
    return Path(snapshot)


# ---------------------------------------------------------------------------
# s3://
# ---------------------------------------------------------------------------


async def _resolve_s3(
    identity: ModelWeightIdentity, uri: str, config: ModelSourceConfig
) -> Path:
    parsed = urlparse(uri)
    bucket = parsed.netloc
    prefix = parsed.path.lstrip("/")
    if not bucket:
        raise ModelSourceError(
            f"Malformed S3 source_uri {uri!r} for model '{identity.slug}': "
            f"expected s3://bucket/prefix."
        )

    target = Path(config.cache_dir) / "s3" / hashlib.sha1(uri.encode()).hexdigest()

    lock = _locks.setdefault(uri, asyncio.Lock())
    async with lock:
        if target.exists():
            if identity.checksum and not (target / _VERIFIED_MARKER).exists():
                # A pre-existing cache entry is verified on FIRST use — a
                # poisoned cache must not be trusted just because it is warm.
                await asyncio.to_thread(
                    _verify_dir_checksum, target, identity, uri, True
                )
            logger.debug(
                "guardrail.model_source.s3_cache_hit", slug=identity.slug, uri=uri
            )
            return target

        tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
        try:
            await asyncio.to_thread(
                _download_s3_prefix, config, bucket, prefix, tmp, identity, uri
            )
            if identity.checksum:
                await asyncio.to_thread(
                    _verify_dir_checksum, tmp, identity, uri, False
                )
            os.replace(tmp, target)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise

    logger.info(
        "guardrail.model_source.s3_downloaded",
        slug=identity.slug,
        uri=uri,
        path=str(target),
    )
    return target


def _download_s3_prefix(
    config: ModelSourceConfig,
    bucket: str,
    prefix: str,
    tmp: Path,
    identity: ModelWeightIdentity,
    uri: str,
) -> None:
    client = _make_s3_client(config)
    tmp.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    try:
        for obj in client.list_objects(bucket, prefix=prefix, recursive=True):
            name = obj.object_name
            relative = name[len(prefix) :].lstrip("/") if prefix else name
            if not relative:
                continue
            client.fget_object(bucket, name, str(tmp / relative))
            downloaded += 1
    except ModelSourceError:
        raise
    except Exception as exc:
        raise ModelSourceError(
            f"Failed to download S3 model source {uri!r} for model "
            f"'{identity.slug}': {exc}"
        ) from exc

    if downloaded == 0:
        raise ModelSourceError(
            f"S3 source {uri!r} for model '{identity.slug}' contains no objects."
        )


# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_checksum_sync(
    path: Path, identity: ModelWeightIdentity, uri: str
) -> None:
    """Verify a single-file artifact. Mismatch is a HARD error."""
    actual = _sha256(path)
    if actual.lower() != (identity.checksum or "").lower():
        raise ModelSourceError(
            f"Checksum mismatch for model '{identity.slug}' ({uri}): expected "
            f"{identity.checksum}, got {actual}. The model will not be served."
        )


def _verify_dir_checksum(
    directory: Path,
    identity: ModelWeightIdentity,
    uri: str,
    is_cache_entry: bool,
) -> None:
    """Verify a downloaded artifact directory against `AiModel.checksum`.

    Checksums describe SINGLE-FILE artifacts (GGUF, ONNX). A multi-file
    directory snapshot is a documented no-op with a warning — HuggingFace-style
    snapshots rely on the hub's own per-file ETag verification.
    """
    files = [p for p in directory.rglob("*") if p.is_file() and p.name != _VERIFIED_MARKER]

    if len(files) != 1:
        logger.warning(
            "guardrail.model_source.checksum_skipped_directory",
            slug=identity.slug,
            uri=uri,
            file_count=len(files),
            detail="checksum is defined for single-file artifacts; directory left unverified",
        )
        return

    try:
        _verify_checksum_sync(files[0], identity, uri)
    except ModelSourceError:
        # A poisoned cache entry must not survive the failure.
        if is_cache_entry:
            shutil.rmtree(directory, ignore_errors=True)
        raise

    (directory / _VERIFIED_MARKER).write_text(identity.checksum or "")


# ---------------------------------------------------------------------------
# Clinical-gate weight resolution
# ---------------------------------------------------------------------------

# The `AiModel` slug the groundedness gate consumes (seed: nlp.ts).
GROUNDEDNESS_MODEL_SLUG = "minicheck-flan-t5-large"
TASK_KEY_GROUNDEDNESS = "guardrail.groundedness"


async def resolve_groundedness_model_path(
    tenant_config: Any,
    *,
    env_path: str | None,
    tenant_id: str | None,
    config: ModelSourceConfig,
) -> str | None:
    """Resolve the MiniCheck GGUF path DB-first, env second.

    Precedence: `AiModel.localPath` (via the 60 s-TTL tenant-config cache) ->
    resolvable `file://` / `s3://` `sourceUri` -> the bootstrap env path.

    Clinical-gate posture: this call site passes
    ``allow_network=False``, so a HuggingFace-only row NEVER triggers a
    download. It degrades to the env path, and if that is unset too the caller's
    ``load_minicheck_scorer`` raises ``NliModelUnavailableError`` and the
    verifier reports ``unverified`` — fail-closed, exactly as before.

    Every failure mode here degrades to ``env_path``: weight resolution is an
    ENHANCEMENT over the staged-file posture and must never cost us a scorer we
    would otherwise have loaded.
    """
    try:
        identity = await tenant_config.resolve_model_source(
            tenant_id, TASK_KEY_GROUNDEDNESS
        )
    except Exception as exc:  # noqa: BLE001 — never lose the staged env weights
        logger.warning(
            "guardrail.model_source.registry_unavailable",
            slug=GROUNDEDNESS_MODEL_SLUG,
            error=str(exc),
            detail="falling back to the bootstrap env path",
        )
        return env_path

    if identity is None:
        return env_path

    try:
        resolved = await resolve_model_dir(
            identity, config=config, allow_network=False
        )
        return str(resolved)
    except ModelSourceError as exc:
        logger.warning(
            "guardrail.model_source.unresolved",
            slug=identity.slug,
            source_uri=identity.source_uri,
            error=str(exc),
            detail="falling back to the bootstrap env path (clinical gate never auto-downloads)",
        )
        return env_path
