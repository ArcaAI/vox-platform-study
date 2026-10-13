"""The RSS recycle ceiling must sit under the container's memory limit.

A ceiling above the cgroup limit (the default 12 GiB vs an 8 GiB pod) can never fire:
the kernel OOM-kills first. The effective ceiling is clamped to 90 % of a readable
limit; with no readable limit, or a lower configured value, the configured value wins.
"""

from __future__ import annotations

import pytest

GIB = 1024 * 1024 * 1024


@pytest.fixture(autouse=True)
def _reset():
    from nlp.core import bounds, recycle

    bounds.reset_bounds()
    recycle.reset_recycle_guard()
    yield
    bounds.reset_bounds()
    recycle.reset_recycle_guard()


def test_effective_ceiling_clamps_to_ninety_percent_of_the_limit():
    from nlp.core.recycle import effective_rss_ceiling_mib

    assert effective_rss_ceiling_mib(12288, 8 * 1024) == int(8 * 1024 * 0.9)


def test_effective_ceiling_keeps_a_lower_configured_value():
    from nlp.core.recycle import effective_rss_ceiling_mib

    assert effective_rss_ceiling_mib(4096, 8 * 1024) == 4096


def test_effective_ceiling_without_a_limit_is_the_configured_value():
    from nlp.core.recycle import effective_rss_ceiling_mib

    assert effective_rss_ceiling_mib(12288, None) == 12288


def test_zero_stays_disabled_under_a_limit():
    from nlp.core.recycle import effective_rss_ceiling_mib

    assert effective_rss_ceiling_mib(0, 8 * 1024) == 0


def test_reads_cgroup_v2_memory_max(tmp_path):
    from nlp.core.recycle import cgroup_memory_limit_mib

    (tmp_path / "memory.max").write_text(f"{8 * GIB}\n")
    assert cgroup_memory_limit_mib(root=tmp_path) == 8 * 1024


def test_cgroup_v2_max_means_no_limit(tmp_path):
    from nlp.core.recycle import cgroup_memory_limit_mib

    (tmp_path / "memory.max").write_text("max\n")
    assert cgroup_memory_limit_mib(root=tmp_path) is None


def test_reads_cgroup_v1_limit(tmp_path):
    from nlp.core.recycle import cgroup_memory_limit_mib

    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "memory.limit_in_bytes").write_text(f"{4 * GIB}\n")
    assert cgroup_memory_limit_mib(root=tmp_path) == 4 * 1024


def test_cgroup_v1_unlimited_sentinel_means_no_limit(tmp_path):
    from nlp.core.recycle import cgroup_memory_limit_mib

    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "memory.limit_in_bytes").write_text("9223372036854771712\n")
    assert cgroup_memory_limit_mib(root=tmp_path) is None


def test_no_cgroup_files_means_no_limit(tmp_path):
    from nlp.core.recycle import cgroup_memory_limit_mib

    assert cgroup_memory_limit_mib(root=tmp_path) is None


def test_guard_recycles_under_the_clamped_ceiling():
    from nlp.core import bounds, recycle

    bounds.set_bounds(recycle_rss_mib=12288)
    fired: list[str] = []
    g = recycle.RecycleGuard(
        rss_reader=lambda: 7600.0,  # under 12 GiB, over 90 % of 8 GiB
        shutdown=fired.append,
        worker_count=1,
        memory_limit_mib=8 * 1024,
    )
    g.after_response()
    assert fired == ["rss"]
