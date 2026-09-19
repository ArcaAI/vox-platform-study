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
                    another tier.
                    D-1c added a machine-readable ``denial`` cause beside the
                    prose ``reason`` (see :class:`DenialCause`). TASK-991 OD-3 /
                    OD-4 retired its only branching consumer: the embeddings lane
                    has no tenant tier left to widen PAST, so nothing in this
                    module reads ``denial`` today. It stays part of the wire
                    contract because it is what the gateway sends and what a log
                    line needs in order to say WHY a call was refused.
* ``UNAVAILABLE`` — the gateway could not answer. Fail closed. A fault must never
                    be read as "no opinion", or a Vault outage silently downgrades
                    an authenticated call to an unauthenticated one.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from pydantic import SecretStr

if TYPE_CHECKING:  # pragma: no cover - import cycle guard, types only
    from harness.core.config import RetrievalConfig


class CredentialOutcome(StrEnum):
    """The four wire outcomes (see the module docstring for the contract)."""

    RESOLVED = "resolved"
    ABSENT = "absent"
    DENIED = "denied"
    UNAVAILABLE = "unavailable"


class DenialCause(StrEnum):
    """WHY a ``DENIED`` was denied — the gateway's machine-readable ``denial``.

    ``reason`` is English prose for a log line; this is the machine-readable
    field, and the two causes are genuinely different rules. NOTE (TASK-991
    OD-3 / OD-4): no consumer in this module branches on it any more — the
    embeddings chain that did was collapsed to a single platform lane — but the
    distinction below is still what the gateway MEANS by each denial:

    * ``TENANT_VETO``          — the tenant DISABLED its own row for this
                                 ``(service, provider)``. Per
                                 ``CONNECTION_ENABLED_SEMANTICS`` that blocks the
                                 pair in BOTH tiers and "the call fails rather
                                 than falling through to another provider", so a
                                 consumer with a fallback must NOT use it.
    * ``PLATFORM_ENTITLEMENT`` — the tenant has no opinion AND may not spend the
                                 platform's VENDOR account. The gate is scoped to
                                 cloud providers and says nothing about the
                                 platform's own self-hosted infrastructure. The
                                 embeddings lane no longer needs that reading:
                                 it resolves a self-host provider directly, which
                                 the gate never touches.

    An ABSENT or unrecognised value is ``None``, which every caller must read as
    "fail closed" — an older gateway that does not send the field must never be
    read as permission to widen.
    """

    TENANT_VETO = "tenant-veto"
    PLATFORM_ENTITLEMENT = "platform-entitlement"


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
    #: Every OTHER key of the row's validated `extraJson`, forwarded verbatim by
    #: the gateway minus the reserved (column-backed) ones. This is how the
    #: NON-SECRET half of a connection travels — `vector:qdrant`'s `collection`
    #: prefix — beside the secret half in `api_key`.
    #:
    #: Defaults to `{}` and is read defensively: a gateway that does not send the
    #: block (or sends a non-dict) yields "no extras", never an error. Absent
    #: extras must leave prior behaviour byte-identical.
    extras: dict[str, Any] = field(default_factory=dict)
    #: 'tenant' | 'platform'. DERIVED gateway-side from the row that supplied the
    #: credential; carried here for observability only and never re-stamped.
    funding: str | None = None
    #: Cause for DENIED / UNAVAILABLE. Never key material.
    reason: str = ""
    #: MACHINE-READABLE cause for DENIED (D-1c). `None` when the gateway
    #: did not send one, which is read as "fail closed" — see `DenialCause`.
    denial: DenialCause | None = None

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
            return cls(
                outcome=outcome,
                reason=reason if isinstance(reason, str) else "",
                denial=_denial_or_none(payload.get("denial")),
            )

        key = payload.get("apiKey")
        extras = payload.get("extras")
        return cls(
            outcome=outcome,
            api_key=SecretStr(key) if isinstance(key, str) and key else None,
            base_url=_str_or_none(payload.get("baseUrl")),
            region=_str_or_none(payload.get("region")),
            api_version=_str_or_none(payload.get("apiVersion")),
            deployment_name=_str_or_none(payload.get("deploymentName")),
            model=_str_or_none(payload.get("model")),
            extras=dict(extras) if isinstance(extras, dict) else {},
            funding=_str_or_none(payload.get("funding")),
        )

    def extra(self, key: str) -> str | None:
        """One non-empty STRING extra, or None.

        Same rule as `_str_or_none`: `""` is a value to some backends, so it must
        not masquerade as a configured one. A non-string extra (the validated
        `extraJson` admits numbers, booleans and arrays too) is not a name and is
        therefore not returned by this accessor.
        """
        return _str_or_none(self.extras.get(key))


def _denial_or_none(value: Any) -> DenialCause | None:
    """The gateway's ``denial`` discriminator, or ``None``.

    An UNRECOGNISED value is ``None``, never a guess: the field exists so a
    consumer can widen past one specific denial, and a cause this build does not
    understand must not be mistaken for that one.
    """
    if not isinstance(value, str):
        return None
    try:
        return DenialCause(value)
    except ValueError:
        return None


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
    for name in ("base_url", "region", "api_version", "deployment_name", "model", "funding"):
        value = getattr(credential, name)
        if value:
            entry[name] = value
    return {provider: entry}


