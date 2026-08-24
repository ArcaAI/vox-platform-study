"""The connection a DISCOVERY probe is performed against.

Deliberately a separate wire type from `requests.ProviderOverride`, for one
reason that is load-bearing rather than stylistic: ``ProviderOverride.api_key``
is REQUIRED, because that type exists to carry a CREDENTIAL and a request that
claims one must have one. A discovery probe is the opposite case — a keyless
self-hosted engine (Ollama, a bare LM Studio) is the NORMAL shape, and the
gateway's resolver deliberately injects nothing for a keyless row so that a
``baseUrl`` can never be mistaken for a credential
(`.claude/rules/09-infrastructure-devops.md` §"Tenant-first resolution & BYO").

So the probe needs a type whose credential is genuinely optional and whose
endpoint is genuinely required. Widening ``ProviderOverride.api_key`` to
``None`` instead would have made every generation path's fail-closed credential
guard (`core/connection.require_api_key`) express an optional value, which is
precisely the guarantee that lane must not lose.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, SecretStr


class ProbeConnection(BaseModel):
    """One engine to enumerate, as the gateway's cascade resolved it.

    ``api_key`` is a ``SecretStr`` so it never surfaces via ``repr()``/``str()``/
    ``model_dump()``/logging — an adapter calls ``.get_secret_value()`` at the
    single point it hands the key to its client, and the probe RESPONSE
    (`ProviderInfo`) carries no credential field at all.
    """

    base_url: str = Field(..., min_length=1)
    api_key: SecretStr | None = None


class ProviderProbeRequest(BaseModel):
    """Body of ``POST /providers/probe``.

    ``connections`` is keyed by REGISTRY KEY (``lm-studio``, ``ollama``, …), the
    same identity ``GET /providers`` stamps and the gateway's discovery merge
    joins on. A registered provider with no entry here is probed exactly as
    ``GET /providers`` probes it (the process's own last-observed endpoint), so
    the connection-aware surface is strictly additive.
    """

    connections: dict[str, ProbeConnection] = Field(default_factory=dict)
