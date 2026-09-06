"""Can this serving process load these weights WITHOUT fetching anything?

TASK-890 J1 MAJOR-A. The gateway measured a self-hosted model's usability from
``AiModel.availability`` alone — a fact about the ``hope-models`` MinIO bucket,
written by ``ModelInventoryService``, which stamps ``MISSING`` on every row whose
``bucketPrefix`` is NULL. But nothing on the serving path reads that bucket for
these rows: ``apps/stt`` resolves weights through ``source_uri`` into the
HuggingFace cache (``apps/stt/src/stt/models/source_resolver.py``) and
``apps/nlp`` does the same via ``HF_HOME``. So 21 of 33 catalogue rows — every
whisper row, ``medical-ner``, ``gliner2``, ``kokoro`` — reported "unusable" while
the process that serves them had the weights on disk.

This module answers the question the bucket cannot: **the serving process's own
verdict**, read-only and network-free. The gateway asks each service by
``servedBy``; the service answers about ITS filesystem; the readiness sweep folds
the answer in. Nobody guesses: an unreachable service stays ``unknown``.

Three rules it must keep:

* **Never fetch.** Every branch is a cache/filesystem read. ``local_files_only``
  on the HuggingFace side, an ``exists()`` on the others, and no S3 client is
  ever constructed. A readiness probe that downloads multi-gigabyte weights is a
  denial of service wearing a health check.
* **Never guess.** An unrecognised scheme is ``unsupported``, not "probably
  fine". A package-provided library is resolvable only if the package actually
  imports.
* **No service dependency.** This package is imported by every Python service
  and is deliberately dependency-free; ``huggingface_hub`` is imported lazily
  inside the one branch that needs it, exactly as ``vram.py`` treats ``pynvml``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

#: `<scheme>:` at the head of a URI — RFC 3986 scheme grammar.
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")

# The libraries whose weights ship INSIDE the Python package, mapped to the
# module whose presence proves it. Mirrors `WEIGHTLESS_LIBRARIES` in
# `packages/applications/src/services/ai-model/inventory/model-inventory.service.ts`
# — the gateway calls these rows NOT_APPLICABLE for the bucket, and here they are
# resolvable if and only if the package is installed in THIS process.
PACKAGE_PROVIDED_LIBRARIES: dict[str, tuple[str, ...]] = {
    "pyrnnoise": ("pyrnnoise",),
    # DeepFilterNet's distribution name and its import name differ; accept either
    # so a build that ships only one of them is still reported correctly.
    "deepfilternet": ("df", "deepfilternet"),
}


@dataclass(frozen=True)
class ResolvableQuery:
    """One catalogue row, projected onto what a resolvability check needs."""

    source_uri: str | None
    id: str | None = None
    library: str | None = None
    revision: str | None = None
    #: Operator override. No `AiModel` column carries one today (it was dropped),
    #: but the STT resolver still honours a per-model `local_path`, so the field
    #: stays part of the contract rather than being re-invented later.
    local_path: str | None = None


@dataclass(frozen=True)
class ResolvableResult:
    """The serving process's verdict for one row."""

    id: str | None
    resolvable: bool
    #: WHY, as a stable token — never a free-form message. The gateway projects
    #: `detail` onto a tenant-facing field, so the vocabulary is closed:
    #: local_path | file | package | hf_cache | s3_cache | not_cached |
    #: package_missing | no_source | unsupported | error
    state: str
    detail: str
    #: Where it would load from, when that is known. Absolute paths are
    #: operational information; the gateway keeps them out of tenant payloads.
    path: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "resolvable": self.resolvable,
            "state": self.state,
            "detail": self.detail,
            "path": self.path,
        }


def _hf_snapshot_path(repo_id: str, revision: str | None, cache_dir: str | None) -> str | None:
    """The cached snapshot directory for ``repo_id``, or ``None``. NEVER downloads."""
    try:
        from huggingface_hub import snapshot_download  # noqa: PLC0415 — lazy, optional
    except Exception:  # noqa: BLE001 — a service without the hub cannot resolve an hf: row
        return None

    try:
        return str(
            snapshot_download(
                repo_id=repo_id,
                revision=revision or None,
                cache_dir=cache_dir,
                local_files_only=True,
            )
        )
    except Exception:  # noqa: BLE001 — every miss is "not cached", never an error
        return None


def check_resolvable(
    query: ResolvableQuery,
    *,
    hf_cache_dir: str | None = None,
    s3_cache_dir: str | None = None,
) -> ResolvableResult:
    """Whether ``query``'s weights are already loadable on THIS host.

    ``s3_cache_dir`` is the service's resolver cache root; an ``s3://`` row is
    resolvable only when its entry is already materialised there, because the
    alternative is a download.
    """
    try:
        return _check(query, hf_cache_dir=hf_cache_dir, s3_cache_dir=s3_cache_dir)
    except Exception as exc:  # noqa: BLE001 — a probe must never take the service down
        logger.warning("hope_runtime_models.resolvable_check_failed id=%s error=%s", query.id, exc)
        return ResolvableResult(
            id=query.id,
            resolvable=False,
            state="error",
            detail="the resolvability check itself failed; nothing was measured",
        )


