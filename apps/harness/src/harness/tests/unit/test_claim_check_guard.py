"""Claim-check memory-store deployment guard (TASK-533 D-28).

``ClaimCheckConfig`` ships ``enabled=True`` + ``store="memory"``. That pairing is
correct for the hermetic suite and SINGLE-worker local dev, and the class docstring
has always said a MULTI-worker deploy MUST set ``store=s3`` — because the in-memory
fake is a per-process singleton, so a cross-worker activity retry raises
``ClaimCheckNotFound`` and loses the offloaded clinical blob.

Nothing enforced that MUST. These tests pin the guard:

* production-like ``HARNESS_ENVIRONMENT`` + offload enabled + ``store=memory``
  → hard error at settings construction (the worker never registers on the queue)
* development → constructs fine (the worker logs a warning instead; see
  ``harness.temporal.worker._assert_claim_check_store_is_deployable``)
* ``store=s3`` or ``enabled=False`` → always fine, in every environment

The pre-existing default assertion in ``test_claim_check_config.py`` (``store ==
"memory"``) stays green: this is a guard, not a default change.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from harness.core.config import ClaimCheckConfig, Settings

# Every env var that can perturb the settings under test. Cleared before each case
# so assertions are hermetic regardless of the developer's ambient environment.
_GUARD_ENV = (
    "HARNESS_ENVIRONMENT",
    "HARNESS_CLAIM_CHECK_ENABLED",
    "HARNESS_CLAIM_CHECK_STORE",
    "HARNESS_CLAIM_CHECK_MIN_BYTES",
    "HARNESS_CLAIM_CHECK_BUCKET",
    "HARNESS_CLAIM_CHECK_ENDPOINT_URL",
    "HARNESS_CLAIM_CHECK_ACCESS_KEY",
    "HARNESS_CLAIM_CHECK_SECRET_KEY",
)

_PRODUCTION_LIKE = ("production", "prod", "staging", "PRODUCTION", "Prod")


def _clear(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in _GUARD_ENV:
        monkeypatch.delenv(var, raising=False)


class TestClaimCheckDeploymentGuard:
    @pytest.mark.parametrize("environment", _PRODUCTION_LIKE)
    def test_memory_store_in_production_is_rejected(
        self, environment: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _clear(monkeypatch)
        monkeypatch.setenv("HARNESS_ENVIRONMENT", environment)

        with pytest.raises(ValidationError) as excinfo:
            Settings()

        # The error must name the fix, not just the fault.
        message = str(excinfo.value)
        assert "HARNESS_CLAIM_CHECK_STORE" in message
        assert "s3" in message

    def test_memory_store_in_development_is_allowed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _clear(monkeypatch)

        settings = Settings()

        assert settings.environment == "development"
        assert settings.claim_check.store == "memory"

    @pytest.mark.parametrize("environment", _PRODUCTION_LIKE)
    def test_s3_store_is_allowed_in_production(
        self, environment: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _clear(monkeypatch)
        monkeypatch.setenv("HARNESS_ENVIRONMENT", environment)
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_STORE", "s3")

        settings = Settings()

        assert settings.claim_check.store == "s3"

    @pytest.mark.parametrize("environment", _PRODUCTION_LIKE)
    def test_disabled_offload_in_production_is_allowed(
        self, environment: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Nothing is offloaded, so the store is never dereferenced.
        _clear(monkeypatch)
        monkeypatch.setenv("HARNESS_ENVIRONMENT", environment)
        monkeypatch.setenv("HARNESS_CLAIM_CHECK_ENABLED", "false")

        settings = Settings()

        assert settings.claim_check.enabled is False

    def test_environment_is_normalised_to_lowercase(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _clear(monkeypatch)
        monkeypatch.setenv("HARNESS_ENVIRONMENT", "  Development  ")

        assert Settings().environment == "development"

    def test_claim_check_config_alone_keeps_the_memory_default(self) -> None:
        # The guard lives on Settings (it needs the deployment signal), so the
        # sub-config in isolation is unchanged — dev/test construct it directly.
        assert ClaimCheckConfig(_env_file=None).store == "memory"


class TestWorkerBootGuard:
    """The worker re-asserts at boot, and warns in dev where the validator stays quiet."""

    def test_worker_guard_raises_when_production_uses_memory_store(self) -> None:
        from harness.temporal.worker import _assert_claim_check_store_is_deployable

        settings = Settings(environment="development")
        # Force the unsafe pairing past the settings validator to prove the worker
        # guard is independent defence (a prod env var set after construction, a
        # settings object built in code, …).
        object.__setattr__(settings, "environment", "production")

        with pytest.raises(RuntimeError, match="HARNESS_CLAIM_CHECK_STORE"):
            _assert_claim_check_store_is_deployable(settings)

    def test_worker_guard_allows_development_memory_store(self) -> None:
        from harness.temporal.worker import _assert_claim_check_store_is_deployable

        settings = Settings(environment="development")

        # Returns cleanly; the warning is a log line, not an exception.
        assert _assert_claim_check_store_is_deployable(settings) is None
