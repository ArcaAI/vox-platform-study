"""lane B — BYO provider credentials for the harness worker.

WHY THIS MODULE EXISTS (the delivery design, in one place).

The harness judge and the hybrid retriever both need a vendor credential, and
both run inside a Temporal ACTIVITY. That rules out the two shipped BYO delivery
paths on its own:

1. **`resolveConnection` (a TypeScript call)** — unreachable. The harness holds
   no DB handle; the only `asyncpg` import in the tree is `eval/judge/selection`,
   which is lazy and offline-eval only.
2. **A `provider_overrides` envelope folded onto the request body** (how
   `apps/text` receives its credentials) — there is no inbound gateway request
   to fold anything into. The activity is scheduled by Temporal, not by HTTP.

A third candidate, a `connections` block on the effective-config PULL, is worse
than either: that route is platform-scope by construction — ONE snapshot per
process, TTL-cached, `service`-keyed and not tenant-keyed — so a per-tenant
credential on it is precisely the cardinality failure the pull/push split exists
to prevent. It also degrades to `env-fallback` on a control-plane error, which is
the opposite of what a credential must do.

What is left is the path this repo ALREADY uses for a credential consumed inside
a harness activity: `GET /internal/harness/mcp-token`. Its own docstring states
the rule this module obeys — *"the worker calls this INSIDE the activity that
performs the call, uses the token, and discards it; it is never put into workflow
state, activity inputs, or heartbeats, because Temporal history is durable
storage."* This module is that precedent generalised to the
`AiProviderConnection` plane.

REPLAY SAFETY. Nothing here touches the workflow. No activity input, activity
result, workflow input or heartbeat gains a field; the credential is a local
variable inside an activity body, and activity bodies are non-deterministic code
that replay never re-executes. `test_replay_compat` is therefore unaffected by
construction rather than by luck.

FAIL-CLOSED. Four outcomes, and the difference between two of them is the whole
security property:

* ``RESOLVED``    — a row supplied a credential. Use it.
* ``ABSENT``      — no tier has an opinion (no row, or a keyless row). Call the
                    endpoint UNAUTHENTICATED. That is the CORRECT state for an
                    in-boundary self-hosted endpoint (a local OpenAI-compatible
                    judge server, an unauthenticated dev Qdrant) and it is never
                    a reason to read an environment variable — there is no longer
                    one to read (see the dead `validation_alias` guards on
                    ``OpenAICompatJudgeConfig.api_key``,
                    ``AzureJudgeConfig.api_key`` and
                    ``RetrievalConfig.qdrant_api_key``).
* ``DENIED``      — the tenant VETOED this ``(service, provider)`` by disabling
                    its row, or the platform-default entitlement is not granted.
                    Fail closed: degrade the consumer. NEVER fall through to
                    another tier or another provider.
* ``UNAVAILABLE`` — the gateway could not answer. Fail closed. A fault must never
                    be read as "no opinion", or a Vault outage silently downgrades
                    an authenticated call to an unauthenticated one.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from pydantic import SecretStr


class CredentialOutcome(StrEnum):
    """The four wire outcomes (see the module docstring for the contract)."""

    RESOLVED = "resolved"
    ABSENT = "absent"
    DENIED = "denied"
    UNAVAILABLE = "unavailable"


class CredentialUnavailable(RuntimeError):
    """A credential could not be resolved and the consumer must fail closed.

    Raised (never returned) so it lands in the ``except`` an activity already has
    around its client construction, degrading the sensor exactly like an
    un-buildable judge or a down retrieval backend does today.
    """


#: Harness judge TRANSPORT -> the `AiProviderConnection.provider` that serves it.
#:
#: This is not an invention: it mirrors the sub-config split `JudgeConfig`
#: already has. `build_judge_client` routes `openai_compat`, `ollama`, `vllm` and
#: `llama-cpp` to ONE `OpenAICompatJudgeClient` reading ONE
#: `HARNESS_JUDGE_OPENAI_COMPAT_*` block, so they share ONE connection row —
#: exactly the `provider='openai-compat'` row the owner directive names. `azure`
#: and `bedrock` have their own blocks and keep their own rows.
JUDGE_CONNECTION_PROVIDER: dict[str, str] = {
    "openai_compat": "openai-compat",
    "ollama": "openai-compat",
    "vllm": "openai-compat",
    "llama-cpp": "openai-compat",
    "azure": "azure",
    "bedrock": "bedrock",
}


def connection_provider_for_judge(judge_provider: str) -> str:
    """The connection row that serves ``judge_provider``.

    An UNKNOWN transport passes through unchanged rather than being guessed into
    one of the known blocks: a future engine gets its own row (which then simply
    resolves ``ABSENT`` until an admin writes one), never another provider's
    credential.
    """
    return JUDGE_CONNECTION_PROVIDER.get(judge_provider, judge_provider)


@dataclass(frozen=True)
class ProviderCredential:
    """One resolved connection, or the reason there is none.

    ``api_key`` is a ``SecretStr`` so the value survives neither ``repr()`` nor a
    structlog field nor an accidental ``json.dumps`` — the three ways a secret
    reaches a durable store without anyone deciding to put it there.
    """

    outcome: CredentialOutcome
    api_key: SecretStr | None = None
    base_url: str | None = None
    region: str | None = None
    api_version: str | None = None
    deployment_name: str | None = None
    model: str | None = None
    #: 'tenant' | 'platform'. DERIVED gateway-side from the row that supplied the
    #: credential; carried here for observability only and never re-stamped.
    funding: str | None = None
    #: Cause for DENIED / UNAVAILABLE. Never key material.
    reason: str = ""

    @property
    def usable(self) -> bool:
        """True when the consumer may proceed — with a credential, or without one."""
        return self.outcome in (CredentialOutcome.RESOLVED, CredentialOutcome.ABSENT)

    @property
    def secret(self) -> str | None:
        """The plaintext key, or None. The ONLY unwrapping point."""
        return self.api_key.get_secret_value() if self.api_key is not None else None

    def raise_if_unusable(self, *, service: str, provider: str) -> None:
        """Fail closed on DENIED / UNAVAILABLE.

        The message names the ``(service, provider)`` and the reason and NOTHING
        else — a credential-resolution error string can echo the payload a
        secrets backend choked on.
        """
        if self.usable:
            return
        raise CredentialUnavailable(
            f"no usable credential for {service}/{provider} "
            f"({self.outcome.value}{': ' + self.reason if self.reason else ''})"
        )

    @classmethod
    def unavailable(cls, reason: str) -> ProviderCredential:
        """The fail-closed constructor used for every fault path."""
        return cls(outcome=CredentialOutcome.UNAVAILABLE, reason=reason)

    @classmethod
    def from_payload(cls, payload: Any) -> ProviderCredential:
        """Parse the gateway's response, failing CLOSED on anything unexpected.

        An unrecognised ``outcome`` is UNAVAILABLE, not ``absent``: a contract the
        client does not understand is a fault, and a fault must never present as
        "no opinion". Same reason a non-dict body does.
        """
        if not isinstance(payload, dict):
            return cls.unavailable("malformed credential response")
        raw_outcome = payload.get("outcome")
        if not isinstance(raw_outcome, str):
            return cls.unavailable("unrecognised credential outcome")
        try:
            outcome = CredentialOutcome(raw_outcome)
        except ValueError:
            return cls.unavailable("unrecognised credential outcome")

        if outcome is not CredentialOutcome.RESOLVED:
            reason = payload.get("reason")
            return cls(outcome=outcome, reason=reason if isinstance(reason, str) else "")

        key = payload.get("apiKey")
        return cls(
            outcome=outcome,
            api_key=SecretStr(key) if isinstance(key, str) and key else None,
            base_url=_str_or_none(payload.get("baseUrl")),
            region=_str_or_none(payload.get("region")),
            api_version=_str_or_none(payload.get("apiVersion")),
            deployment_name=_str_or_none(payload.get("deploymentName")),
            model=_str_or_none(payload.get("model")),
            funding=_str_or_none(payload.get("funding")),
        )


def _str_or_none(value: Any) -> str | None:
    """Non-empty strings only — "" is a value to some backends, so it must not
    masquerade as a configured one (the same rule `RetrievalConfig` applies to an
    empty Qdrant key)."""
    return value if isinstance(value, str) and value else None


def to_provider_overrides(
    credential: ProviderCredential, provider: str
) -> dict[str, dict[str, Any]] | None:
    """The ``provider_overrides`` envelope ``apps/text`` receives, or ``None``.

    Text holds no endpoint or credential of its own: every adapter,
    the self-hosted LM Studio one included, reads ``provider_overrides[provider]``
    (``text/core/connection.py::require_connection``) and answers a typed 503
    without it. The gateway injects that envelope on its own proxied calls; a
    harness activity calling Text DIRECTLY must fold the gateway-resolved
    connection in itself. Only a RESOLVED credential yields an envelope —
    ABSENT means "no row, nothing to inject" and the two fail-closed outcomes
    are the caller's to reject via :meth:`ProviderCredential.raise_if_unusable`
    BEFORE anything is sent.

    ``api_key`` is always present (``""`` when the row carries none): Text's
    ``ProviderOverride.api_key`` is a required field, and a keyless self-host
    row still has a ``base_url`` to deliver. Every other field travels only
    when set, so the wire shape stays byte-identical for a plain key.
    """
    if credential.outcome is not CredentialOutcome.RESOLVED:
        return None
    entry: dict[str, Any] = {"api_key": credential.secret or ""}
    for field in ("base_url", "region", "api_version", "deployment_name", "model", "funding"):
        value = getattr(credential, field)
        if value:
            entry[field] = value
    return {provider: entry}
