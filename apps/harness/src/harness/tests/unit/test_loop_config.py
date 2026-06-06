"""Tests for the harness loop / gate-adapter configuration additions (Lane I).

RED-first: written before the ``Settings`` additions exist. The durable loop
needs the SMR/NLP/api base URLs, the (configurable) apps/api internal-harness
path prefix, the bounded-regen budget, and the gate SLA / escalation durations.
"""

from __future__ import annotations

from harness.core.config import Settings


class TestLoopConfigDefaults:
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
