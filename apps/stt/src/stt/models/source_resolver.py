"""Model weight source & path resolution.

One contract, mirrored across stt / guardrail / nlp / harness:

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


def config_from_settings(settings: Any) -> ModelSourceConfig:
    """The CREDENTIAL-FREE part of the resolver config: cache dirs and TLS.

    this used to be the single seam through which
    ``HUGGINGFACE_TOKEN`` and the ``STT_MODEL_S3_*`` pair reached the resolver.
    Both are now rows on ``AiProviderConnection`` (``service='model-registry'``)
    and depend on WHICH MODEL is being fetched, which this function cannot know.
    Use :func:`config_for_model` on any path that may actually pull bytes.

    What is left here is genuinely settings-tier: where the cache lives, and
    whether the object-store endpoint speaks TLS. Neither is a credential and
    neither varies per tenant.
    """
    return ModelSourceConfig(
        cache_dir=settings.huggingface_cache_dir,
        hf_cache_dir=settings.huggingface_cache_dir,
        s3_secure=settings.model_s3_secure,
        # The trust decision is platform-wide (`MINIO_CERT_CHECK`), not a
        # per-model-source knob: one object store, one answer.
        s3_cert_check=settings.minio_cert_check,
    )


async def config_for_model(model_config: Any, settings: Any) -> ModelSourceConfig:
    """Resolver config for ONE model, credentials included.

    The credentials are resolved for the tenant that OWNS the model row, never
    the caller (:func:`stt.core.model_credentials.owner_tenant_of`). A
    SYSTEM-owned model therefore always fetches with the platform's token even
    when a tenant's job triggered the load — which is what stops one tenant
    spending another's HuggingFace quota, and what makes the process-wide weight
    cache safe to share.

    Fails CLOSED (raises ``CredentialUnavailable``) when a tier VETOED the
    provider or the gateway could not answer. ABSENT is not a failure: it means
    no tier has an opinion, and the fetch proceeds anonymously — correct for a
    public repo, and the only remaining meaning of "no credential" now that the
    env paths are closed.
    """
    from stt.core.model_credentials import resolve_hf_token, resolve_s3_credentials

    owner = getattr(model_config, "tenant_id", None)
    base = config_from_settings(settings)

    hf_token = await resolve_hf_token(owner)
    s3 = await resolve_s3_credentials(owner)

    return ModelSourceConfig(
        cache_dir=base.cache_dir,
        hf_cache_dir=base.hf_cache_dir,
        hf_token=hf_token,
        s3_endpoint=s3.base_url,
        s3_access_key=s3.access_key_id,
        s3_secret_key=s3.secret,
        s3_secure=base.s3_secure,
        s3_cert_check=base.s3_cert_check,
    )


def identity_from_model_config(model_config: Any) -> ModelWeightIdentity:
    """Project an `AiModelConfig` onto the resolver's identity subset."""
    return ModelWeightIdentity(
        slug=model_config.slug,
        source_uri=model_config.source_uri,
        source=getattr(model_config, "source", None),
        source_revision=getattr(model_config, "source_revision", None),
        local_path=getattr(model_config, "local_path", None),
        checksum=getattr(model_config, "checksum", None),
    )


async def resolve_for_model_config(
    model_config: Any, settings: Any, *, allow_network: bool = True
) -> Path:
    """Convenience seam used by the loaders: `AiModelConfig` -> weights dir.

    local_path is honoured BEFORE any credential is resolved. This
    seam used to call :func:`config_for_model` eagerly, which asks the gateway for
    the HuggingFace and S3 credentials of the model's owner tenant and FAILS CLOSED
    when it cannot — so a model read in place (Mode M: a bucket mount, an
    admin-staged directory) could not load while the credential plane was down or
    refusing, even though it needed no credential at all. Observed live: the
    ArcaAI default ASR pipeline 500ed on session create with
    "no usable model-registry credential for 'huggingface'".
    ``weights_source_for`` already applied this rule; the two must agree.
    """
    identity = identity_from_model_config(model_config)
    if identity.local_path and Path(identity.local_path).exists():
        return await resolve_model_dir(
            identity, config=config_from_settings(settings), allow_network=False
        )
    return await resolve_model_dir(
        identity,
        config=await config_for_model(model_config, settings),
        allow_network=allow_network,
    )


async def resolve_weights_or_hf_id(model_config: Any, settings: Any) -> str:
    """Materialise local weights when possible, else hand back the bare HF id.

    Several stt loaders wrap runtimes that perform their OWN hub download and
    accept a repo id directly (faster-whisper's ``WhisperModel``, transformers'
    ``from_pretrained``, NeMo's ``from_pretrained``). For those, forcing a
    ``snapshot_download`` would change the incumbent fetch mechanism for every
    existing HuggingFace row. So the resolver materialises only what the runtime
    cannot fetch itself — ``local_path``, ``file://`` and ``s3://`` — and passes
    a hub id through unchanged. Today's HF behaviour is therefore byte-for-byte
    preserved while the new schemes become available.
    """
    identity = identity_from_model_config(model_config)

    if identity.local_path:
        candidate = Path(identity.local_path)
        if candidate.exists():
            return str(candidate)
        logger.warning(
            "stt.model_source.local_path_missing",
            slug=identity.slug,
            path=identity.local_path,
            detail="configured local_path does not exist; falling through to source_uri",
        )

    uri = (identity.source_uri or "").strip()
    if uri.startswith(("s3://", "file://")):
        # Credentials are resolved ONLY on the branch that may actually fetch —
        # `local_path` above already returned, and the `hf:`/bare-id branch below
        # hands the id to a runtime that performs its own download. A cached or
        # pre-staged model therefore never touches the gateway, so a control-plane
        # outage cannot break a load that needed no network.
        resolved = await resolve_model_dir(
            identity, config=await config_for_model(model_config, settings)
        )
        return str(resolved)

    if uri.startswith("hf:"):
        return uri[len("hf:") :]

    return uri


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
    # Settings-tier TLS flag for a BARE `host:port` endpoint. When the credential
    # carries a URL (`http://…` / `https://…`) its scheme decides instead — see
    # `_s3_endpoint_and_tls`.
    s3_secure: bool = True
    # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION (owner ruling 2026-08-30,
    # `MINIO_CERT_CHECK`): defaults to False — the object store's TLS
    # certificate is NOT verified, because the platform has no CA to validate
    # it against and MinIO authenticates with a service-account key pair
    # instead. Grep `MINIO_CERT_CHECK` for every site to revert when a CA lands.
    s3_cert_check: bool = False


