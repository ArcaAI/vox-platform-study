"""E9 (harness) — the policy-auth failure line hashes the consultation id and logs the type."""

from __future__ import annotations

import pytest
from hope_obs import redact_id
from structlog.testing import capture_logs
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.services.api_client import ApiServiceError
from harness.temporal import activities
from harness.temporal.models import FetchPolicyInput

CONSULTATION = "consultation-99887-john-smith"


class _Api:
    async def get_policy(self, tenant_id: str, consultation_id: str | None = None) -> dict:
        raise ApiServiceError("apps/api /policy failed: Client error '401 Unauthorized' for url 'x'")


@pytest.mark.asyncio
async def test_policy_auth_failed_hashes_consultation_and_logs_error_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(activities, "_api_client", lambda s: _Api())

    with capture_logs() as logs:
        with pytest.raises(ApplicationError):
            await ActivityEnvironment().run(
                activities.fetch_policy,
                FetchPolicyInput(tenant_id="t-1", consultation_id=CONSULTATION),
            )

    (line,) = [entry for entry in logs if entry["event"] == "harness.policy_auth_failed"]
    assert line["consultation"] == redact_id(CONSULTATION)
    assert line["tenant_id"] == "t-1"
    assert line["error_type"] == "ApiServiceError"
    assert CONSULTATION not in str(logs)
    assert "error" not in line
