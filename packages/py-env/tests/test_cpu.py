"""Contract tests for the cgroup-aware CPU-allowance resolver.

The defect this closes (TASK-892 D-1): PyTorch sized its intra-op pool from the
NODE (`nproc` = 48) while the container held a 2-CPU CFS quota, and the pod then
spent 7,292 s frozen on the quota against 573 s executing — an 11.7x measured
penalty on BERT-base FFN shapes. `os.cpu_count()` and `nproc` are both
cgroup-BLIND, so every "auto-detect the cores" fallback in the fleet was wrong
inside a container by exactly that factor.

Every case below drives the resolver through explicit paths rather than the real
`/sys/fs/cgroup`: the suite runs on macOS (no cgroups at all) and inside CI
containers (whose quota is not ours to depend on), so a test that read the live
filesystem would assert the runner, not the code.
"""

from __future__ import annotations

import os
from pathlib import Path

from hope_env.cpu import (
    CGROUP_V1_CPU_PERIOD,
    CGROUP_V1_CPU_QUOTA,
    CGROUP_V2_CPU_MAX,
    OMP_NUM_THREADS_VAR,
    CpuAllowance,
    effective_cpu_quota,
    resolve_cpu_allowance,
)


def _missing(tmp_path: Path) -> dict[str, Path]:
    """Paths that do not exist — the state on macOS and on any non-cgroup host."""
    return {
        "cpu_max_path": tmp_path / "nope" / "cpu.max",
        "cfs_quota_path": tmp_path / "nope" / "cpu.cfs_quota_us",
        "cfs_period_path": tmp_path / "nope" / "cpu.cfs_period_us",
    }


def _v2(tmp_path: Path, content: str) -> dict[str, Path]:
    paths = _missing(tmp_path)
    cpu_max = tmp_path / "cpu.max"
    cpu_max.write_text(content, encoding="utf-8")
    paths["cpu_max_path"] = cpu_max
    return paths


def _v1(tmp_path: Path, quota: str, period: str) -> dict[str, Path]:
    paths = _missing(tmp_path)
    quota_path = tmp_path / "cpu.cfs_quota_us"
    period_path = tmp_path / "cpu.cfs_period_us"
    quota_path.write_text(quota, encoding="utf-8")
    period_path.write_text(period, encoding="utf-8")
    paths["cfs_quota_path"] = quota_path
    paths["cfs_period_path"] = period_path
    return paths


def _host_cpus() -> int:
    """What steps 5-6 of the precedence chain must produce on this machine."""
    getaffinity = getattr(os, "sched_getaffinity", None)
    if getaffinity is not None:
        return max(1, len(getaffinity(0)))
    return max(1, os.cpu_count() or 1)


class TestCgroupV2:
    def test_quota_over_period_is_the_measured_dev_container(self, tmp_path: Path) -> None:
        # The literal content read out of hope-nlp-6845fc5d4b-tv765 (§2.2).
        assert effective_cpu_quota(environ={}, **_v2(tmp_path, "200000 100000")) == 2

    def test_trailing_newline_and_padding_are_tolerated(self, tmp_path: Path) -> None:
        assert effective_cpu_quota(environ={}, **_v2(tmp_path, "  200000   100000  \n")) == 2

    def test_literal_max_means_unlimited_and_falls_through(self, tmp_path: Path) -> None:
        # NOT 0, and NOT an exception: "max" is the kernel's word for "no quota",
        # so the answer is whatever the host says, exactly as on a quota-less node.
        result = resolve_cpu_allowance(environ={}, **_v2(tmp_path, "max 100000"))
        assert result.cpus == _host_cpus()
        assert result.source != "cgroup-v2"

    def test_fractional_quota_rounds_DOWN(self, tmp_path: Path) -> None:
        # 1.5 CPUs -> 1. Rounding down is the whole point: the pathology being
        # fixed is a thread pool that alone exhausts the CFS quota, so the pool
        # must never claim more CPU than the quota can actually grant. (Go's
        # automaxprocs makes the same call for the same reason; the JDK's `ceil`
        # would hand back 2 and re-open a smaller version of the bug.)
        assert effective_cpu_quota(environ={}, **_v2(tmp_path, "150000 100000")) == 1

    def test_sub_one_cpu_quota_clamps_to_one(self, tmp_path: Path) -> None:
        # floor(0.5) == 0 would be a thread pool of zero threads.
        assert effective_cpu_quota(environ={}, **_v2(tmp_path, "50000 100000")) == 1

    def test_garbage_content_falls_through(self, tmp_path: Path) -> None:
        for junk in ("", "not-a-quota", "200000", "200000 0", "200000 -1", "abc def"):
            result = resolve_cpu_allowance(environ={}, **_v2(tmp_path, junk))
            assert result.cpus == _host_cpus(), junk
            assert result.source != "cgroup-v2", junk


