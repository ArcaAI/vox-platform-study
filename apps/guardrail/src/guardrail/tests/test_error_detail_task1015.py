"""E7 (guardrail) — 5xx bodies are generic; the cause lives in the log line, by type."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from structlog.testing import capture_logs

from guardrail.api.endpoints import jobs

SECRET = "patient John Smith MRN-99887 raw text"


class _ExplodingProcessor:
    async def get_job_status(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError(SECRET)

    async def list_jobs(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError(SECRET)

    async def cancel_job(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError(SECRET)

    async def get_job_stats(self, *args: object, **kwargs: object) -> None:
        raise RuntimeError(SECRET)


async def _call(name: str) -> tuple[HTTPException, list[dict]]:
    processor = _ExplodingProcessor()
    calls = {
        "status": lambda: jobs.get_job_status("j1", tenant_id="t", job_processor=processor),
        "list": lambda: jobs.list_jobs(tenant_id="t", job_processor=processor),
        "cancel": lambda: jobs.cancel_job("j1", tenant_id="t", job_processor=processor),
        "result": lambda: jobs.get_job_result("j1", tenant_id="t", job_processor=processor),
        "stats": lambda: jobs.get_job_stats(tenant_id="t", job_processor=processor),
    }
    with capture_logs() as logs:
        with pytest.raises(HTTPException) as info:
            await calls[name]()
    return info.value, logs


@pytest.mark.parametrize("name", ["status", "list", "cancel", "result", "stats"])
async def test_job_endpoints_return_generic_500_and_log_the_cause_by_type(name: str) -> None:
    exc, logs = await _call(name)

    assert exc.status_code == 500
    assert SECRET not in str(exc.detail)
    (line,) = [entry for entry in logs if entry["event"] == f"guardrail.jobs.{name}_failed"]
    assert line["log_level"] == "error"
    assert line["error_type"] == "RuntimeError"
    assert "exc_info" in line