# ===========================================================================
# D-1b / D-1c — folding a resolved connection onto `RetrievalConfig`
# ===========================================================================
#
# Both folds live HERE, beside the four-outcome contract, and both are used by
# BOTH construction sites (the Temporal `retrieve_context` activity and the
# `knowledge/ingest` + `knowledge/{id}` endpoints). That is not tidiness: a
# collection name derived in two places is a corpus a tenant can write to and
# never read back, which is exactly the class of defect this ticket is about.
#
# A fold applies on RESOLVED only. `ABSENT` (no tier has an opinion) leaves the
# platform floor in place; `DENIED` / `UNAVAILABLE` never reach a fold, because
# the CALLER rejects them first (`ProviderCredential.usable`) — a fault must
# never be quietly downgraded into "use the platform's endpoint".

#: The PLATFORM's own dense-embeddings server — the ONLY embeddings lane.
#:
#: TASK-991 OD-3 / OD-4 (owner decision, 2026-09-19): the embeddings MODEL and
#: the embeddings ENDPOINT are FIXED for every tenant. No tenant may change
#: either. They stay CONFIG — a platform admin writes them on the SYSTEM row —
#: and they are never a literal here.
#:
#: This is a DELIBERATE, owner-approved NARROWING of the repo's tenant-first
#: rule, of exactly the kind `00-project-context.md` admits as a documented
#: exception. It is not a rule violation, and a future reader must not "fix" it
#: back into a tenant → platform cascade. Two reasons, both silent-failure modes
#: rather than preferences:
#:
#: 1. The model and the stored vectors are ONE coupled artifact. Embed a corpus
#:    with one model and query it with another and the result is silent
#:    nonsense, not an error — no component downstream can tell that the
#:    neighbours it returned are meaningless.
#: 2. A platform-chosen model id sent to a TENANT's own account that has never
#:    heard of it fails PER TENANT at retrieval time, long after ingest wrote the
#:    vectors with something else.
#:
#: D-1c already gave the platform tier its own provider id, and that part is
#: unchanged: a platform default carried on the CLOUD `embeddings:openai` pair
#: is governed by the entitlement gate R6 (`featurePlatformDefaultCredential`,
#: granted on no plan), so every tenant's resolve came back `denied` and
#: retrieval degraded to empty context for everyone. `tei-embed` is in
#: `PLATFORM_SELF_HOST_PROVIDERS`, which the gate does not touch — the
#: platform's own server is infrastructure, not vendor spend — so it resolves
#: for every tenant whatever its plan says.
#:
#: The gateway enforces the other half of OD-3/OD-4:
#: `AiProviderConnectionService.assertEmbeddingsPlatformManaged` refuses a
#: TENANT-tier create/update for `service='embeddings'` with a 403, so a tenant
#: admin gets a refusal rather than a silently inert row, while a SUPER_ADMIN
#: still writes the SYSTEM row this constant names.
EMBEDDINGS_PLATFORM_PROVIDER = "tei-embed"

#: The connection row that serves the knowledge vector store. One provider under
#: `vector`, so there is nothing to map.
VECTOR_CONNECTION_PROVIDER = "qdrant"

#: The `extraJson` key the console writes for a tenant's collection prefix
#: (`provider-meta.ts`: "Collection prefix (optional)", placeholder `hope`).
VECTOR_COLLECTION_EXTRA = "collection"


def prefixed_collection(base: str, prefix: str | None) -> str:
    """``<prefix>_<base>``, or ``base`` when no prefix is configured.

    A PREFIX, not a replacement — that is what the console field promises the
    tenant admin ("Collection prefix"), and it keeps the platform's own
    collection name visible in the derived one. Surrounding whitespace and
    separator underscores are stripped so ``"hope"``, ``" hope "`` and ``"hope_"``
    all derive the same collection; a prefix that is blank after stripping is no
    prefix at all (``""`` must never mean ``"_knowledge_chunks"``).
    """
    cleaned = (prefix or "").strip().strip("_")
    return f"{cleaned}_{base}" if cleaned else base


def apply_vector_credential(
    retrieval: RetrievalConfig, credential: ProviderCredential | None
) -> RetrievalConfig:
    """Fold a resolved ``vector:qdrant`` row onto the retrieval config.

    Carries the credential, the tenant's own cluster URL when it brings one, and
    (D-1b) the ``collection`` prefix the console has offered since the card was
    written and nothing read. ``model_copy`` bypasses validation, which is the
    point: it is the ONLY way a credential enters (the env path is closed).
    """
    if credential is None or credential.outcome is not CredentialOutcome.RESOLVED:
        return retrieval
    update: dict[str, Any] = {"qdrant_api_key": credential.api_key}
    if credential.base_url:
        update["qdrant_url"] = credential.base_url
    collection = prefixed_collection(
        retrieval.collection, credential.extra(VECTOR_COLLECTION_EXTRA)
    )
    if collection != retrieval.collection:
        update["collection"] = collection
    return retrieval.model_copy(update=update)


