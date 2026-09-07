"""TASK-892 C3/D-3 — an absent internal token must never fail OPEN in silence.

`INTERNAL_ACCESS_TOKEN` is absent from `hope-secrets` in `hope-v2-dev` and the
container binds it `optional: true`, so `apps/nlp` started happily with the
variable unset and every gateway-bound internal call 401'd. The gateway's own
log for the incident window is the control experiment: `effective-config` for
`harness` 200s (it has its token), for `nlp` and `guardrail` 401s. Both services
then served COMPILED DEFAULTS in place of their resolved tenant -> SYSTEM
configuration, which rule 09 §Tenant-first resolution makes a correctness fault,
not noise — and nothing said so out loud.

Two behaviours are pinned here:

* deployed (`NODE_ENV=production`, or a CI-shaped host-env-only process) —
  refuse to start;
* local dev — one `error`-level line naming the variable. Not silence, and not
  a refusal that would make a laptop useless.

The EMPTY string gets the identical treatment to absent. `apps/nlp` reads an
empty `X-Service-Token` as the dev-mode auth bypass, so "empty" is the single
most dangerous value this variable can hold, and `hope-secrets` already carries
one empty service-token key (§2.6, D-6).
"""

from __future__ import annotations

import logging

import pytest
from pydantic import SecretStr

from nlp.core.config import settings
from nlp.core.internal_auth import (
    INTERNAL_ACCESS_TOKEN_VAR,
    MissingInternalAccessToken,
    assert_internal_access_token,
    is_deployed,
)

DEPLOYED = {"NODE_ENV": "production", "CI": ""}
CI_JOB = {"NODE_ENV": "test", "CI": "true"}
LAPTOP = {"NODE_ENV": "development", "CI": ""}


@pytest.fixture()
def token(monkeypatch):
    def _set(value: str):
        monkeypatch.setattr(
            settings.service, "internal_access_token", SecretStr(value), raising=False
        )

    return _set


class TestIsDeployed:
    def test_production_is_deployed(self) -> None:
        assert is_deployed({"NODE_ENV": "production"}) is True

    def test_the_dev_cluster_is_deployed(self) -> None:
        # THE regression that matters. `base/config/platform.env` sets
        # NODE_ENV=production, but `overlays/dev` PATCHES the generated ConfigMap
        # to NODE_ENV=development — verified against the live
        # `hope-platform-config` in hope-v2-dev on 2026-09-07. A rule keyed on
        # `production` is inert in exactly the cluster where the token is missing.
        assert is_deployed({"NODE_ENV": "development", "DEPLOYMENT_ENVIRONMENT": "dev"}) is True

    def test_a_ci_shaped_process_is_NOT_deployed(self) -> None:
        # A CI *test* job is not a deployment. `DEPLOYMENT_ENVIRONMENT` is unset
        # there, which is the whole point of using it as the discriminator.
        assert is_deployed({"CI": "true"}) is False
        assert is_deployed({"CI": "1"}) is False

    def test_the_hermetic_test_suite_is_NOT_deployed(self) -> None:
        # `.gitlab/ci/test.yml` sets NODE_ENV=test AND CI=true on every Python
        # job, so `CI` alone cannot mean "deployed" without the fail-closed
        # posture taking down the very suite that proves it works. `NODE_ENV=test`
        # is the run declaring itself a test, and it wins.
        assert is_deployed(CI_JOB) is False

    def test_a_laptop_is_not_deployed(self) -> None:
        assert is_deployed(LAPTOP) is False
        assert is_deployed({}) is False


class TestDeployedRefusesToStart:
    def test_an_absent_token_raises(self, token) -> None:
        token("")
        with pytest.raises(MissingInternalAccessToken) as excinfo:
            assert_internal_access_token(environ=DEPLOYED)
        assert INTERNAL_ACCESS_TOKEN_VAR in str(excinfo.value)

    def test_a_whitespace_only_token_raises(self, token) -> None:
        token("   ")
        with pytest.raises(MissingInternalAccessToken):
            assert_internal_access_token(environ=DEPLOYED)

    def test_the_unfilled_placeholder_raises(self, token) -> None:
        # `.env.sample` ships `INTERNAL_ACCESS_TOKEN=CHANGE_ME`, and every
        # outbound call already treats the sentinel as no credential
        # (`hope_env.real_secret`), so it must not pass this gate either.
        token("CHANGE_ME")
        with pytest.raises(MissingInternalAccessToken):
            assert_internal_access_token(environ=DEPLOYED)

    def test_the_dev_cluster_raises(self, token) -> None:
        # The hope-v2-dev pod environment, exactly as the live ConfigMap sets it.
        token("")
        with pytest.raises(MissingInternalAccessToken):
            assert_internal_access_token(
                environ={"NODE_ENV": "development", "DEPLOYMENT_ENVIRONMENT": "dev"}
            )

    def test_a_real_token_starts_silently(self, token, caplog) -> None:
        token("s3cr3t-shared-internal-token")
        with caplog.at_level(logging.ERROR):
            assert_internal_access_token(environ=DEPLOYED)
        assert caplog.records == []


class TestLocalDevWarnsLoudly:
    def test_it_logs_exactly_one_error_naming_the_variable(self, token, caplog) -> None:
        token("")
        with caplog.at_level(logging.ERROR):
            assert_internal_access_token(environ=LAPTOP)
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert len(errors) == 1
        assert INTERNAL_ACCESS_TOKEN_VAR in errors[0].getMessage()

    def test_the_hermetic_suite_does_not_refuse_to_start(self, token) -> None:
        token("")
        assert_internal_access_token(environ=CI_JOB)  # must not raise

    def test_a_real_token_is_silent(self, token, caplog) -> None:
        token("s3cr3t-shared-internal-token")
        with caplog.at_level(logging.ERROR):
            assert_internal_access_token(environ=LAPTOP)
        assert caplog.records == []


class TestWiredIntoTheEntryPoint:
    def test_get_app_refuses_when_deployed_without_a_token(self, token, monkeypatch) -> None:
        # The container's ENTRYPOINT is `uvicorn --factory nlp.app:get_app`, so
        # the factory IS the start path: raising here is what "refuses to start"
        # means for this service.
        token("")
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.delenv("CI", raising=False)

        from nlp.app import get_app

        with pytest.raises(MissingInternalAccessToken):
            get_app()
