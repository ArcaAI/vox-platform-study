"""lane B — the env surface `apps/text` is allowed to have.

This is the lock test for the config-plane collapse. Before it, `Settings`
reached 121 pydantic fields: eight parallel per-provider blocks (base_url /
api_key / default_model / timeout / concurrency / tpm / rpm), three separate
spellings of the same four resilience concepts (`TEXT_CB_*`, `TEXT_QUEUE_*`,
`TEXT_JUDGE_*`), and a 20-name `TEXT_V2_*` transition alias window.

None of that is a bootstrap floor. `.claude/rules/09-infrastructure-devops.md`
Tiers: a variable stays in `env` only when it is required *to
reach* the config source — "the only sanctioned defaults are bootstrap TRANSPORT
addresses". Everything else is a connection row (`AiProviderConnection`), a
selection (`AiTaskDefault`), a runtime profile (`AiRuntimeProfile`), a
`global-kv` knob or a kill-switch — and `apps/text` is a STATELESS gateway, so
all of it arrives injected per request or pulled from
`/internal/effective-config`, never read from the process environment.

The test enumerates the ACTUAL pydantic field tree rather than grepping for
names, so a field re-added under any alias fails here. A new env var in this
service is therefore a deliberate act with an owner decision behind it, not a
drive-by `Field(...)`.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings

from text.core.config import Settings

#: Every env-reachable pydantic field `apps/text` may declare, dotted by
#: sub-config. Each is a bootstrap-floor value: the address of a thing the
#: process must reach before any config plane can answer, the credential it
#: authenticates those hops with, or the PHI-safe-telemetry boot guard.
SANCTIONED_FIELDS: frozenset[str] = frozenset(
    {
        # --- process identity -------------------------------------------------
        "port",  # TEXT_PORT
        "log_level",  # TEXT_LOG_LEVEL — needed before any client exists
        # --- bootstrap transport (addresses, not choices) ---------------------
        "gateway_url",  # TEXT_GATEWAY_URL — where the control plane lives
        "redis_url",  # TEXT_REDIS_URL
        "otel_exporter_endpoint",  # TEXT_OTEL_EXPORTER_ENDPOINT
        "external_guardrail.base_url",  # TEXT_EXTERNAL_GUARDRAIL_BASE_URL
        # --- the one shared internal credential (owner decision D-D) ----------
        "internal_access.token",  # INTERNAL_ACCESS_TOKEN
        # --- PHI-safe telemetry boot guard ------------------------------------
        "telemetry_phi_guard.node_env",  # NODE_ENV
        "telemetry_phi_guard.genai_capture_message_content",
    }
)


def _walk(model: type[BaseSettings], prefix: str = "") -> set[str]:
    """Every leaf field of the settings tree, dotted by sub-config name."""
    found: set[str] = set()
    for name, field in model.model_fields.items():
        annotation = field.annotation
        if isinstance(annotation, type) and issubclass(annotation, BaseSettings):
            found |= _walk(annotation, f"{prefix}{name}.")
        else:
            found.add(f"{prefix}{name}")
    return found


class TestEnvSurface:
    def test_settings_declares_only_bootstrap_floor_fields(self) -> None:
        """No env field beyond the sanctioned bootstrap floor."""
        actual = _walk(Settings)
        assert actual - SANCTIONED_FIELDS == set(), (
            "apps/text declares env fields outside the bootstrap floor. "
            "A provider connection belongs in AiProviderConnection, a model in "
            "AiTaskDefault, capacity/hyperparameters in AiRuntimeProfile, a "
            "platform knob in global-kv and a switch in redis-flag — see "
            ".claude/rules/09-infrastructure-devops.md §Configuration Tiers."
        )

    def test_every_sanctioned_field_still_exists(self) -> None:
        """The floor is exact in both directions — no stale entry above."""
        assert SANCTIONED_FIELDS - _walk(Settings) == set()

    def test_surface_is_at_most_twelve_variables(self) -> None:
        """Nine pydantic fields, plus CI / HOPE_SECRETS_DIR / HOSTNAME read by
        `hope_env` and the service-registration helper = twelve variables."""
        assert len(_walk(Settings)) <= 9


class TestNoProviderPlane:
    """The eight per-provider blocks are gone, not merely renamed."""

    def test_no_provider_sub_configs(self) -> None:
        provider_names = {
            "ollama",
            "azure",
            "bedrock",
            "openai",
            "anthropic",
            "vertex",
            "openai_compat",
            "vllm",
            "llama_cpp",
            "sarvam",
            "tei_embed",
        }
        assert provider_names & set(Settings.model_fields) == set()

    def test_no_credential_endpoint_or_model_field_anywhere(self) -> None:
        """No field may look like a credential, an endpoint or a model id."""
        banned_leaves = {"api_key", "default_model", "model", "endpoint", "region", "project"}
        offenders = {f for f in _walk(Settings) if f.rsplit(".", 1)[-1] in banned_leaves}
        assert offenders == set()

    def test_no_capacity_or_resilience_knobs(self) -> None:
        """Capacity, timeouts and breaker/queue budgets ride AiRuntimeProfile."""
        banned_leaves = {
            "timeout_s",
            "max_concurrent",
            "tpm_limit",
            "rpm_limit",
            "max_size",
            "max_wait_s",
            "failure_threshold",
            "recovery_timeout_s",
            "half_open_max_calls",
            "reset_timeout_s",
            "acquire_timeout_s",
            "max_retries",
            "retry_backoff_ms",
        }
        offenders = {f for f in _walk(Settings) if f.rsplit(".", 1)[-1] in banned_leaves}
        assert offenders == set()


class TestNoTransitionAliases:
    """The `TEXT_V2_*` window is closed — nothing in the repo reads the other
    side of it, so every alias was pure surface."""

    def test_no_v2_alias_survives(self) -> None:
        offenders: list[str] = []

        def scan(model: type[BaseSettings], prefix: str = "") -> None:
            for name, field in model.model_fields.items():
                annotation = field.annotation
                if isinstance(annotation, type) and issubclass(annotation, BaseSettings):
                    scan(annotation, f"{prefix}{name}.")
                    continue
                alias = field.validation_alias
                choices = getattr(alias, "choices", [alias])
                if any(isinstance(c, str) and "V2_" in c for c in choices):
                    offenders.append(f"{prefix}{name}")

        scan(Settings)
        assert offenders == []
