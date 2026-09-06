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

Four rules it must keep:

* **Never fetch, and never call the hub.** Every branch is a bounded filesystem
  read. The HuggingFace branch resolves the cache layout BY HAND —
  ``models--<org>--<name>/refs/<rev>`` to a commit hash, then
  ``snapshots/<sha>/`` — rather than calling ``snapshot_download``. A readiness
  probe that downloads multi-gigabyte weights is a denial of service wearing a
  health check, and the library call that promised not to download still gave us
  one (see TASK-890 F3 below).
* **Never guess.** An unrecognised scheme is ``unsupported``, not "probably
  fine". A package-provided library is resolvable only if the package actually
  imports.
* **Never walk.** No ``scan_cache_dir``, no recursive descent: at most one
  ``scandir`` per candidate directory, stopped at the first materialised entry,
  and hard-capped. The answer must cost the same on a 2 GB cache and a 2 TB one.
* **No service dependency.** This package is imported by every Python service
  and is deliberately dependency-free — now including ``huggingface_hub``, which
  used to be a lazy import in the one branch that needed it.

**TASK-890 F3 — why the hub call had to go.** ``snapshot_download(...,
local_files_only=True)`` does not fetch, but it does ``open()`` the ``refs``
file, and on this host ``HF_HOME`` is an EXTERNAL volume. Measured 2026-09-07:
the full 19-row ``stt`` payload cost 0.12 s in a fresh process, yet in the
running service a single ``POST /api/v1/internal/models/resolvable`` left the
main thread parked in that ``open()`` syscall for over fifteen minutes —
``sample`` on pid 27166 (stt) and 27092 (nlp) put 100 % of main-thread samples
in ``__open`` — with ``request.start`` as the last line either service ever
logged. Both processes were dead to every caller, health probes included. Three
things follow, and all three are load-bearing:

1. The check is filesystem-only and bounded (this module).
2. It runs OFF the event loop, behind a wall-clock budget
   (:func:`check_resolvable_many`) — a stalled volume must cost one abandoned
   worker thread, never the service.
3. A row the budget could not measure answers ``resolvable = None``. The gateway
   records only a literal boolean, so an unmeasured row stays ``unknown`` and is
   never mistaken for "weights missing".
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import logging
import os
import re
import threading
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

#: `<scheme>:` at the head of a URI — RFC 3986 scheme grammar.
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")

#: A git commit hash, i.e. a revision that names a snapshot directory directly.
_COMMIT_HASH_RE = re.compile(r"^[0-9a-f]{40}$")

#: How long a verdict is reused for the same (cache dirs, row) pair. A sweep
#: asks about the same rows every cycle and the answer changes only when an
#: operator stages or removes weights, so a short memory turns a per-sweep
#: filesystem read into a per-minute one — and, on a stalled volume, stops the
#: next sweep re-entering the syscall that stalled.
CACHE_TTL_SECONDS = 60.0

#: The wall-clock budget for one batch, comfortably inside the gateway's 10 s
#: axios timeout so the gateway sees an ANSWER (rows it must leave unknown)
#: rather than a client-side timeout it cannot attribute.
DEFAULT_BUDGET_SECONDS = 5.0

#: Hard cap on entries examined in any one directory. Bounds the cost on a cache
#: whose `snapshots/` has accumulated many revisions.
_SCAN_CAP = 64

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
    #: `None` means NOT MEASURED — the budget ran out before this row got an
    #: answer. It is never a synonym for `False`; the gateway keeps such a row
    #: `unknown` because it only records a literal boolean.
    resolvable: bool | None
    #: WHY, as a stable token — never a free-form message. The gateway projects
    #: `detail` onto a tenant-facing field, so the vocabulary is closed:
    #: local_path | file | package | hf_cache | s3_cache | not_cached |
    #: package_missing | no_source | unsupported | timeout | error
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


# --------------------------------------------------------------------------- #
# Result memory
# --------------------------------------------------------------------------- #

_cache_lock = threading.Lock()
_cache: dict[tuple[str | None, ...], tuple[float, ResolvableResult]] = {}

#: One probe in flight per process. A batch that is stalled inside a filesystem
#: call holds this, and the next batch answers `timeout` IMMEDIATELY instead of
#: parking a second worker thread in the same syscall. Threads are the resource
#: a stalled volume would otherwise consume without bound.
_probe_slot = threading.BoundedSemaphore(1)