def _check(
    query: ResolvableQuery,
    *,
    hf_cache_dir: str | None,
    s3_cache_dir: str | None,
) -> ResolvableResult:
    # 1. Operator override wins everywhere, exactly as the loaders order it.
    if query.local_path:
        candidate = Path(query.local_path)
        if candidate.exists():
            return ResolvableResult(
                query.id, True, "local_path", "staged at the configured local_path", str(candidate)
            )

    # 2. A library that ships its own weights has nothing to fetch — but only if
    #    the package is actually installed in this process.
    library = (query.library or "").strip().lower()
    if library in PACKAGE_PROVIDED_LIBRARIES:
        for module in PACKAGE_PROVIDED_LIBRARIES[library]:
            if importlib.util.find_spec(module) is not None:
                return ResolvableResult(
                    query.id,
                    True,
                    "package",
                    f"{library} ships its weights inside the installed package",
                )
        return ResolvableResult(
            query.id,
            False,
            "package_missing",
            f"{library} ships its own weights, but the package is not installed here",
        )

    uri = (query.source_uri or "").strip()
    if not uri:
        return ResolvableResult(
            query.id, False, "no_source", "the row declares neither a local_path nor a source_uri"
        )

    # 3. file:// — verified in place, never copied.
    if uri.startswith("file://"):
        path = Path(uri[len("file://") :])
        if path.exists():
            return ResolvableResult(
                query.id, True, "file", "present at the declared file:// path", str(path)
            )
        return ResolvableResult(
            query.id, False, "not_cached", "the declared file:// path does not exist on this host"
        )

    # 4. s3:// — resolvable only if the resolver's cache entry is already
    #    materialised. The key derivation mirrors `_resolve_s3` in
    #    `apps/stt/src/stt/models/source_resolver.py`; anything else would report
    #    a cache the loader will not find.
    if uri.startswith("s3://"):
        if not s3_cache_dir:
            return ResolvableResult(
                query.id,
                False,
                "not_cached",
                "this service has no object-store cache; the weights would have to be downloaded",
            )
        # noqa on the digest: a cache KEY, not a security digest — it must match
        # `_resolve_s3` in `apps/stt/src/stt/models/source_resolver.py` exactly,
        # or this reports a cache the loader will not find.
        digest = hashlib.sha1(uri.encode()).hexdigest()  # noqa: S324
        target = Path(s3_cache_dir) / "s3" / digest
        if target.exists():
            return ResolvableResult(
                query.id,
                True,
                "s3_cache",
                "already materialised in the object-store cache",
                str(target),
            )
        return ResolvableResult(
            query.id,
            False,
            "not_cached",
            "not in the object-store cache; the weights would have to be downloaded",
        )

    # 5. hf:<org>/<repo> or a bare HuggingFace id.
    if uri.startswith("hf:") or _looks_like_hf_id(uri):
        repo_id = uri[len("hf:") :] if uri.startswith("hf:") else uri
        snapshot = _hf_snapshot_path(repo_id, query.revision, hf_cache_dir)
        if snapshot:
            return ResolvableResult(
                query.id,
                True,
                "hf_cache",
                "a snapshot is present in the local HuggingFace cache",
                snapshot,
            )
        return ResolvableResult(
            query.id,
            False,
            "not_cached",
            "no snapshot in the local HuggingFace cache; the weights would have to be downloaded",
        )

    scheme = urlparse(uri).scheme or "<none>"
    return ResolvableResult(
        query.id, False, "unsupported", f"this service cannot resolve a '{scheme}' source"
    )


def _looks_like_hf_id(uri: str) -> bool:
    """A bare HuggingFace id: ``<org>/<repo>``, no scheme, no absolute path.

    The scheme test is `<scheme>:`, not `://`. Two real catalogue rows use the
    scheme-only form — ``pypi:pyrnnoise`` and
    ``github:Rikorose/DeepFilterNet#DeepFilterNet3`` — and the latter passes a
    naive `://` check (`github:Rikorose` / `DeepFilterNet#DeepFilterNet3` is one
    slash and two non-empty halves), so it would be probed against the hub as if
    it were an org/repo id. An unrecognised scheme must be NAMED, never guessed.
    """
    if uri.startswith("/") or "#" in uri:
        return False
    if _SCHEME_RE.match(uri):
        return False
    return uri.count("/") == 1 and all(part for part in uri.split("/"))
