"""vllm settings (pydantic-settings, ``VLLM_`` prefix).

ENV IS THE BOOTSTRAP FLOOR ONLY. What remains settable from the environment is what this
process needs to REACH its control plane and to be reached: the shared inbound/outbound
credential (``INTERNAL_ACCESS_TOKEN``, vault-kv), the gateway address
(``VLLM_API_GATEWAY_URL``), the Redis address the config invalidation channel lives on
(shared ``REDIS_URL``), where HuggingFace pulls land on this pod
(``VLLM_WEIGHTS_CACHE_DIR``), HuggingFace's own offline switch (``HF_HUB_OFFLINE`` — a
cluster pod never pulls), and WHICH pool this process is (``VLLM_POOL``, pod identity, C-4).
Port, log level and ``OTEL_*`` are read by the launcher and ``hope_obs``.

What is deliberately NOT here: any model selection (a client names ``model=<slug>`` and
the gateway resolves it — ``hope_vllm.spec``), and any engine SIZING — since TASK-1021
D-11 that lives on the model row (``engine.vramGiB`` / ``maxNumSeqs`` / ``enforceEager``
on the serving spec) and on the pool (``vllm.pools``), never in settings or env.

Control-plane knobs (``vllm.pools``, ``vllm.truncation.*``) are platform-only ``global-kv``
descriptors served over the effective-config route and overlaid by
``core/control_plane.py``; their env path is CLOSED with a dead ``validation_alias``
(``moved_alias``). The field defaults below ARE the descriptor defaults, so an empty or
unreachable control plane changes nothing.
"""

from __future__ import annotations

import copy
from typing import Any

from hope_env import hope_settings_sources, load_env, real_secret
from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from hope_vllm.core.control_plane import DEFAULT_POOLS, moved_alias, parse_pools
from hope_vllm.core.pools import PoolConfig

__all__ = ["DEFAULT_POOLS", "PoolNotConfiguredError", "Settings", "get_settings"]


class PoolNotConfiguredError(RuntimeError):
    """``VLLM_POOL`` names a pool ``vllm.pools`` does not declare — the process refuses to start."""

    def __init__(self, pool: str, declared: list[str]) -> None:
        super().__init__(
            f"VLLM_POOL={pool!r} is not declared in vllm.pools (declared: "
            f"{', '.join(declared) or 'none'}); refusing to start"
        )
        self.pool = pool


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

    # ── Which pool this process IS (C-4): a key of `vllm.pools`. Pod identity, so env —
    # a Deployment per pool sets it. A name the map does not declare refuses to start.
    pool: str = Field(default="default", min_length=1)

    # ── HuggingFace's own offline switch. A cluster pod runs with HF_HUB_OFFLINE=1: weights
    # come from the published models bucket only, and a model absent from it is a NAMED
    # refusal (MODEL_NOT_PUBLISHED), never an attempted pull.
    hf_hub_offline: bool = Field(default=False, validation_alias=AliasChoices("HF_HUB_OFFLINE"))

    # ── Pools — CONTROL PLANE (`vllm.pools`), read at every admission. The raw map; see
    # `pool_config()` for this process's entry.
    pools: dict[str, Any] = Field(
        default_factory=lambda: copy.deepcopy(DEFAULT_POOLS),
        validation_alias=moved_alias("VLLM_POOLS"),
    )

    # ── Truncation heuristic (vllm#53144 hook) — CONTROL PLANE (`vllm.truncation.*`),
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

    def pool_config(self) -> PoolConfig:
        """This process's pool. Raises :class:`PoolNotConfiguredError` when undeclared."""
        pools = parse_pools(self.pools)
        if self.pool not in pools:
            raise PoolNotConfiguredError(self.pool, sorted(pools))
        return pools[self.pool]

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