def clear_resolvable_cache() -> None:
    """Drop every memoised verdict. For tests and for an operator-staged change."""
    with _cache_lock:
        _cache.clear()


def _cache_key(
    query: ResolvableQuery, hf_cache_dir: str | None, s3_cache_dir: str | None
) -> tuple[str | None, ...]:
    return (
        hf_cache_dir,
        s3_cache_dir,
        query.source_uri,
        query.revision,
        query.library,
        query.local_path,
    )


# --------------------------------------------------------------------------- #
# The HuggingFace cache layout, read by hand
# --------------------------------------------------------------------------- #


def _dedupe(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for path in paths:
        key = str(path)
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _hf_cache_roots(cache_dir: str | None) -> list[Path]:
    """Every directory a repo folder could sit under, in the order to try them.

    BOTH layouts are live on the same host and the services disagree about which
    one they mean: ``apps/stt`` passes ``HF_HOME`` itself as its resolver's cache
    dir, while ``apps/nlp``/``apps/tts`` load through the hub library, which
    resolves ``$HF_HOME/hub``. Reading only one of them reports a warm cache as
    cold — which is the bug this whole module exists to fix — so an explicit
    ``cache_dir`` is tried both as-is and with ``hub/`` appended.
    """
    if cache_dir:
        base = Path(cache_dir)
        return _dedupe([base, base / "hub"])

    roots: list[Path] = []
    hub_cache = os.environ.get("HF_HUB_CACHE")
    if hub_cache:
        roots.append(Path(hub_cache))
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        roots.append(Path(hf_home) / "hub")
        roots.append(Path(hf_home))
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    return _dedupe(roots)


def _has_materialised_entry(directory: Path) -> bool:
    """Does ``directory`` hold at least one real file or subdirectory?

    One ``scandir``, stopped at the first hit and capped at ``_SCAN_CAP``.
    macOS AppleDouble sidecars (``._name``) are skipped: an external volume
    formatted elsewhere is littered with them and a snapshot folder containing
    nothing else is empty, whatever ``os.listdir`` says. Broken symlinks are
    skipped too — a snapshot's entries are symlinks into ``blobs/``, and a
    dangling one means the blob was pruned.
    """
    try:
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index >= _SCAN_CAP:
                    break
                if entry.name.startswith("._"):
                    continue
                try:
                    if entry.is_file() or entry.is_dir():
                        return True
                except OSError:  # noqa: PERF203 — a dangling entry is just skipped
                    continue
    except OSError:
        return False
    return False


def _read_ref(ref_path: Path) -> str | None:
    """The commit hash a branch/tag ref points at. Bounded read, never a walk."""
    try:
        with ref_path.open("rb") as handle:
            raw = handle.read(128)
    except OSError:
        return None
    sha = raw.decode("utf-8", "ignore").strip()
    return sha or None


def _snapshot_in_root(root: Path, repo_id: str, revision: str | None) -> str | None:
    """The materialised snapshot directory for ``repo_id`` under ``root``."""
    storage = root / ("models--" + repo_id.replace("/", "--"))
    snapshots = storage / "snapshots"
    if not snapshots.is_dir():
        return None

    rev = (revision or "").strip() or "main"

    # A revision that IS a commit hash names its snapshot directly.
    if _COMMIT_HASH_RE.match(rev):
        candidate = snapshots / rev
        return str(candidate) if _has_materialised_entry(candidate) else None

    sha = _read_ref(storage / "refs" / rev)
    if sha:
        candidate = snapshots / sha
        if _has_materialised_entry(candidate):
            return str(candidate)

    # No ref for this revision: a repo fetched by commit hash has no `refs/main`
    # at all. Weights on disk are weights on disk, so ANY materialised snapshot
    # answers the question the gateway actually asked — "must this host download
    # something to serve the row?" — and the branch stays bounded to one level.
    try:
        with os.scandir(snapshots) as entries:
            for index, entry in enumerate(entries):
                if index >= _SCAN_CAP:
                    break
                if entry.name.startswith("._") or not entry.is_dir():
                    continue
                if _has_materialised_entry(Path(entry.path)):
                    return entry.path
    except OSError:
        return None
    return None


def _hf_snapshot_path(repo_id: str, revision: str | None, cache_dir: str | None) -> str | None:
    """The cached snapshot directory for ``repo_id``, or ``None``. NEVER downloads."""
    for root in _hf_cache_roots(cache_dir):
        found = _snapshot_in_root(root, repo_id, revision)
        if found:
            return found
    return None


# --------------------------------------------------------------------------- #
# The check
# --------------------------------------------------------------------------- #


def check_resolvable(
    query: ResolvableQuery,
    *,
    hf_cache_dir: str | None = None,
    s3_cache_dir: str | None = None,
    use_cache: bool = True,
) -> ResolvableResult:
    """Whether ``query``'s weights are already loadable on THIS host.

    ``s3_cache_dir`` is the service's resolver cache root; an ``s3://`` row is
    resolvable only when its entry is already materialised there, because the
    alternative is a download.

    Synchronous and filesystem-bound. Callers on an event loop MUST go through
    :func:`check_resolvable_many`, which offloads and bounds it.
    """
    key = _cache_key(query, hf_cache_dir, s3_cache_dir)
    now = time.monotonic()
    if use_cache:
        with _cache_lock:
            hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]

    try:
        result = _check(query, hf_cache_dir=hf_cache_dir, s3_cache_dir=s3_cache_dir)
    except Exception as exc:  # noqa: BLE001 — a probe must never take the service down
        logger.warning("hope_runtime_models.resolvable_check_failed id=%s error=%s", query.id, exc)
        # NOT MEASURED, not "not resolvable": the check itself fell over, so it
        # observed nothing about the weights. `False` here would let a bug in
        # this module be reported to a tenant as missing weights.
        return ResolvableResult(
            id=query.id,
            resolvable=None,
            state="error",
            detail="the resolvability check itself failed; nothing was measured",
        )

    if use_cache:
        with _cache_lock:
            if len(_cache) > 1024:  # a catalogue is tens of rows; this is runaway, not growth
                _cache.clear()
            _cache[key] = (now, result)
    return result


