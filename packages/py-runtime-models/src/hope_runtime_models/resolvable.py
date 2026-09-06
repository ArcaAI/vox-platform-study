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

**TASK-890 F6 — why one worker was not enough, and what a warm volume costs.**
F3's answer to (2) was a ``BoundedSemaphore(1)``: a stalled volume must cost one
abandoned thread, so allow exactly one. Measured on a clean restart 2026-09-07,
that traded a hung service for a permanently useless one — the FIRST probe on
both ``stt`` and ``nlp`` never returned, held the only slot, and every later
probe answered in 2 ms with ``an earlier probe on this host has not returned``.
Readiness never recovered short of a restart. Three changes follow:

4. The bound is :data:`MAX_PROBE_THREADS` daemon threads, not one slot, with an
   explicit stalled count. A wedged read costs ONE probe; the next is still
   attempted; only at the cap does the answer become ``degraded`` — which names
   the count and the root instead of implying somebody measured something.
   Daemon threads on purpose: a ``ThreadPoolExecutor`` joins its workers at
   interpreter exit, so one wedged worker would make the process unstoppable.
5. A boot WARM-UP (:func:`warm_cache_roots`) touches every cache root once, off
   every request path, with its own generous budget — so an external volume's
   wake-up cost is paid before the first readiness sweep, and a host where even
   that does not return says so (``warm: false``) instead of being discovered
   one abandoned thread at a time.
6. Every filesystem call publishes what it is (:func:`_fs_op`) before entering
   it, so an abandoned probe can be logged with the exact ``open``/``stat``/
   ``scandir`` and path it went into and never came back from. On this host the
   volume is exFAT served by a USERSPACE FSKit extension: a shell ``ls`` and a
   fresh Python process both answer in milliseconds while the service's own
   thread stays inside the kernel indefinitely, so the call has to be recorded
   as it is entered — it will never return to be timed.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import logging
import os
import re
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
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

#: How many probe threads this process will ever have alive AT ONCE — including
#: the ones a previous budget abandoned inside a filesystem call that never
#: returned. It is deliberately more than one (TASK-890 F6): the single slot F3
#: shipped meant the FIRST stalled read made every later probe answer
#: `an earlier probe on this host has not returned` for the life of the process,
#: so one wedged volume access cost the service its readiness answer permanently.
#: Three is small enough that a wedged volume cannot grow threads without bound
#: and large enough that a transient stall costs one probe, not all of them.
MAX_PROBE_THREADS = 3

#: A single `open`/`stat`/`scandir` slower than this is logged with its path.
#: Diagnostic only — it does not abort the call (a syscall wedged in the kernel
#: cannot be aborted from Python at all), it just makes the difference between
#: "slow volume" and "wedged volume" visible in the log instead of inferred.
SLOW_OP_SECONDS = 1.0

#: The warm-up's own budget. Generous on purpose: it runs ONCE, at boot, off
#: every request path, and the whole point is to pay an external volume's
#: wake-up cost there rather than inside the first readiness sweep.
WARMUP_BUDGET_SECONDS = 60.0

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
    #: package_missing | no_source | unsupported | timeout | degraded | error
    #:
    #: `degraded` (TASK-890 F6) is the answer at the thread cap: every probe
    #: thread this process allows is still inside a filesystem call that has not
    #: returned, so nothing was even attempted for this row. Like `timeout` it
    #: carries `resolvable = None`.
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


# --------------------------------------------------------------------------- #
# Which filesystem call a thread is inside
# --------------------------------------------------------------------------- #

#: Keyed by thread id: the `(op, path, started)` a thread is CURRENTLY inside.
#: A thread that returns clears its entry; a thread wedged in the kernel never
#: does — which is exactly what makes this the only thing in the process that
#: can name the call an abandoned probe went into and never came back from.
#: Plain dict, no lock: each thread only ever writes its OWN key, and CPython's
#: dict item assignment is atomic, so a lock here would buy nothing and would be
#: taken on every single file operation.
_active_ops: dict[int, tuple[str, str, float]] = {}


@contextlib.contextmanager
def _fs_op(op: str, path: str) -> Iterator[None]:
    """Record — and time — one filesystem call.

    Two jobs, both diagnostic. It publishes what this thread is inside so an
    abandoned probe can be described rather than guessed at, and it logs any
    single call that took longer than :data:`SLOW_OP_SECONDS`. It never bounds
    anything: a call already wedged in the kernel cannot be cancelled from
    Python, which is why the BUDGET lives one level up, around the whole batch.
    """
    ident = threading.get_ident()
    previous = _active_ops.get(ident)
    started = time.monotonic()
    _active_ops[ident] = (op, path, started)
    try:
        yield
    finally:
        elapsed = time.monotonic() - started
        if previous is None:
            _active_ops.pop(ident, None)
        else:
            _active_ops[ident] = previous
        if elapsed >= SLOW_OP_SECONDS:
            logger.warning(
                "hope_runtime_models.resolvable_slow_fs_op op=%s path=%s elapsed=%.1fs",
                op,
                path,
                elapsed,
            )


