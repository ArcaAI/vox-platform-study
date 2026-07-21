"""Tests for the harness loop / gate-adapter configuration additions (Lane I).

The durable loop
needs the SMR/NLP/api base URLs, the (configurable) apps/api internal-harness
path prefix, the bounded-regen budget, and the gate SLA / escalation durations.
"""

from __future__ import annotations

import pytest

from harness.core.config import Settings

# HARNESS_* keys these tests assert *code defaults* for. Importing ``harness.main``
# (via the test conftest) eagerly loads the gitignored dev ``.env`` into
# ``os.environ`` (module-level ``app = create_app()`` -> ``get_settings()`` ->
# ``_load_dotenv_into_environ()``), so a dev box that points e.g. SMR at a
# non-standard port would otherwise leak into these default assertions.
_DEFAULTED_ENV_KEYS = (
    "HARNESS_SMR_BASE_URL",
    "HARNESS_NLP_BASE_URL",
    "HARNESS_API_BASE_URL",
    "HARNESS_API_INTERNAL_PREFIX",
    "HARNESS_MAX_REGEN",
    "HARNESS_GATE_SLA_SECONDS",
    "HARNESS_GATE_ESCALATION_SECONDS",
)


class TestLoopConfigDefaults:
    @pytest.fixture(autouse=True)
    def _hermetic_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Isolate the default assertions from any ambient ``.env`` override."""
        for key in _DEFAULTED_ENV_KEYS:
            monkeypatch.delenv(key, raising=False)

    def test_tool_service_base_urls_default_to_local_ports(self):
        s = Settings()
        assert s.smr_base_url == "http://localhost:8862"
        assert s.nlp_base_url == "http://localhost:8864"
        assert s.api_base_url == "http://localhost:8868"

    def test_api_internal_prefix_defaults_to_live_mount(self):
        # Lane G mounts the inbound endpoints under the global ``/api/v1`` prefix
        # (``@Controller('internal/harness')``), so the live default is the full
        # ``/api/v1/internal/harness`` path — the loop wires up out of the box.
        s = Settings()
        assert s.api_internal_prefix == "/api/v1/internal/harness"

    def test_regen_budget_and_gate_timers_have_safe_defaults(self):
        s = Settings()
        assert s.max_regen == 2
        assert s.gate_sla_seconds > 0
        assert s.gate_escalation_seconds > 0


class TestHarnessServiceToken:
    def test_harness_service_token_aliases_the_shared_service_token(self):
        # The same HARNESS_SERVICE_TOKEN guards inbound endpoints AND is presented
        # by the api_client to apps/api — one shared secret, exposed under the
        # name the contract uses.
        s = Settings(service_token="shared-secret")
        assert s.harness_service_token.get_secret_value() == "shared-secret"
        assert s.harness_service_token.get_secret_value() == s.service_token.get_secret_value()


class TestLoopConfigEnvOverride:
    def test_env_overrides_apply(self, monkeypatch):
        monkeypatch.setenv("HARNESS_MAX_REGEN", "5")
        monkeypatch.setenv("HARNESS_SMR_BASE_URL", "http://smr:9999")
        monkeypatch.setenv("HARNESS_API_INTERNAL_PREFIX", "/api/v1/internal/harness")
        s = Settings()
        assert s.max_regen == 5
        assert s.smr_base_url == "http://smr:9999"
        assert s.api_internal_prefix == "/api/v1/internal/harness"


class TestOptimisticDeliveryFlag:
    """The ``HARNESS_OPTIMISTIC_DELIVERY_ENABLED`` kill-switch.

    The FIRST key of the two-key optimistic gate (the second is the durable
    ``task-355-optimistic-delivery`` patch marker). It is read here, in NON-workflow
    settings, and snapshotted into ``HarnessGateConfig`` at workflow start so it stays
    deterministic across replay. Default OFF: unset / falsy ⇒ False.
    """

    @pytest.fixture(autouse=True)
    def _hermetic_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Isolate from any ambient dev ``.env`` value (eagerly loaded by conftest).
        monkeypatch.delenv("HARNESS_OPTIMISTIC_DELIVERY_ENABLED", raising=False)

    def test_defaults_off_when_unset(self):
        # (a) env unset ⇒ the gate-config build site sees False.
        assert Settings().optimistic_delivery_enabled is False

    @pytest.mark.parametrize("raw", ["true", "True", "TRUE", "1"])
    def test_truthy_env_enables(self, monkeypatch, raw):
        # (b)/(c) true/True/1 (case-insensitive) ⇒ True.
        monkeypatch.setenv("HARNESS_OPTIMISTIC_DELIVERY_ENABLED", raw)
        assert Settings().optimistic_delivery_enabled is True

    @pytest.mark.parametrize("raw", ["false", "False", "0"])
    def test_falsy_env_stays_off(self, monkeypatch, raw):
        # (c) false/0 ⇒ False (default-OFF preserved).
        monkeypatch.setenv("HARNESS_OPTIMISTIC_DELIVERY_ENABLED", raw)
        assert Settings().optimistic_delivery_enabled is False
