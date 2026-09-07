"""TASK-892 Lane C3 — guardrail refuses to silently run without internal auth.

`INTERNAL_ACCESS_TOKEN` absent or empty from `hope-secrets` means every
gateway-bound internal call (`effective-config` pull, service-release
registration) 401s and the process falls back to compiled defaults instead of
its resolved tenant -> SYSTEM configuration (README.md S2.5). The `optional:
true` Secret binding let both containers start happily with the token unset,
which is the actual defect this covers: in-cluster the service must refuse to
start, and even in local dev an absent/empty token must never look like a
silent success the way an empty `X-Service-Token` deliberately does.

RED: written before `_assert_internal_access_token` / `_in_cluster_environment`
exist in `guardrail.main`.

The assertion is exercised two ways:

* Directly, as a hermetic unit test of the decision function — no Redis/DB/app
  construction needed, since it is pure env-in / raise-or-log-out.
* Once through the real `app.router.lifespan_context(app)` entry point, to
  prove it is actually wired into the startup path guardrail.main.lifespan()
  runs — not just present as dead code. This is safe without mocking Redis/DB
  because the assertion lives before any I/O in lifespan() (see main.py).
"""

from __future__ import annotations

import pytest
from pydantic import SecretStr
from structlog.testing import capture_logs

from guardrail.core.config import Settings
from guardrail.main import create_app


def _settings_with_token(token: str) -> Settings:
    settings = Settings()
    settings.internal_access_token = SecretStr(token)
    return settings


# ── Unit tests: the decision function itself ──


def test_absent_token_in_cluster_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """Absent token + NODE_ENV=production => refuse to start, naming the variable."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CI", "false")
    settings = _settings_with_token("")

    with pytest.raises(RuntimeError, match="INTERNAL_ACCESS_TOKEN"):
        _assert_internal_access_token(settings)


def test_empty_string_token_in_cluster_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """An explicit empty string is exactly as wrong as absent — same refusal."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CI", "false")
    settings = _settings_with_token("")  # explicit empty, not merely unset

    with pytest.raises(RuntimeError, match="INTERNAL_ACCESS_TOKEN"):
        _assert_internal_access_token(settings)


def test_absent_token_via_ci_truthy_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """CI truthy is the other half of "in-cluster" per hope_env's own posture."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "test")
    monkeypatch.setenv("CI", "true")
    settings = _settings_with_token("")

    with pytest.raises(RuntimeError, match="INTERNAL_ACCESS_TOKEN"):
        _assert_internal_access_token(settings)


def test_absent_token_local_dev_logs_once_and_does_not_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Local dev: exactly one error-level log naming the variable; never raises."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("CI", "false")
    settings = _settings_with_token("")

    with capture_logs() as logs:
        _assert_internal_access_token(settings)  # must not raise

    error_logs = [entry for entry in logs if entry.get("log_level") == "error"]
    assert len(error_logs) == 1, f"expected exactly one error log, got {error_logs}"
    assert error_logs[0]["event"] == "guardrail.internal_token.missing"
    assert error_logs[0].get("variable") == "INTERNAL_ACCESS_TOKEN"


def test_token_present_starts_silently_in_cluster(monkeypatch: pytest.MonkeyPatch) -> None:
    """A real token => no raise, no log, in-cluster."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CI", "false")
    settings = _settings_with_token("a-real-token")

    with capture_logs() as logs:
        _assert_internal_access_token(settings)  # must not raise

    assert logs == []


def test_token_present_starts_silently_local_dev(monkeypatch: pytest.MonkeyPatch) -> None:
    """A real token => no raise, no log, local dev too."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "development")
    monkeypatch.setenv("CI", "false")
    settings = _settings_with_token("a-real-token")

    with capture_logs() as logs:
        _assert_internal_access_token(settings)  # must not raise

    assert logs == []


def test_placeholder_sentinel_treated_as_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """`CHANGE_ME` is the unfilled-secret sentinel (hope_env.placeholders) —
    exactly as unconfigured as an empty string, never accepted as real."""
    from guardrail.main import _assert_internal_access_token

    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CI", "false")
    settings = _settings_with_token("CHANGE_ME")

    with pytest.raises(RuntimeError, match="INTERNAL_ACCESS_TOKEN"):
        _assert_internal_access_token(settings)


# ── Integration: actually wired into guardrail.main.lifespan() ──


async def test_lifespan_refuses_to_start_when_token_missing_in_cluster(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real startup path raises before any I/O (no Redis/DB needed here)."""
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "")
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CI", "false")

    app = create_app()

    with pytest.raises(RuntimeError, match="INTERNAL_ACCESS_TOKEN"):
        async with app.router.lifespan_context(app):
            pass


async def test_lifespan_starts_when_token_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real startup path proceeds normally once a token is configured."""
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "a-real-shared-token")
    monkeypatch.setenv("GUARDRAIL_DB_CONFIG_ENABLED", "false")

    import guardrail.core.effective_config as effective_config_module
    import guardrail.main as main_module

    monkeypatch.setattr(
        effective_config_module,
        "EffectiveConfigClient",
        lambda *, base_url, token: object(),
    )
    monkeypatch.setattr(main_module, "start_registration", lambda **kwargs: None)

    app = main_module.create_app()

    class _NoopJobProcessor:
        async def stop(self) -> None:
            return None

    app.state.job_processor = _NoopJobProcessor()

    async with app.router.lifespan_context(app):
        pass  # no exception => started