def _describe_op(ident: int | None) -> str:
    """What that thread is inside, right now, as one loggable token."""
    entry = _active_ops.get(ident) if ident is not None else None
    if entry is None:
        return "op=<none>"
    op, path, started = entry
    return f"op={op} path={path} inside_for={time.monotonic() - started:.1f}s"


# --------------------------------------------------------------------------- #
# The probe pool
# --------------------------------------------------------------------------- #


@dataclass
class _Probe:
    """One batch, running on its own daemon thread."""

    future: Future[Any]
    thread: threading.Thread
    generation: int
    started: float
    abandoned: bool = field(default=False)
    finished: bool = field(default=False)


class _ProbePool:
    """Bounded daemon threads, and an honest count of the ones we walked away from.

    The contract, which is the whole of TASK-890 F6:

    * a call that outlives its budget is ABANDONED — its thread stays wedged in
      the syscall, because nothing in Python can pull it out — and the pool
      remembers that as ``stalled``;
    * later probes are still ATTEMPTED while a thread remains free, so one dead
      volume access does not disable readiness for the life of the process;
    * at the cap the answer is ``degraded``, naming the count and the root,
      instead of silently starting a fourth thread nobody will ever join;
    * when an abandoned thread eventually DOES return, the count comes back down
      and its true duration is logged. That log line is the only record of how
      long the volume actually took, and without it the number is unknowable.

    Threads are daemons and are never joined: a ``ThreadPoolExecutor`` registers
    an atexit hook that joins its workers, so a single wedged worker would hang
    interpreter shutdown — trading a stalled probe for a process that cannot be
    stopped is not a trade worth making.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._inflight = 0
        self._stalled = 0
        #: Bumped by `reset()`. A probe abandoned before a reset must not
        #: decrement the counters afterwards — tests reset between cases, and a
        #: stale thread landing later would drive the count negative.
        self._generation = 0

    def counts(self) -> tuple[int, int]:
        with self._lock:
            return self._inflight, self._stalled

    def reset(self) -> None:
        with self._lock:
            self._inflight = 0
            self._stalled = 0
            self._generation += 1

    def submit(self, work: Callable[[], Any]) -> _Probe | None:
        """Start ``work`` on a daemon thread, or ``None`` when every thread is busy."""
        with self._lock:
            if self._inflight >= MAX_PROBE_THREADS:
                return None
            self._inflight += 1
            generation = self._generation

        future: Future[Any] = Future()

        def _runner() -> None:
            if not future.set_running_or_notify_cancel():
                return
            try:
                future.set_result(work())
            except BaseException as exc:  # noqa: BLE001 — carried to the awaiting caller
                future.set_exception(exc)

        probe = _Probe(
            future=future,
            thread=threading.Thread(target=_runner, name="hope-resolvable-probe", daemon=True),
            generation=generation,
            started=time.monotonic(),
        )
        future.add_done_callback(lambda _f: self._on_done(probe))
        probe.thread.start()
        return probe

    def abandon(self, probe: _Probe, *, what: str) -> int:
        """Stop waiting on ``probe``. Returns the stalled count after doing so."""
        with self._lock:
            if probe.finished:
                # It landed in the race between the timeout firing and this
                # call. Nothing was abandoned, so nothing is stalled.
                return self._stalled
            probe.abandoned = True
            if probe.generation == self._generation:
                self._stalled += 1
            stalled = self._stalled
        logger.warning(
            "hope_runtime_models.resolvable_probe_abandoned what=%s waited=%.1fs stalled=%d "
            "thread=%s %s",
            what,
            time.monotonic() - probe.started,
            stalled,
            probe.thread.name,
            _describe_op(probe.thread.ident),
        )
        return stalled

    def _on_done(self, probe: _Probe) -> None:
        with self._lock:
            probe.finished = True
            stale = probe.generation != self._generation
            was_abandoned = probe.abandoned
            if not stale:
                self._inflight = max(0, self._inflight - 1)
                if was_abandoned:
                    self._stalled = max(0, self._stalled - 1)
            stalled = self._stalled
        if was_abandoned:
            # The number nobody could otherwise know: how long the volume
            # actually took. A probe abandoned at 5 s that returns at 900 s is a
            # very different fact from one that returns at 6 s.
            logger.warning(
                "hope_runtime_models.resolvable_abandoned_probe_returned true_duration=%.1fs "
                "stalled=%d",
                time.monotonic() - probe.started,
                stalled,
            )


_PROBES = _ProbePool()


def probe_state() -> tuple[int, int]:
    """``(threads alive, threads past their budget)``. For tests and diagnostics."""
    return _PROBES.counts()


def reset_probe_state() -> None:
    """Forget the current counts. For tests — it cannot un-wedge a live thread."""
    _PROBES.reset()


# --------------------------------------------------------------------------- #
# Warm-up
# --------------------------------------------------------------------------- #

#: `"pending"` until the boot warm-up has finished; then `True` if every
#: configured cache root answered inside its budget, `False` if one did not.
#: Reported on the resolvable endpoints so an operator can tell "this host has
#: not touched the volume yet" from "this host touched it and it answered".
_warmup_state: bool | str = "pending"
_warmup_lock = threading.Lock()


def warmup_state() -> bool | str:
    """``True`` | ``False`` | ``"pending"`` — see :func:`warm_cache_roots`."""
    with _warmup_lock:
        return _warmup_state


def reset_warmup_state() -> None:
    """Back to ``"pending"``. For tests."""
    _set_warmup_state("pending")


def _set_warmup_state(value: bool | str) -> None:
    global _warmup_state
    with _warmup_lock:
        _warmup_state = value


def cache_roots(*, hf_cache_dir: str | None = None, s3_cache_dir: str | None = None) -> list[Path]:
    """Every directory a verdict could have to read, in the order it would try them."""
    roots = _hf_cache_roots(hf_cache_dir)
    if s3_cache_dir:
        roots = roots + [Path(s3_cache_dir) / "s3"]
    return _dedupe(roots)


def _touch_roots(roots: Sequence[Path]) -> list[tuple[str, float, str]]:
    """One `stat` and one `scandir` per root — the cheapest thing that wakes a volume."""
    report: list[tuple[str, float, str]] = []
    for root in roots:
        started = time.monotonic()
        outcome = "ok"
        try:
            with _fs_op("warmup_stat", str(root)):
                os.stat(root)
            with _fs_op("warmup_scandir", str(root)):
                with os.scandir(root) as entries:
                    for index, _entry in enumerate(entries):
                        if index >= _SCAN_CAP:
                            break
        except (FileNotFoundError, NotADirectoryError):
            # A root this host does not have is not a failure — `_hf_cache_roots`
            # deliberately offers candidates, and most hosts hold one of them.
            outcome = "absent"
        except OSError as exc:
            outcome = f"error:{type(exc).__name__}"
        report.append((str(root), time.monotonic() - started, outcome))
    return report


async def warm_cache_roots(
    *,
    hf_cache_dir: str | None = None,
    s3_cache_dir: str | None = None,
    budget_seconds: float | None = None,
    service: str | None = None,
) -> bool | str:
    """Touch every cache root ONCE, at boot, off every request path.

    TASK-890 F6. The stall this exists for is not a slow filesystem, it is a
    volume whose FIRST access from a given process does not return: measured on
    this host, ``/Volumes/aillusion`` is an exFAT volume served by a USERSPACE
    FSKit extension, a shell ``ls`` answers instantly, and the service's first
    access from a worker thread stayed inside the kernel for minutes. Paying
    that cost here means the first readiness sweep meets a volume that is
    already awake, and — when it does not return even here — the process says so
    (``warm: false``) instead of a sweep discovering it one abandoned thread at
    a time.

    NEVER raises and never blocks boot: it is meant to be launched with
    ``asyncio.create_task`` from a lifespan and forgotten.
    """
    try:
        budget = WARMUP_BUDGET_SECONDS if budget_seconds is None else budget_seconds
        roots = cache_roots(hf_cache_dir=hf_cache_dir, s3_cache_dir=s3_cache_dir)
        if not roots:
            _set_warmup_state(True)
            return True

        probe = _PROBES.submit(lambda: _touch_roots(roots))
        if probe is None:
            logger.warning(
                "hope_runtime_models.resolvable_warmup_no_thread service=%s roots=%d",
                service,
                len(roots),
            )
            _set_warmup_state(False)
            return False

        started = time.monotonic()
        try:
            report = await asyncio.wait_for(asyncio.wrap_future(probe.future), timeout=budget)
        except TimeoutError:
            _PROBES.abandon(probe, what="warmup")
            logger.warning(
                "hope_runtime_models.resolvable_warmup_stalled service=%s budget=%.0fs roots=%s",
                service,
                budget,
                [str(root) for root in roots],
            )
            _set_warmup_state(False)
            return False

        healthy = True
        for root, elapsed, outcome in report:
            logger.info(
                "hope_runtime_models.resolvable_warmup service=%s root=%s elapsed=%.3fs "
                "outcome=%s",
                service,
                root,
                elapsed,
                outcome,
            )
            if outcome.startswith("error"):
                healthy = False
        logger.info(
            "hope_runtime_models.resolvable_warmup_done service=%s roots=%d elapsed=%.3fs warm=%s",
            service,
            len(report),
            time.monotonic() - started,
            healthy,
        )
        _set_warmup_state(healthy)
        return healthy
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — a warm-up must never fail a boot
        logger.warning(
            "hope_runtime_models.resolvable_warmup_failed service=%s error=%s", service, exc
        )
        _set_warmup_state(False)
        return False


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
        with _fs_op("scandir", str(directory)), os.scandir(directory) as entries:
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
        with _fs_op("open", str(ref_path)), ref_path.open("rb") as handle:
            raw = handle.read(128)
    except OSError:
        return None
    sha = raw.decode("utf-8", "ignore").strip()
    return sha or None


def _snapshot_in_root(root: Path, repo_id: str, revision: str | None) -> str | None:
    """The materialised snapshot directory for ``repo_id`` under ``root``."""
    storage = root / ("models--" + repo_id.replace("/", "--"))
    snapshots = storage / "snapshots"
    with _fs_op("stat", str(snapshots)):
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
        with _fs_op("scandir", str(snapshots)), os.scandir(snapshots) as entries:
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


async def check_resolvable_many(
    queries: Sequence[ResolvableQuery],
    *,
    hf_cache_dir: str | None = None,
    s3_cache_dir: str | None = None,
    budget_seconds: float | None = None,
) -> list[ResolvableResult]:
    """Every row, off the event loop, inside one wall-clock budget.

    The endpoints call ONLY this. It is what stops a stalled filesystem from
    becoming a stalled service: the reads happen on a daemon thread, the caller
    stops waiting at ``budget_seconds``, and every row the budget did not reach
    comes back ``resolvable = None`` (NOT MEASURED) rather than ``False``.

    **TASK-890 F6 — why one slot was not enough.** F3 guarded this with a
    ``BoundedSemaphore(1)``, reasoning that a wedged volume must not grow
    threads. It does not grow them — but the FIRST wedged read then held the
    only slot for the life of the process, and every later probe answered in
    2 ms with ``an earlier probe on this host has not returned``. Measured on
    this host: both ``stt`` and ``nlp`` reached that state within minutes of a
    clean start and never left it. A cap of :data:`MAX_PROBE_THREADS` keeps the
    bound that mattered while letting the NEXT probe actually try; only when
    every thread is wedged does the service answer ``degraded``, which says
    "this host is not answering" rather than pretending to have measured.

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

    probe = _PROBES.submit(_work)
    if probe is None:
        inflight, stalled = _PROBES.counts()
        root = _primary_root(hf_cache_dir, s3_cache_dir)
        logger.warning(
            "hope_runtime_models.resolvable_degraded rows=%d inflight=%d stalled=%d root=%s",
            len(queries),
            inflight,
            stalled,
            root,
        )
        detail = (
            f"{stalled} of this host's {inflight} probe threads have not returned; "
            f"the model cache root {root} is not answering"
        )
        return [ResolvableResult(query.id, None, "degraded", detail, root) for query in queries]

    try:
        return await asyncio.wait_for(asyncio.wrap_future(probe.future), timeout=budget)
    except TimeoutError:  # `asyncio.TimeoutError` is an alias of it on 3.11+
        _PROBES.abandon(probe, what=f"batch rows={len(queries)}")
        logger.warning(
            "hope_runtime_models.resolvable_budget_exceeded rows=%d budget=%.1fs",
            len(queries),
            budget,
        )
        return [
            _unmeasured(query, "the filesystem check did not finish inside this probe's budget")
            for query in queries
        ]
    except Exception as exc:  # noqa: BLE001 — a probe must never take the service down
        logger.warning("hope_runtime_models.resolvable_batch_failed error=%s", exc)
        return [
            ResolvableResult(
                query.id,
                None,
                "error",
                "the resolvability check itself failed; nothing was measured",
            )
            for query in queries
        ]


def _primary_root(hf_cache_dir: str | None, s3_cache_dir: str | None) -> str:
    """The root an operator would go and look at. Named in the degraded answer.

    The `path` field is the sanctioned place for an absolute host path (the
    gateway keeps it out of tenant payloads), and it is repeated in `detail`
    because a degraded readiness answer that does not say WHICH volume stopped
    answering is not actionable — and `detail` reaches only the platform
    operator: the gateway's sweep reads `id` and `resolvable`, nothing else.
    """
    roots = cache_roots(hf_cache_dir=hf_cache_dir, s3_cache_dir=s3_cache_dir)
    return str(roots[0]) if roots else "<none configured>"


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
        with _fs_op("stat", str(candidate)):
            staged = candidate.exists()
        if staged:
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
        with _fs_op("stat", str(path)):
            present = path.exists()
        if present:
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
        with _fs_op("stat", str(target)):
            materialised = target.exists()
        if materialised:
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
