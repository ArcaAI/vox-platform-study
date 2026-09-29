"""Registry-first weight resolution: every load ends in a LOCAL DIRECTORY (TASK-1010 OD-7).

Owner decision OD-7: every model this service loads is a registered ``AiModel`` row, and
bytes are pulled only with that row's registry credential (``AiProviderConnection``
``model-registry:huggingface``, funded by the row's OWNER). So vLLM is never handed a
repo id — it would pull on its own, with whatever ambient token the process holds. The
contract, in order:

1. ``localPath`` set AND exists → load IN PLACE (the published models bucket; preferred).
   A file rather than a directory is refused: vLLM loads a checkpoint directory.
   Set-but-missing falls THROUGH with a warning (the fleet contract STT codifies — e.g.
   an s3fs mount that lost its files), to:
2. an HF ``sourceUri`` (bare ``org/repo``, ``hf:``, ``hf://``, ``huggingface://``) → the
   owner's credential (``core/model_credentials.py``): RESOLVED → pull with that token;
   ABSENT → pull ANONYMOUSLY (``token=False`` — explicit, so no ambient token can ride
   along); DENIED / UNAVAILABLE → refuse (503), never retried anonymously. The pull is
   ``huggingface_hub.snapshot_download`` into the pod's weights cache; the snapshot
   DIRECTORY it returns is what vLLM gets.
3. anything else (``s3://``, ``file://``, a cloud engine) → refused by name. A published
   row always has a ``localPath``; nothing here needs to reach an object store.

CHECKSUM. ``AiModel.checksum`` is the SHA256 of the publication's PRIMARY weights object
(``AiModelDownloadProcessor``: the first weights file of the published ``manifest.json``).
So it is verifiable exactly where that manifest says which file it describes — a
published directory — and there the primary object is hashed and compared (a mismatch, a
missing object, an unreadable manifest or one pointing outside its directory refuses the
weights). A directory with no manifest (an HF snapshot) cannot say which file the digest
belongs to; it is left unverified with a warning, as STT does for multi-file snapshots —
the Hub's own per-file verification protects that path.

The service stays DB-less: registry enforcement is that a spec is only ever built by the
gateway resolver from registered rows, and only service-token holders can call this.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from hope_obs import get_logger

from hope_vllm.core.model_credentials import (
    CredentialOutcome,
    ModelRegistryCredential,
    ModelRegistryCredentialClient,
    owner_tenant_of,
)
from hope_vllm.engine.base import EngineBuildRefused
from hope_vllm.spec import ResolvedServingSpec

if TYPE_CHECKING:  # pragma: no cover - typing only
    from hope_vllm.core.config import Settings

logger = get_logger(__name__)

#: The HF spellings a registry ``sourceUri`` may carry; vLLM-free code wants the bare id.
_HF_PREFIXES = ("hf://", "huggingface://", "hf:")
_MANIFEST = "manifest.json"

#: The registry provider id of the HuggingFace hub credential.
HF_PROVIDER = "huggingface"


class ModelSourceError(EngineBuildRefused):
    """The weights cannot be materialised; ``code`` names why (503)."""


class CredentialResolver(Protocol):
    async def resolve(self, provider: str, tenant_id: str) -> ModelRegistryCredential: ...


SnapshotDownload = Callable[..., str]


def hf_repo_id(source_uri: str) -> str | None:
    """The bare ``org/repo`` a HuggingFace ``sourceUri`` names, or None if it names none."""
    uri = source_uri.strip()
    for prefix in _HF_PREFIXES:
        if uri.startswith(prefix):
            uri = uri[len(prefix) :]
            break
    if "://" in uri or uri.startswith("/"):
        return None
    parts = uri.split("/")
    return uri if len(parts) == 2 and all(parts) else None


def _hf_snapshot_download(**kwargs: Any) -> str:
    """Lazy ``huggingface_hub.snapshot_download`` seam (the vLLM image ships the hub client)."""
    from huggingface_hub import snapshot_download

    result: str = snapshot_download(**kwargs)
    return result


class ModelSourceResolver:
    def __init__(
        self,
        credentials: CredentialResolver,
        *,
        cache_dir: str | None,
        snapshot_download: SnapshotDownload | None = None,
    ) -> None:
        self._credentials = credentials
        self._cache_dir = cache_dir
        self._snapshot_download = snapshot_download or _hf_snapshot_download

    @classmethod
    def from_settings(cls, settings: Settings) -> ModelSourceResolver:
        """The production wiring. Construction performs no I/O."""
        return cls(
            ModelRegistryCredentialClient(
                base_url=settings.api_gateway_url, token=settings.peer_service_token()
            ),
            cache_dir=settings.weights_cache_dir,
        )

    async def resolve(self, model: ResolvedServingSpec) -> Path:
        """``model`` → the LOCAL directory vLLM loads. Raises :class:`ModelSourceError`."""
        if model.local_path:
            path = Path(model.local_path)
            if path.exists():
                if not path.is_dir():
                    raise ModelSourceError(
                        "MODEL_SOURCE_NOT_A_DIRECTORY",
                        f"model '{model.slug}' localPath {path} is a file; vLLM loads a "
                        "checkpoint directory",
                    )
                await asyncio.to_thread(verify_checksum, path, model)
                logger.info("vllm.model_source.local_path_hit", slug=model.slug)
                return path
            logger.warning(
                "vllm.model_source.local_path_missing",
                slug=model.slug,
                path=str(path),
                detail="configured localPath does not exist; falling through to sourceUri",
            )

        repo_id = hf_repo_id(model.source_uri)
        if repo_id is None:
            raise ModelSourceError(
                "MODEL_SOURCE_UNSUPPORTED",
                f"model '{model.slug}' has no usable localPath and its sourceUri is not a "
                "HuggingFace repo; publish it to the models bucket",
            )

        owner = owner_tenant_of(model.tenant_id)
        credential = await self._credentials.resolve(HF_PROVIDER, owner)
        if credential.outcome is CredentialOutcome.DENIED:
            raise ModelSourceError(
                "MODEL_CREDENTIAL_DENIED",
                f"the model-registry:{HF_PROVIDER} credential for model '{model.slug}' is "
                f"denied for its owner ({credential.reason or 'no reason given'})",
            )
        if not credential.usable:
            raise ModelSourceError(
                "MODEL_CREDENTIAL_UNAVAILABLE",
                f"the model-registry:{HF_PROVIDER} credential for model '{model.slug}' "
                f"could not be resolved ({credential.reason or 'no reason given'}); "
                "not retried anonymously",
            )

        # `False`, not None, for ABSENT: None lets huggingface_hub fall back to an ambient
        # token (HF_TOKEN, a cached login); False sends none at all.
        token: str | bool = credential.secret or False
        try:
            snapshot = await asyncio.to_thread(
                self._snapshot_download,
                repo_id=repo_id,
                revision=model.source_revision or None,
                token=token,
                cache_dir=self._cache_dir,
            )
        except Exception as exc:  # noqa: BLE001 — named, never a silent fallback
            raise ModelSourceError(
                "MODEL_DOWNLOAD_FAILED",
                f"pulling '{repo_id}' for model '{model.slug}' failed: "
                f"{type(exc).__name__}: {exc}",
            ) from exc

        path = Path(snapshot)
        await asyncio.to_thread(verify_checksum, path, model)
        logger.info(
            "vllm.model_source.hf_pulled",
            slug=model.slug,
            repo_id=repo_id,
            anonymous=token is False,
            funding=credential.funding,
        )
        return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checksum(directory: Path, model: ResolvedServingSpec) -> None:
    """Verify ``model.checksum`` where the published manifest says which file it describes."""
    if not model.checksum:
        return

    def mismatch(detail: str) -> ModelSourceError:
        return ModelSourceError(
            "MODEL_CHECKSUM_MISMATCH",
            f"model '{model.slug}' at {directory}: {detail}. The weights will not be served.",
        )

    manifest_path = directory / _MANIFEST
    if not manifest_path.is_file():
        logger.warning(
            "vllm.model_source.checksum_unverifiable",
            slug=model.slug,
            detail="no published manifest names the object the checksum describes",
        )
        return
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        raise mismatch(f"unreadable {_MANIFEST} ({type(exc).__name__})") from exc
    primary = manifest.get("primaryObject") if isinstance(manifest, dict) else None
    if not isinstance(primary, str) or not primary:
        logger.warning(
            "vllm.model_source.checksum_unverifiable",
            slug=model.slug,
            detail=f"{_MANIFEST} names no primaryObject",
        )
        return

    root = directory.resolve()
    target = (directory / primary).resolve()
    if not target.is_relative_to(root):
        raise mismatch(f"{_MANIFEST} primaryObject {primary!r} points outside the directory")
    if not target.is_file():
        raise mismatch(f"primary object {primary!r} is missing")

    expected = model.checksum.strip().lower().removeprefix("sha256:")
    actual = _sha256(target)
    if actual != expected:
        raise mismatch(f"primary object {primary!r} has sha256 {actual}, row declares {expected}")