# ---------------------------------------------------------------------------
# Lazy-import seams (the hermetic suites stub these)
# ---------------------------------------------------------------------------


def _s3_endpoint_and_tls(endpoint: str, secure: bool) -> tuple[str, bool]:
    """Split the configured S3 endpoint into `host[:port]` plus whether to speak TLS.

    The gateway's model-registry credential contract carries `baseUrl` as a URL:
    the platform-storage fallback answers `http://localhost:9000`, and the console
    refuses to save an explicit row whose endpoint has no http(s) scheme. The
    object-store clients want the opposite shape — minio-py rejects any scheme
    inside its endpoint argument ("path in endpoint is not allowed"), boto3 wants
    the scheme prepended exactly once — so a scheme, when present, is
    authoritative for TLS and is stripped here. A bare `host:port` keeps the
    settings-tier `secure` flag that predates the credential carrying a URL.
    Anything else (an unknown scheme, a path, a query) is refused loudly rather
    than silently mis-addressed: the bucket and prefix come from `source_uri`,
    never from the endpoint.
    """
    raw = (endpoint or "").strip()
    if "://" not in raw:
        return raw, secure
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ModelSourceError(
            f"Unsupported S3 endpoint {raw!r}: expected 'host:port', "
            f"'http://host:port' or 'https://host:port'."
        )
    if parsed.path.strip("/") or parsed.params or parsed.query or parsed.fragment:
        raise ModelSourceError(
            f"S3 endpoint {raw!r} must not carry a path, query or fragment — the "
            f"bucket and prefix come from the model's source_uri."
        )
    return parsed.netloc, parsed.scheme == "https"


def _make_s3_client(config: ModelSourceConfig) -> Any:
    """Build a MinIO-compatible S3 client. Imported lazily and stubbed in tests."""
    if not config.s3_endpoint or not config.s3_access_key or not config.s3_secret_key:
        raise ModelSourceError(
            "Cannot resolve an S3 model source: the endpoint, access key id or "
            "secret key is missing. These are no longer environment variables "
            " — configure the 'model-registry' / 's3' provider "
            "connection for the tenant that OWNS this model, or for the SYSTEM "
            "tenant to serve every model that has no owner of its own."
        )

    try:
        from minio import Minio
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ModelSourceError(
            "s3:// model sources require the 'minio' package to be installed."
        ) from exc

    endpoint, secure = _s3_endpoint_and_tls(config.s3_endpoint, config.s3_secure)
    client_kwargs: dict[str, Any] = {
        "access_key": config.s3_access_key,
        "secret_key": config.s3_secret_key,
        "secure": secure,
    }
    if secure and not config.s3_cert_check:
        # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION — see
        # `ModelSourceConfig.s3_cert_check` (`MINIO_CERT_CHECK`).
        import urllib3

        client_kwargs["http_client"] = urllib3.PoolManager(cert_reqs="CERT_NONE")

    return Minio(endpoint, **client_kwargs)


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
                "stt.model_source.local_path_hit",
                slug=identity.slug,
                path=str(candidate),
            )
            return candidate
        logger.warning(
            "stt.model_source.local_path_missing",
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

    logger.info("stt.model_source.file_hit", slug=identity.slug, path=str(path))
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

    # NO pre-emptive raise on HF_HUB_OFFLINE. `huggingface_hub` honours that
    # variable by serving the LOCAL CACHE and never touching the network, which
    # IS the "pre-populate the hub cache" path the error below recommends —
    # raising before the call made that advice impossible to follow, and turned
    # every AiModel-driven load into a hard failure on a pod whose weights are
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
                f"hub cache ({config.hf_cache_dir}), or set AiModel.localPath / a "
                f"file:// source_uri instead. Underlying error: {exc}"
            ) from exc
        raise ModelSourceError(
            f"Failed to fetch HuggingFace weights {repo_id!r} for model "
            f"'{identity.slug}': {exc}"
        ) from exc

    logger.info("stt.model_source.hf_hit", slug=identity.slug, repo_id=repo_id)
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
            logger.debug("stt.model_source.s3_cache_hit", slug=identity.slug, uri=uri)
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
        "stt.model_source.s3_downloaded",
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
    """Verify a downloaded artifact directory against `AiModel.checksum`.

    Checksums describe SINGLE-FILE artifacts (GGUF, ONNX). A multi-file
    directory snapshot is a documented no-op with a warning — HuggingFace-style
    snapshots rely on the hub's own per-file ETag verification.
    """
    files = [p for p in directory.rglob("*") if p.is_file() and p.name != _VERIFIED_MARKER]

    if len(files) != 1:
        logger.warning(
            "stt.model_source.checksum_skipped_directory",
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
