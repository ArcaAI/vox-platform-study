"""How many CPUs may this process ACTUALLY use?

``os.cpu_count()`` and ``nproc`` answer a different question — how many CPUs the
NODE has — and inside a container that answer is wrong by whatever ratio the CFS
quota imposes. Measured on ``hope-nlp`` (TASK-892 §2.2): the pod held
``/sys/fs/cgroup/cpu.max = "200000 100000"`` (2 CPUs) on a 48-core node, PyTorch
sized its intra-op pool at 48, and the cgroup recorded **7,292 s frozen on the
quota against 573 s executing** — a 12.7x wall-clock tax, and an 11.7x
slow-down per BERT-base FFN layer against the same work at 8 threads.

Any "auto-detect the cores" fallback that reaches for ``os.cpu_count()`` has that
bug. This module is the one place the fleet asks the question correctly, so a
service configuring a thread pool never has to know which cgroup version its host
runs — or that it is in a container at all.

Resolution order (first hit wins)::

    1. OMP_NUM_THREADS ......... an operator's explicit override outranks us
    2. override= ............... the service's own *_TORCH_NUM_THREADS setting
    3. cgroup v2 ............... /sys/fs/cgroup/cpu.max      ("max" = unlimited)
    4. cgroup v1 ............... cpu.cfs_quota_us / cpu.cfs_period_us  (-1 = unlimited)
    5. sched_getaffinity ....... the CPUs this process is actually pinned to
    6. os.cpu_count() .......... the node, as a last resort

Two properties this module guarantees, because its callers run on a boot path:

* **It never raises.** A missing, unreadable or malformed cgroup file is not an
  error — it is a host that does not answer this question, and the resolution
  falls through to the next step. A helper that could abort a service start
  would be a worse defect than the one it fixes.
* **The result is always >= 1.** A quota below one full CPU (``"50000 100000"``)
  clamps to 1 rather than flooring to a zero-sized thread pool.

**Fractional quotas round DOWN** (1.5 CPUs -> 1). The pathology being fixed is a
thread pool that alone exhausts the CFS quota and then freezes for the rest of
every 100 ms period, so the pool must never claim more CPU than the quota can
grant. Go's ``automaxprocs`` makes the same call for the same reason; the JDK
rounds up, which re-opens a smaller version of the bug.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "CGROUP_V1_CPU_PERIOD",
    "CGROUP_V1_CPU_QUOTA",
    "CGROUP_V2_CPU_MAX",
    "OMP_NUM_THREADS_VAR",
    "CpuAllowance",
    "effective_cpu_quota",
    "resolve_cpu_allowance",
]

#: cgroup v2 — one file, ``"<quota> <period>"``; the literal ``max`` means unlimited.
CGROUP_V2_CPU_MAX = Path("/sys/fs/cgroup/cpu.max")
#: cgroup v1 — two files; a quota of ``-1`` means unlimited.
CGROUP_V1_CPU_QUOTA = Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
CGROUP_V1_CPU_PERIOD = Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us")

#: The operator-facing override. Read here as well as set by callers so that a
#: value already in the environment (a Deployment env var, an interim overlay
#: patch) is OBSERVED rather than overwritten by a computed one.
OMP_NUM_THREADS_VAR = "OMP_NUM_THREADS"

_UNLIMITED_V2 = "max"


@dataclass(frozen=True)
class CpuAllowance:
    """The resolved allowance and which step of the chain produced it.

    ``source`` exists so a service can log WHERE the number came from. The whole
    class of bug this module addresses is invisible until someone can tell
    "2 because the cgroup says so" from "2 because this laptop has 2 cores".
    """

    cpus: int
    source: str


def _read_text(path: Path) -> str | None:
    """Read a cgroup file, or ``None`` for anything that goes wrong.

    ``OSError`` covers absent (``FileNotFoundError``), a directory in the file's
    place (``IsADirectoryError``) and permission failures; ``UnicodeDecodeError``
    covers a path that exists but holds something that is not text.
    """
    try:
        return path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None


def _as_int(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        return int(raw.strip())
    except ValueError:
        return None


def _cpus_from_quota(quota: int | None, period: int | None) -> int | None:
    """``quota / period``, floored, clamped to >= 1 — or ``None`` if unlimited/invalid."""
    if quota is None or period is None or quota <= 0 or period <= 0:
        return None
    return max(1, quota // period)


def _from_cgroup_v2(path: Path) -> int | None:
    content = _read_text(path)
    if content is None:
        return None
    fields = content.split()
    if len(fields) != 2:
        return None
    if fields[0] == _UNLIMITED_V2:
        return None
    return _cpus_from_quota(_as_int(fields[0]), _as_int(fields[1]))


def _from_cgroup_v1(quota_path: Path, period_path: Path) -> int | None:
    # A quota of -1 is the kernel's "unlimited"; `_cpus_from_quota` rejects it
    # along with 0 and every non-numeric value.
    return _cpus_from_quota(_as_int(_read_text(quota_path)), _as_int(_read_text(period_path)))


def _from_host() -> CpuAllowance:
    """The CPUs visible to this process when no quota answers.

    ``sched_getaffinity`` is preferred over ``cpu_count`` because a taskset /
    cpuset-pinned process is bounded by it — but it is Linux-only, so it is
    reached through ``getattr`` rather than a direct call (macOS has no such
    attribute, and typeshed guards it by platform).
    """
    getaffinity = getattr(os, "sched_getaffinity", None)
    if getaffinity is not None:
        try:
            return CpuAllowance(max(1, len(getaffinity(0))), "sched_getaffinity")
        except OSError:
            pass
    count = os.cpu_count()
    if count:
        return CpuAllowance(max(1, count), "cpu_count")
    return CpuAllowance(1, "fallback")


def resolve_cpu_allowance(
    *,
    override: int | None = None,
    environ: Mapping[str, str] | None = None,
    cpu_max_path: Path = CGROUP_V2_CPU_MAX,
    cfs_quota_path: Path = CGROUP_V1_CPU_QUOTA,
    cfs_period_path: Path = CGROUP_V1_CPU_PERIOD,
) -> CpuAllowance:
    """Resolve the effective CPU allowance, and say which step produced it.

    :param override: the service's own setting (``*_TORCH_NUM_THREADS``).
        ``None``, ``0`` and negatives all mean "auto" — the declared spelling of
        auto in those settings is ``0``.
    :param environ: environment to read ``OMP_NUM_THREADS`` from; defaults to
        the real ``os.environ``.
    :param cpu_max_path: cgroup v2 file. Injectable so tests need no cgroups —
        the suite runs on macOS, which has none.
    :param cfs_quota_path: cgroup v1 quota file.
    :param cfs_period_path: cgroup v1 period file.
    """
    env = os.environ if environ is None else environ

    operator = _as_int(env.get(OMP_NUM_THREADS_VAR))
    if operator is not None and operator > 0:
        return CpuAllowance(operator, OMP_NUM_THREADS_VAR)

    if override is not None and override > 0:
        return CpuAllowance(override, "override")

    from_v2 = _from_cgroup_v2(cpu_max_path)
    if from_v2 is not None:
        return CpuAllowance(from_v2, "cgroup-v2")

    from_v1 = _from_cgroup_v1(cfs_quota_path, cfs_period_path)
    if from_v1 is not None:
        return CpuAllowance(from_v1, "cgroup-v1")

    return _from_host()


def effective_cpu_quota(
    *,
    override: int | None = None,
    environ: Mapping[str, str] | None = None,
    cpu_max_path: Path = CGROUP_V2_CPU_MAX,
    cfs_quota_path: Path = CGROUP_V1_CPU_QUOTA,
    cfs_period_path: Path = CGROUP_V1_CPU_PERIOD,
) -> int:
    """:func:`resolve_cpu_allowance` without the provenance — always ``>= 1``."""
    return resolve_cpu_allowance(
        override=override,
        environ=environ,
        cpu_max_path=cpu_max_path,
        cfs_quota_path=cfs_quota_path,
        cfs_period_path=cfs_period_path,
    ).cpus