def apply_embeddings_credential(
    retrieval: RetrievalConfig, credential: ProviderCredential | None
) -> RetrievalConfig:
    """Fold the resolved PLATFORM ``embeddings`` row onto the retrieval config.

    D-1c: the whole ``embeddings`` connection — endpoint, key AND model — was a
    write-only console surface, because ``resolveTenantCloudOverrides`` is only
    ever called for ``llm``/``stt``/``tts``. This is the read side.

    TASK-991 OD-3 / OD-4 then fixed WHOSE row can ever reach it:
    :func:`resolve_embeddings_credential` consults the platform tier ONLY, so
    the credential arriving here is always the SYSTEM ``embeddings:tei-embed``
    row and never a tenant's. Folding it is what makes the platform's selection
    the one every tenant embeds and queries with.

    Every field is optional and folds only when the row carries it, so a SYSTEM
    row that supplies just a key keeps the endpoint below it. ``model`` arrives
    as the row's ``extraJson.model`` (the gateway projects that key by name onto
    the wire's ``model`` field) — the platform admin's selection, never a
    substitute chosen here.
    """
    if credential is None or credential.outcome is not CredentialOutcome.RESOLVED:
        return retrieval
    update: dict[str, Any] = {"embeddings_api_key": credential.api_key}
    if credential.base_url:
        update["embeddings_base_url"] = credential.base_url
    if credential.model:
        update["embeddings_model"] = credential.model
    return retrieval.model_copy(update=update)


async def resolve_embeddings_credential(
    resolve: Callable[[str, str], Awaitable[ProviderCredential]],
) -> ProviderCredential:
    """The embeddings connection: the PLATFORM tier, and ONLY the platform tier.

    TASK-991 OD-3 / OD-4. This was a two-lane chain — the tenant's
    ``embeddings:openai`` row first, the platform's own server on absence. It is
    now ONE lane by owner decision: the endpoint, the key AND the model all come
    from the SYSTEM ``embeddings:tei-embed`` row, and no tenant row can override
    any of them. `EMBEDDINGS_PLATFORM_PROVIDER` carries the full rationale
    (coupled model/vectors; a platform model id on a tenant's own account fails
    at retrieval time rather than at ingest).

    THIS IS A DELIBERATE NARROWING of the tenant → platform cascade, not an
    oversight and not a rule violation: do not re-introduce a tenant lane here
    because the house rule reads tenant-first. The gateway now REFUSES the
    tenant-tier `embeddings` write such a lane would read, so re-adding one
    would resurrect a reader for rows that can no longer be written.

    Whatever the gateway answers is returned UNCHANGED, which preserves every
    fail-closed property of the four-outcome contract exactly:

    * ``RESOLVED``    the platform's endpoint, key and model. Use them.
    * ``ABSENT``      no SYSTEM row, or a keyless one → the platform floor,
                      called unauthenticated (local dev). The MODEL is still
                      fail-closed downstream — see `require_embeddings_model`.
    * ``DENIED`` /
      ``UNAVAILABLE`` fail closed. There is deliberately no branch that
                      downgrades either into "use something else": with one lane
                      there is nothing else left to use, which is the point.

    The caller supplies ``resolve`` so both construction sites (the Temporal
    activity and the ingest/delete endpoints) share ONE rule while keeping their
    own transports and their own monkeypatch seams.
    """
    return await resolve("embeddings", EMBEDDINGS_PLATFORM_PROVIDER)


def require_embeddings_model(retrieval: RetrievalConfig) -> str:
    """The resolved embeddings model id, or raise :class:`CredentialUnavailable`.

    D-1c retired the hardcoded ``"text-embedding-bge-m3"`` default:
    a model id is a SELECTION, which rule 09 §"No hardcoded configuration" keeps
    out of both a code literal and an environment variable. Its home is the
    connection row's ``extraJson.model``, and since TASK-991 OD-3 that is ONE
    row for every tenant: the SYSTEM ``embeddings:tei-embed`` row the seed
    writes. A tenant cannot supply a different one.

    Selection is ``failMode: closed``, so an unresolved model RAISES rather than
    substituting one. That property is UNCHANGED by OD-3 and must stay: nothing
    here invents a model, because embedding a corpus with a different model than
    the queries is a corpus that silently never matches, which is worse than a
    visible degrade.

    The DIMENSION deliberately stays on ``RetrievalConfig.embeddings_dim``: it
    describes the Qdrant COLLECTION as much as the model, a connection row has
    nowhere to declare one, and a mismatch surfaces as a Qdrant rejection — see
    the field comment in `core/config.py`.
    """
    model = (retrieval.embeddings_model or "").strip()
    if not model:
        raise CredentialUnavailable(
            "no embeddings model resolved for embeddings/"
            f"{EMBEDDINGS_PLATFORM_PROVIDER} "
            "(the SYSTEM connection row carries no extraJson.model)"
        )
    return model