class _ProbeBusyError(RuntimeError):
    """A probe is already in flight and has not returned."""


async def check_resolvable_many(
    queries: Sequence[ResolvableQuery],
    *,
    hf_cache_dir: str | None = None,
    s3_cache_dir: str | None = None,
    budget_seconds: float | None = None,
) -> list[ResolvableResult]:
    """Every row, off the event loop, inside one wall-clock budget.

    The endpoints call ONLY this. It is what stops a stalled filesystem from
    becoming a stalled service: the reads happen on a worker thread, the caller
    stops waiting at ``budget_seconds``, and every row the budget did not reach
    comes back ``resolvable = None`` (NOT MEASURED) rather than ``False``.

    ``budget_seconds`` defaults to :data:`DEFAULT_BUDGET_SECONDS` READ AT CALL
    TIME, not bound into the signature — a default argument evaluated at import
    would make the budget unpatchable, and a budget nobody can shorten is a
    budget nobody tests.
    """
    if not queries:
        return []
    budget = DEFAULT_BUDGET_SECONDS if budget_seconds is None else budget_seconds

    def _work() -> list[ResolvableResult]:
        return [
            check_resolvable(query, hf_cache_dir=hf_cache_dir, s3_cache_dir=s3_cache_dir)
            for query in queries
        ]

    def _guarded() -> list[ResolvableResult]:
        # A previous batch parked in a filesystem call still holds the slot. Do
        # not queue a second thread behind it; say so and let the row stay
        # unknown for this sweep.
        if not _probe_slot.acquire(blocking=False):
            raise _ProbeBusyError
        try:
            return _work()
        finally:
            _probe_slot.release()

    try:
        return await asyncio.wait_for(asyncio.to_thread(_guarded), timeout=budget)
    except _ProbeBusyError:
        return [
            _unmeasured(query, "an earlier probe on this host has not returned")
            for query in queries
        ]
    except TimeoutError:  # `asyncio.TimeoutError` is an alias of it on 3.11+
        logger.warning(
            "hope_runtime_models.resolvable_budget_exceeded rows=%d budget=%.1fs",
            len(queries),
            budget,
        )
        return [
            _unmeasured(query, "the filesystem check did not finish inside this probe's budget")
            for query in queries
        ]


def _unmeasured(query: ResolvableQuery, why: str) -> ResolvableResult:
    return ResolvableResult(id=query.id, resolvable=None, state="timeout", detail=why)


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
