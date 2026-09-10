"""TASK-941 R3 — the three per-TARGET legacy tokens are retired.

Owner decision D-D (2026-08-17) made ``INTERNAL_ACCESS_TOKEN`` the one credential
every outbound hop presents, keeping the per-target secrets "only as the fallback
for an environment that has not been migrated yet". That migration is done, and
the evidence was gathered before deleting anything:

  * ``HARNESS_TEXT_SERVICE_TOKEN`` / ``HARNESS_NLP_SERVICE_TOKEN`` /
    ``HARNESS_GUARDRAIL_SERVICE_TOKEN`` are set in NO cluster manifest
    (``hope-v2-deployment/deployment/k8s/**``: zero files each) and are
    EMPTY-valued in ``.env.dev``;
  * all three targets (apps/text, apps/nlp, apps/guardrail) accept
    ``INTERNAL_ACCESS_TOKEN`` in their auth middleware;
  * ``INTERNAL_ACCESS_TOKEN`` itself is set with a real value in ``.env.dev`` and
    on all eight Python deployables.

So ``first_real_secret(shared, legacy)`` already returned the shared token at every
one of these call sites, and removing the legacy half is behaviour-neutral rather
than a cutover.

WHAT IS **NOT** RETIRED, and must not be: ``service_token``
(``HARNESS_SERVICE_TOKEN``). It is not a per-target fallback at all — it guards
harness's own INBOUND internal endpoints (``accepted_service_tokens``) and is the
token the api_client presents to apps/api. The cluster still sets it. Deleting it
would break inbound auth, which is why this ticket distinguishes the two kinds of
token rather than sweeping every name that matches ``*_SERVICE_TOKEN``.
"""

from __future__ import annotations

import inspect

import pytest
from pydantic import ValidationError

from harness.core.config import Settings

RETIRED_FIELDS = ("text_service_token", "nlp_service_token", "guardrail_service_token")


class TestTheThreePerTargetFieldsAreGone:
    @pytest.mark.parametrize("field", RETIRED_FIELDS)
    def test_field_is_not_declared(self, field: str) -> None:
        assert field not in Settings.model_fields, (
            f"{field} is retired — the shared INTERNAL_ACCESS_TOKEN is the credential for every "
            "peer hop, and this field's env name is set in no manifest and empty in .env.dev."
        )

    @pytest.mark.parametrize("field", RETIRED_FIELDS)
    def test_env_name_is_rejected_rather_than_silently_ignored(self, field: str) -> None:
        # pydantic-settings with `extra` forbidden turns a stale env var into a loud
        # startup failure. If it is merely ignored, an operator who sets the old name
        # gets no token and no warning — the silent-401 mode this suite exists for.
        # `ValidationError`, not a bare `Exception`: pydantic-settings forbids extras
        # by default, and asserting the SPECIFIC error is what distinguishes "rejected"
        # from "ignored". A silently-ignored stale name is the real hazard — an operator
        # sets the old variable, nothing takes it, and no token is presented.
        with pytest.raises(ValidationError):
            Settings(**{field: "legacy"})


class TestTheSharedTokenIsTheOnlyCredentialOnPeerHops:
    def test_peer_service_token_needs_no_legacy_argument(self) -> None:
        # The three per-target sites now call it with nothing to fall back to.
        settings = Settings(internal_access_token="shared-tok")
        assert settings.peer_service_token() == "shared-tok"

    def test_it_still_accepts_a_legacy_argument_for_the_api_hop(self) -> None:
        # `service_token` SURVIVES (harness→apps/api, and harness's own inbound
        # guard), so the parameter survives with it — narrowed, not removed.
        settings = Settings(internal_access_token="", service_token="api-tok")
        assert settings.peer_service_token(settings.service_token) == "api-tok"

    def test_shared_still_wins_over_the_surviving_legacy_token(self) -> None:
        settings = Settings(internal_access_token="shared-tok", service_token="api-tok")
        assert settings.peer_service_token(settings.service_token) == "shared-tok"

    def test_no_token_when_nothing_is_configured(self) -> None:
        assert Settings(internal_access_token="", service_token="").peer_service_token() == ""

    def test_the_legacy_parameter_is_optional_in_the_signature(self) -> None:
        # Guards the shape rather than one call: a required parameter would force
        # every per-target site to invent an empty SecretStr to pass.
        sig = inspect.signature(Settings.peer_service_token)
        assert sig.parameters["legacy"].default is not inspect.Parameter.empty
