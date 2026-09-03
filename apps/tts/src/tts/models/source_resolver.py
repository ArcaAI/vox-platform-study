"""Model weight source & path resolution, tts mirror.

MIRROR of ``apps/stt/src/stt/models/source_resolver.py`` — the conformance
suite in ``apps/tts/src/tts/tests/unit/test_model_source_resolver.py`` is the
same named quartet, so a behavioural drift between the copies fails a named
test.

One contract, mirrored across stt / guardrail / nlp / harness / tts:

    1. ``local_path`` set AND exists    -> return it. The operator/admin override
                                           has the HIGHEST precedence everywhere
                                           (air-gapped hosts, pre-staged NFS
                                           mounts). Set-but-missing falls THROUGH
                                           with a warning — never a hard failure.
    2. ``source_uri`` scheme dispatch:
           hf:<org>/<repo> | bare id  -> ``snapshot_download`` honouring
                                         ``HF_HUB_OFFLINE``
           s3://bucket/prefix         -> download once into the service cache,
                                         single-flight + SHA256-verified
           file:///abs/path           -> verify and use IN PLACE, never copied
    3. anything else                   -> ``ModelSourceError``. There is no
                                          silent fallback (``s3://`` only
                                          for now; ``azure-blob://`` deferred).

Design constraints (rule 06):

* The S3 client is imported LAZILY inside ``_make_s3_client`` so a deployment
  that never uses ``s3://`` never imports ``minio``. That function is also the
  seam the hermetic test suites stub.
* Every blocking call (SDK I/O, hashing) runs under ``asyncio.to_thread``.
* Downloads land in ``<target>.tmp-<pid>-<uuid>`` and are promoted with an
  atomic ``os.replace``, so a crashed or checksum-failed download is invisible
  to readers and leaves only sweepable temp debris.

Where this differs from stt / harness ( scope)
===========================================================
`apps/tts` has no `AiModel`-driven per-request model selection for its
self-hosted local engines (Kokoro / Indic Parler / IndicF5) — `IndicParlerConfig
.model_path` / `.desc_encoder_path` and `IndicF5Config.model_path` are
operator-set LOCAL-MIRROR overrides (`TTS_PARLER_MODEL_PATH` etc.), the Mode-M
equivalent for this service, already supported end to end. `resolve_local_override`
below is the tts-specific integration seam: it materialises an `s3://` value in
one of those fields into a real local directory via `resolve_model_dir`, and
returns anything else (a plain filesystem path — today's only supported value)
UNCHANGED, so the existing local-mirror behaviour is byte-for-byte preserved.
Nothing in stt/harness has an equivalent function; it exists here because tts's
"Mode M" field is a bare string an operator sets, not a resolved `AiModelConfig`.

Credentials ( follow-on)
====================================
A GENERIC gateway route, ``GET /internal/model-registry-credential``, now
backs ``s3://`` credential resolution for every service that is not the STT
worker — see ``tts.core.model_credentials`` for the client and the full
contract. ``config_from_settings`` below stays CREDENTIAL-FREE (cache dir
only); ``config_for_model`` is the credentialed variant
``resolve_local_override`` actually calls. Every resolution funds against
``SYSTEM_TENANT_ID`` — unambiguously correct here, not an approximation: every
tts model-source override is a process-wide operator setting, never a
per-tenant selection (see above), so there is no "owner tenant" to get wrong.
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
    """The columns the resolver needs to materialise one weight source."""

    slug: str
    source_uri: str
    source: str | None = None
    source_revision: str | None = None
    local_path: str | None = None
    checksum: str | None = None


@dataclass(frozen=True)
class ModelSourceConfig:
    """Per-service resolver configuration (cache dir + bootstrap S3 credentials)."""

    cache_dir: str
    hf_cache_dir: str | None = None
    hf_token: str | None = None
    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_secure: bool = True
    # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION (owner ruling 2026-08-30,
    # `MINIO_CERT_CHECK`): defaults to False — the object store's TLS
    # certificate is NOT verified, because the platform has no CA to validate
    # it against and MinIO authenticates with a service-account key pair
    # instead. Grep `MINIO_CERT_CHECK` for every site to revert when a CA lands.
    s3_cert_check: bool = False


def config_from_settings() -> ModelSourceConfig:
    """The CREDENTIAL-FREE part of the resolver config: cache dir only.

    `HF_HOME` is read directly (tts has no settings field for it, unlike
    `apps/nlp`'s `hf_home`) rather than adding a new one. Use
    :func:`config_for_model` on any path that may actually fetch an `s3://`
    source — this function alone never resolves a usable S3 credential.
    """
    hf_home = os.environ.get("HF_HOME", "").strip()
    cache_dir = hf_home or os.path.expanduser("~/.cache/huggingface/hub")
    return ModelSourceConfig(cache_dir=cache_dir, hf_cache_dir=hf_home or None)


async def config_for_model() -> ModelSourceConfig:
    """Resolver config INCLUDING the S3 credential ( follow-on).

    Resolves against `SYSTEM_TENANT_ID` (see the module docstring — every tts
    model-source override is process-wide, so this is not an approximation).
    Fails CLOSED (raises `tts.core.model_credentials.CredentialUnavailable`)
    when a tier VETOED the provider or the gateway could not answer; that
    exception propagates un-caught, same as `_make_s3_client` raising
    `ModelSourceError` for a missing credential — both are "this resolve
    cannot proceed", never a silent fallback.
    """
    from tts.core.model_credentials import resolve_s3_credentials

    base = config_from_settings()
    s3 = await resolve_s3_credentials()

    return ModelSourceConfig(
        cache_dir=base.cache_dir,
        hf_cache_dir=base.hf_cache_dir,
        hf_token=base.hf_token,
        s3_endpoint=s3.base_url,
        s3_access_key=s3.access_key_id,
        s3_secret_key=s3.secret,
        s3_secure=base.s3_secure,
        s3_cert_check=base.s3_cert_check,
    )


async def resolve_local_override(value: str, *, slug: str) -> str:
    """A configured local-mirror override, resolved when it names an `s3://` URI.

    tts-specific (no stt/harness equivalent — see the module docstring):
    `IndicParlerConfig.model_path` / `.desc_encoder_path` and
    `IndicF5Config.model_path` are plain strings an operator sets to either a
    staged local directory (today's only supported shape, returned UNCHANGED)
    or, now, an `s3://bucket/prefix` URI materialised through
    `resolve_model_dir`. An empty value is returned unchanged (the "use the
    hub id instead" case, decided by the caller).
    """
    if not value.startswith("s3://"):
        return value

    resolved = await resolve_model_dir(
        ModelWeightIdentity(slug=slug, source_uri=value),
        config=await config_for_model(),
    )
    return str(resolved)


# ---------------------------------------------------------------------------
# Lazy-import seams (the hermetic suites stub these)
# ---------------------------------------------------------------------------


def _make_s3_client(config: ModelSourceConfig) -> Any:
    """Build a MinIO-compatible S3 client. Imported lazily and stubbed in tests."""
    if not config.s3_endpoint or not config.s3_access_key or not config.s3_secret_key:
        raise ModelSourceError(
            "Cannot resolve an S3 model source: the endpoint, access key id or "
            "secret key is missing. These are not environment variables — "
            "configure the 'model-registry' / 's3' provider connection for the "
            "tenant that OWNS this model, or for the SYSTEM tenant to serve "
            "every model that has no owner of its own."
        )

    try:
        from minio import Minio
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ModelSourceError(
            "s3:// model sources require the 'minio' package to be installed."
        ) from exc

    client_kwargs: dict[str, Any] = {
        "access_key": config.s3_access_key,
        "secret_key": config.s3_secret_key,
        "secure": config.s3_secure,
    }
    if config.s3_secure and not config.s3_cert_check:
        # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION — see
        # `ModelSourceConfig.s3_cert_check` (`MINIO_CERT_CHECK`).
        import urllib3

        client_kwargs["http_client"] = urllib3.PoolManager(cert_reqs="CERT_NONE")

    return Minio(config.s3_endpoint, **client_kwargs)


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
                "tts.model_source.local_path_hit",
                slug=identity.slug,
                path=str(candidate),
            )
            return candidate
        logger.warning(
            "tts.model_source.local_path_missing",
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

    logger.info("tts.model_source.file_hit", slug=identity.slug, path=str(path))
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
            f"Stage the weights locally, or declare a file:// or s3:// source_uri."
        )

    # NO pre-emptive raise on HF_HUB_OFFLINE. `huggingface_hub` honours that
    # variable by serving the LOCAL CACHE and never touching the network, which
    # IS the "pre-populate the hub cache" path the error below recommends —
    # raising before the call made that advice impossible to follow, and turned
    # every hub-sourced load into a hard failure on a pod whose weights are
    # mounted read-only from the model bucket. The offline case is
    # still reported distinctly, but only once a cache MISS has actually
    # happened; `offline` is captured here because the message depends on it.
    offline = os.environ.get("HF_HUB_OFFLINE", "").strip().lower() in {"1", "true", "yes"}

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
        if offline:
            raise ModelSourceError(
                f"HF_HUB_OFFLINE is set and HuggingFace repo {repo_id!r} for model "
                f"'{identity.slug}' is NOT in the local hub cache. Pre-populate the "
                f"hub cache ({config.hf_cache_dir}), or set a local mirror path / a "
                f"file:// source_uri instead. Underlying error: {exc}"
            ) from exc
        raise ModelSourceError(
            f"Failed to fetch HuggingFace weights {repo_id!r} for model "
            f"'{identity.slug}': {exc}"
        ) from exc

    logger.info("tts.model_source.hf_hit", slug=identity.slug, repo_id=repo_id)
    return Path(snapshot)


# ---------------------------------------------------------------------------
# s3://
# ---------------------------------------------------------------------------


async def _resolve_s3(identity: ModelWeightIdentity, uri: str, config: ModelSourceConfig) -> Path:
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
                await asyncio.to_thread(_verify_dir_checksum, target, identity, uri, True)
            logger.debug("tts.model_source.s3_cache_hit", slug=identity.slug, uri=uri)
            return target

        tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
        try:
            await asyncio.to_thread(_download_s3_prefix, config, bucket, prefix, tmp, identity, uri)
            if identity.checksum:
                await asyncio.to_thread(_verify_dir_checksum, tmp, identity, uri, False)
            os.replace(tmp, target)
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise

    logger.info(
        "tts.model_source.s3_downloaded",
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
            f"Failed to download S3 model source {uri!r} for model " f"'{identity.slug}': {exc}"
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


def _verify_checksum_sync(path: Path, identity: ModelWeightIdentity, uri: str) -> None:
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
    """Verify a downloaded artifact directory against a single-file checksum.

    Checksums describe SINGLE-FILE artifacts (GGUF, ONNX). A multi-file
    directory snapshot is a documented no-op with a warning — HuggingFace-style
    snapshots rely on the hub's own per-file ETag verification.
    """
    files = [p for p in directory.rglob("*") if p.is_file() and p.name != _VERIFIED_MARKER]

    if len(files) != 1:
        logger.warning(
            "tts.model_source.checksum_skipped_directory",
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
