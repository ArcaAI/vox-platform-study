"""vllm settings (pydantic-settings, ``VLLM_`` prefix).

ENV IS THE BOOTSTRAP FLOOR ONLY (TASK-1010 OD-6). What remains settable from the
environment is what this process needs to REACH its control plane and to be reached:
the shared inbound/outbound credential (``INTERNAL_ACCESS_TOKEN``, vault-kv), the
gateway address (``VLLM_API_GATEWAY_URL``), the Redis address the config
invalidation channel lives on (shared ``REDIS_URL``), and where HuggingFace pulls land
on this pod (``VLLM_WEIGHTS_CACHE_DIR``). Port, log level and ``OTEL_*`` are read by
the launcher and ``hope_obs``.

What is deliberately NOT here: any model selection. The model arrives with every
request as a resolved spec (``hope_vllm.spec``), built by the gateway from the tenant's
ASR Agent — an env var naming a model would be a hardcoded selection
(``.claude/rules/09-infrastructure-devops.md`` §No hardcoded configuration). There is no
HuggingFace token either: weights are pulled with the MODEL OWNER's registry credential
(``core/model_credentials.py``), never an ambient one.

The six vLLM engine / truncation knobs were env during the spike (V-2). They are now
platform-only ``global-kv`` descriptors ``asrVllm.*`` served over the effective-config
route and overlaid by ``core/control_plane.py``; their env path is CLOSED with a dead
``validation_alias`` (``moved_alias``) so a stale ConfigMap value cannot silently win.
The field defaults below ARE the descriptor defaults (OD-10), so an empty or unreachable
control plane changes nothing.
"""

from __future__ import annotations

from hope_env import hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from hope_vllm.core.control_plane import gpu_budget_fits, moved_alias


class Settings(BaseSettings):
    # Init > host env > secrets_dir (Vault Agent) > .env.<NODE_ENV> > default.
    settings_customise_sources = hope_settings_sources

    # NO `populate_by_name`: pydantic-settings would then also read the prefixed FIELD
    # name from the environment, re-opening every path `moved_alias` closed.
    model_config = SettingsConfigDict(env_prefix="VLLM_")

    # ── Inbound AND outbound credential (owner decision D-D): the ONE shared internal
    # token. Accepted inbound as `X-Service-Token`, presented as `X-Service-Token` on the
    # gateway's `/internal/*` routes. Unprefixed on purpose — it belongs to no single
    # service. Empty ⇒ inbound auth bypassed, but only when running locally.
    internal_access_token: SecretStr = Field(
        default=SecretStr(""), validation_alias=AliasChoices("INTERNAL_ACCESS_TOKEN")
    )

    # ── Where the control plane lives (env `VLLM_API_GATEWAY_URL`). BOOTSTRAP
    # TRANSPORT — the address of the config source, not config. Blank ⇒ no control
    # plane: platform knobs stay at their defaults and HuggingFace pulls fail closed
    # (no registry credential can be resolved).
    api_gateway_url: str = "http://localhost:8868/api/v1"

    # ── The Redis that carries `arca:config:invalidate`. Shared infrastructure, so the
    # bare name every service reads. Blank ⇒ no push invalidation; the effective-config
    # TTL (60 s ± 10 %) is then the only propagation path.
    redis_url: str = Field(default="", validation_alias=AliasChoices("REDIS_URL"))

    # ── Where a `sourceUri` (HuggingFace) pull lands on this pod — a PVC mount, pod
    # topology. Unset ⇒ huggingface_hub's own cache (`$HF_HOME/hub`; the image sets
    # HF_HOME). Published weights (`localPath`) are read in place and never copied here.
    weights_cache_dir: str | None = None

    # ── vLLM engine capacity — CONTROL PLANE (`asrVllm.engine.*`), read at engine BUILD.
    #: Fraction of the WHOLE GPU's memory each engine may claim (weights + KV/encoder
    #: cache). A time-sliced GPU has no memory isolation, so on a shared card this is the
    #: service's budget share, not "how much is free". 0.20 while ASR shares a 16 GB
    #: card (OD-10); raised per environment on the SYSTEM row, never in code.
    gpu_memory_utilization: float = Field(
        default=0.20,
        ge=0.05,
        le=0.95,
        validation_alias=moved_alias("VLLM_GPU_MEMORY_UTILIZATION"),
    )
    #: vLLM's running-batch cap — the ceiling on concurrent windows in one engine.
    max_num_seqs: int = Field(
        default=64, ge=1, le=1024, validation_alias=moved_alias("VLLM_MAX_NUM_SEQS")
    )
    #: Skip CUDA-graph capture (faster cold start, slower steady state).
    enforce_eager: bool = Field(default=False, validation_alias=moved_alias("VLLM_ENFORCE_EAGER"))
    #: Engines resident at once (one per runtime key), read at every eviction check.
    #: Each claims `gpu_memory_utilization`, so the product must fit one card.
    max_resident_engines: int = Field(
        default=1, ge=1, le=4, validation_alias=moved_alias("VLLM_MAX_RESIDENT_ENGINES")
    )

    # ── Truncation heuristic (vllm#53144 hook) — CONTROL PLANE (`asrVllm.truncation.*`),
    # read per request.
    truncation_min_chars_per_voiced_second: float = Field(
        default=3.0,
        ge=0.0,
        validation_alias=moved_alias("VLLM_TRUNCATION_MIN_CHARS_PER_VOICED_SECOND"),
    )
    truncation_voiced_dbfs: float = Field(
        default=-40.0,
        ge=-90.0,
        le=0.0,
        validation_alias=moved_alias("VLLM_TRUNCATION_VOICED_DBFS"),
    )

    @model_validator(mode="after")
    def _resident_engines_fit_one_gpu(self) -> Settings:
        if not gpu_budget_fits(self.max_resident_engines, self.gpu_memory_utilization):
            raise ValueError(
                f"max_resident_engines ({self.max_resident_engines}) × gpu_memory_utilization "
                f"({self.gpu_memory_utilization}) exceeds one GPU; lower either"
            )
        return self

    @property
    def accepted_service_tokens(self) -> tuple[str, ...]:
        """Every token accepted as inbound ``X-Service-Token`` (empty ⇒ none configured).

        ``real_secret`` maps the unfilled-secret sentinel onto "", so a ``CHANGE_ME``
        token is never accepted as a credential (``hope_env.placeholders``).
        """
        shared = real_secret(self.internal_access_token)
        return (shared,) if shared else ()

    def peer_service_token(self) -> str:
        """The token to PRESENT on the gateway's ``/internal/*`` routes.

        ``real_secret``, not ``.get_secret_value()``: the unfilled-secret sentinel is a
        NON-EMPTY string, and presenting ``CHANGE_ME`` is the trap that made every
        internal hop 401 (see ``hope_env.placeholders``).
        """
        return real_secret(self.internal_access_token)


def get_settings() -> Settings:
    """Load ``.env.<NODE_ENV>`` (host env wins) and build settings. Call once at startup."""
    load_env()
    return Settings()