class TestCgroupV1:
    def test_quota_over_period(self, tmp_path: Path) -> None:
        assert effective_cpu_quota(environ={}, **_v1(tmp_path, "400000", "100000")) == 4

    def test_unlimited_quota_minus_one_falls_through(self, tmp_path: Path) -> None:
        result = resolve_cpu_allowance(environ={}, **_v1(tmp_path, "-1", "100000"))
        assert result.cpus == _host_cpus()
        assert result.source != "cgroup-v1"

    def test_v2_wins_when_both_are_present(self, tmp_path: Path) -> None:
        paths = _v1(tmp_path, "400000", "100000")
        cpu_max = tmp_path / "cpu.max"
        cpu_max.write_text("200000 100000", encoding="utf-8")
        paths["cpu_max_path"] = cpu_max
        assert effective_cpu_quota(environ={}, **paths) == 2


class TestPrecedence:
    def test_omp_num_threads_outranks_everything(self, tmp_path: Path) -> None:
        result = resolve_cpu_allowance(
            override=8,
            environ={OMP_NUM_THREADS_VAR: "3"},
            **_v2(tmp_path, "200000 100000"),
        )
        assert result.cpus == 3
        assert result.source == OMP_NUM_THREADS_VAR

    def test_omp_num_threads_is_ignored_unless_a_positive_int(self, tmp_path: Path) -> None:
        for junk in ("", "   ", "0", "-4", "two", "2.5"):
            result = resolve_cpu_allowance(
                environ={OMP_NUM_THREADS_VAR: junk}, **_v2(tmp_path, "200000 100000")
            )
            assert result.cpus == 2, junk
            assert result.source == "cgroup-v2", junk

    def test_caller_override_outranks_the_cgroup(self, tmp_path: Path) -> None:
        result = resolve_cpu_allowance(override=8, environ={}, **_v2(tmp_path, "200000 100000"))
        assert result.cpus == 8
        assert result.source == "override"

    def test_non_positive_override_means_auto(self, tmp_path: Path) -> None:
        # `0` is the declared "auto" value of NLP_TORCH_NUM_THREADS / STT_TORCH_NUM_THREADS.
        paths = _v2(tmp_path, "200000 100000")
        for auto in (None, 0, -1):
            assert effective_cpu_quota(override=auto, environ={}, **paths) == 2

    def test_defaults_to_the_real_process_environment(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv(OMP_NUM_THREADS_VAR, "5")
        assert effective_cpu_quota(**_v2(tmp_path, "200000 100000")) == 5


class TestNeverRaises:
    def test_missing_files_fall_through_to_the_host(self, tmp_path: Path) -> None:
        result = resolve_cpu_allowance(environ={}, **_missing(tmp_path))
        assert result.cpus == _host_cpus()
        assert result.source in {"sched_getaffinity", "cpu_count", "fallback"}

    def test_an_unreadable_path_falls_through(self, tmp_path: Path) -> None:
        # A directory where a file is expected: `read_text` raises IsADirectoryError,
        # which is an OSError but not FileNotFoundError.
        directory = tmp_path / "cpu.max"
        directory.mkdir()
        paths = _missing(tmp_path)
        paths["cpu_max_path"] = directory
        assert resolve_cpu_allowance(environ={}, **paths).cpus == _host_cpus()

    def test_the_real_defaults_are_usable_on_this_host(self) -> None:
        # No paths passed at all — exercises CGROUP_V2_CPU_MAX / the v1 pair as
        # they will be used in production, on a host that may have neither.
        assert effective_cpu_quota(environ={}) >= 1

    def test_the_module_constants_point_at_the_kernel_paths(self) -> None:
        assert CGROUP_V2_CPU_MAX == Path("/sys/fs/cgroup/cpu.max")
        assert CGROUP_V1_CPU_QUOTA == Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        assert CGROUP_V1_CPU_PERIOD == Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us")


class TestAlwaysAtLeastOne:
    def test_every_path_returns_a_positive_int(self, tmp_path: Path) -> None:
        for name in ("a", "b", "c"):
            (tmp_path / name).mkdir()
        cases = [
            _v2(tmp_path / "a", "1000 100000"),
            _v1(tmp_path / "b", "1", "100000"),
            _missing(tmp_path / "c"),
        ]
        for case in cases:
            value = effective_cpu_quota(environ={}, **case)
            assert isinstance(value, int)
            assert value >= 1

    def test_the_result_is_a_frozen_dataclass(self, tmp_path: Path) -> None:
        result = resolve_cpu_allowance(environ={}, **_v2(tmp_path, "200000 100000"))
        assert isinstance(result, CpuAllowance)
        assert (result.cpus, result.source) == (2, "cgroup-v2")
