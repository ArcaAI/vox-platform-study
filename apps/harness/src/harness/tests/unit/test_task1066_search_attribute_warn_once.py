"""A missing HarnessTenantId search attribute warns once per process, not on every signal."""

from __future__ import annotations

from structlog.testing import capture_logs

from harness.api.endpoints import internal


def test_the_unavailable_warning_is_logged_once_per_process() -> None:
    internal._SEARCH_ATTRIBUTE_WARNED.clear()
    with capture_logs() as events:
        for n in range(5):
            internal._warn_search_attribute_unavailable(
                "harness.loop.signal_context_added.search_attribute_unavailable",
                consultation_id=f"c-{n}",
                error="no such attribute",
            )
            internal._warn_search_attribute_unavailable(
                "harness.document.start.search_attribute_unavailable",
                consultation_id=f"c-{n}",
                error="no such attribute",
            )
    warnings = [e for e in events if e["log_level"] == "warning"]
    assert len(warnings) == 1
    assert warnings[0]["event"].endswith("search_attribute_unavailable")
