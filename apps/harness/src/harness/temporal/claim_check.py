"""Claim-check payloads for the Temporal history budget.

Temporal records EVERY activity input + output into an immutable workflow
history that is replayed on every worker pickup and is bounded by a ~50 MB
size budget (per-payload gRPC ceiling on top). The harness threads large
clinical blobs — the transcript, the assembled prompt, the generated note, the
RAG chunks — through many activities, and the bounded-regen loop multiplies
that, marching a long/heavily-regenerated encounter toward the budget.

The standard fix is the **claim-check pattern**: store the big blob OUT OF BAND
(self-hosted MinIO / S3-compatible) and pass a small, content-addressed
:class:`ClaimCheckRef` through the workflow instead. Activities dereference the
ref at the edge (all I/O lives in activities, never the deterministic workflow
body); the workflow only ever holds the small ref, so history stays flat
regardless of blob length or regen count.

Replay-safety posture: the ref fields
are **additive-optional** on the existing payloads and the store/load happen
**inside the existing activities**, so no new ``execute_activity`` command is
added and no ``workflow.patched()`` marker is needed — the exact posture the
codebase already uses for ``phi_enabled`` and ``prior_verdicts``.

Data-integrity is the safety property: a claim-check must round-trip EXACTLY
(store→reference→retrieve = identity) and a missing/corrupt blob must fail LOUD
(:class:`ClaimCheckNotFound` / :class:`ClaimCheckIntegrityError`) so the
workflow errors + retries instead of silently proceeding with empty/partial
clinical text. Writes are content-addressed (sha256), hence idempotent under
Temporal activity retries.

The hermetic test suite uses :class:`InMemoryBlobStore` (a fake) — no live
MinIO. :class:`S3BlobStore` is the production backend and lazy-imports ``boto3``
so importing this module never requires it (mirrors the lazy Bedrock backend in
``eval.judge.providers``). Payload CONTENT is never logged.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

if TYPE_CHECKING:
    from harness.core.config import ClaimCheckConfig

# utf-8 text is the only payload kind the harness offloads (transcript / prompt /
# note / chunk text). The content-type is recorded on the ref for the store.
CONTENT_TYPE = "text/plain; charset=utf-8"


class ClaimCheckError(RuntimeError):
    """Base for claim-check failures. Always fail LOUD — never proceed with partial data."""


class ClaimCheckNotFound(ClaimCheckError):
    """The referenced blob is absent from the store (dangling ref / lost blob)."""


class UnknownBlobStore(ClaimCheckError):
    """A ref (or config) names a backend this build does not implement."""


class ClaimCheckIntegrityError(ClaimCheckError):
    """The retrieved blob does not match the ref's size/sha256 (corruption/tamper)."""


class ClaimCheckRef(BaseModel):
    """A small out-of-band reference to an offloaded blob — the *claim check*.

    Replaces a large inline blob in Temporal workflow history. Carries only
    metadata (which store, bucket, content-addressed key, byte size, sha256,
    content-type) — NEVER the clinical text. ``extra="forbid"`` keeps the shape
    tight; the fields are stable so a recorded ref replays byte-identically.
    """

    model_config = ConfigDict(extra="forbid")

    store: str
    bucket: str
    key: str
    size: int
    sha256: str
    content_type: str = CONTENT_TYPE


@runtime_checkable
class BlobStore(Protocol):
    """The minimal object-store contract the claim-check needs.

    Async so a sync SDK (boto3) is offloaded off the event loop with
    ``asyncio.to_thread`` inside the concrete store; the in-memory fake is
    trivially async. ``name`` is recorded on the ref for provenance/debugging.
    """

    name: str

    async def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None: ...

    async def get(self, bucket: str, key: str) -> bytes: ...


class InMemoryBlobStore:
    """A process-local, dict-backed store — the hermetic test fake + single-process dev.

    NOT durable across processes/restarts: it is fine for the hermetic suite and
    single-worker local dev (all activities share the one process), but a
    multi-worker deploy MUST use :class:`S3BlobStore` (a cross-worker activity
    retry would otherwise fail LOUD with :class:`ClaimCheckNotFound`).
    """

    name = "memory"

    def __init__(self) -> None:
        self._data: dict[tuple[str, str], bytes] = {}

    async def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        self._data[(bucket, key)] = bytes(data)

    async def get(self, bucket: str, key: str) -> bytes:
        try:
            return self._data[(bucket, key)]
        except KeyError:
            raise ClaimCheckNotFound(f"claim-check blob not found: {bucket}/{key}") from None


class S3BlobStore:
    """Self-hosted MinIO / S3-compatible object store (production backend).

    ``boto3`` is imported LAZILY so this module imports without it and the
    hermetic suite (which uses :class:`InMemoryBlobStore`) never needs it. The
    sync SDK calls are offloaded with ``asyncio.to_thread`` so a blocking S3 call
    never stalls the activity's event loop. Self-hosted only — the endpoint is a
    MinIO/S3 URL under the platform's control; no cloud PHI egress.
    """

    name = "s3"

    def __init__(
        self,
        *,
        endpoint_url: str,
        access_key: str,
        secret_key: str,
        region: str,
        secure: bool,
        cert_check: bool = True,
    ) -> None:
        import boto3  # lazy — hermetic suite never imports this

        client_kwargs: dict[str, Any] = {
            "endpoint_url": endpoint_url,
            "aws_access_key_id": access_key,
            "aws_secret_access_key": secret_key,
            "region_name": region,
            "use_ssl": secure,
        }
        if secure and not cert_check:
            # ⚠️ DELIBERATE, REVERSIBLE SECURITY RELAXATION (owner ruling
            # 2026-08-30, `MINIO_CERT_CHECK`): MinIO keeps TLS but its
            # certificate is not verified — the platform has no private CA to
            # chain it to and authenticates with a service-account key pair
            # instead. Taken while PHI hardening is de-prioritised; grep
            # `MINIO_CERT_CHECK` for every site to revert when a CA lands.
            # NOTE these blobs carry clinical content, so this is the relaxation
            # with the most at stake — it is scoped to the certificate CHECK and
            # nothing else: the transport stays TLS, and the store stays
            # self-hosted (no cloud egress).
            client_kwargs["verify"] = False

        self._client: Any = boto3.client("s3", **client_kwargs)

    async def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        # Content-addressed key ⇒ idempotent write (a Temporal activity retry
        # re-puts the identical object under the same key).
        await asyncio.to_thread(
            self._client.put_object,
            Bucket=bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )

    async def get(self, bucket: str, key: str) -> bytes:
        from botocore.exceptions import ClientError

        try:
            resp = await asyncio.to_thread(self._client.get_object, Bucket=bucket, Key=key)
        except ClientError as exc:
            raise ClaimCheckNotFound(f"claim-check blob not found: {bucket}/{key}") from exc
        body = resp["Body"]
        return await asyncio.to_thread(body.read)


# A process-shared in-memory store so all activities in one worker process see the
# same blobs (a fresh ``build_blob_store`` per activity call must not lose them).
_MEMORY_STORE = InMemoryBlobStore()


#: Registry keys describing WHERE the platform's object storage lives
#: (TASK-799 A.2). `tier: 'db-config'`, backed by the SYSTEM `TenantStorageConfig`
#: row, `consumedBy: ['harness']`. The claim-check store IS that storage — it is
#: not a second backend — so harness reads the location from here rather than
#: from a parallel `HARNESS_CLAIM_CHECK_*` block (owner decision D-2: never
#: invent a second home for a concept that already has one).
STORAGE_ENDPOINT_KEY = "storage.platformDefault.endpoint"
STORAGE_REGION_KEY = "storage.platformDefault.region"
STORAGE_CONTAINER_PREFIX_KEY = "storage.platformDefault.containerPrefix"


@dataclass(frozen=True)
class ClaimCheckLocation:
    """WHERE the claim-check blobs live. Location only — never a credential.

    The credential is deliberately absent: `access_key`/`secret_key` are
    ``SecretStr`` fed from Vault (agent `secrets_dir`) and must never traverse a
    config read surface. The gateway enforces the same rule from its side by
    refusing `sensitivity: 'secret'` descriptors on the pull route.
    """

    bucket: str
    endpoint_url: str
    region: str
    secure: bool


def _served_str(snapshot: Any | None, key: str) -> str | None:
    """A non-empty STRING from the pull snapshot, or ``None`` for "no opinion".

    Refuses rather than coerces, for the reason ``resolve_min_bytes`` already
    documents: a wrongly-typed value is a control-plane defect, and substituting
    something plausible for it hides the defect behind behaviour that looks fine.
    ``bool`` is excluded explicitly — it is not a string, but being explicit
    costs nothing and the same trap bites the numeric helpers.
    """
    if snapshot is None or not getattr(snapshot, "ok", False):
        return None
    value = snapshot.setting(key)
    if not isinstance(value, str) or isinstance(value, bool):
        return None
    stripped = value.strip()
    return stripped or None


def resolve_claim_check_location(
    snapshot: Any | None, config: ClaimCheckConfig
) -> ClaimCheckLocation:
    """The store location in force: control plane first, env as the bootstrap floor.

    Resolved PER FIELD, not all-or-nothing: a half-configured platform row must
    not drag the fields it does answer back to env.

    ``secure`` is DERIVED from a served endpoint rather than read as its own
    knob. A URL is authoritative about its own scheme, and two settings that can
    disagree about one fact is how a store ends up told to speak plaintext to an
    ``https://`` host. When the control plane has no endpoint opinion, the
    bootstrap ``secure`` stands untouched.

    ``bucket`` keeps its harness-owned LOGICAL name and gains the platform's
    namespace prefix. There is no `storage.platformDefault.bucket` key and there
    must not be one — the platform default describes a BACKEND, not one
    service's bucket; `containerPrefix` is the declared mechanism for placement
    ("namespace prefix applied to physical bucket/container names").
    """
    endpoint = _served_str(snapshot, STORAGE_ENDPOINT_KEY)
    region = _served_str(snapshot, STORAGE_REGION_KEY)
    prefix = _served_str(snapshot, STORAGE_CONTAINER_PREFIX_KEY)

    return ClaimCheckLocation(
        bucket=f"{prefix}{config.bucket}" if prefix else config.bucket,
        endpoint_url=endpoint or config.endpoint_url,
        region=region or config.region,
        secure=endpoint.lower().startswith("https://") if endpoint else config.secure,
    )


def build_blob_store(
    config: ClaimCheckConfig,
    location: ClaimCheckLocation | None = None,
    *,
    store_name: str | None = None,
) -> BlobStore:
    """Construct a backend: ``s3`` (MinIO) or the in-memory fake.

    ``s3`` builds a fresh :class:`S3BlobStore` (stateless durable backend);
    ``memory`` returns the process-shared singleton so blobs survive across the
    per-call construction pattern the activities use.

    ``location`` is the control-plane-resolved storage location
    (:func:`resolve_claim_check_location`). Omitted ⇒ the bootstrap values on
    ``config``, which is what every caller saw before A.2 and what a degraded
    control plane still produces.

    ``store_name`` names the backend to build. A DEREFERENCE passes the one
    recorded on the ref (see :func:`open_store`); a WRITE has no ref yet and
    omits it, selecting the configured backend as before. This is the same rule
    the bucket already follows in ``_resolve_ref``: the ref records WHERE a blob
    lives, and config supplies only how to reach it. ``store`` was the last
    locator still taken from config, which is why a harness on the default
    ``memory`` looked in a dict for a blob the gateway had put in MinIO — the
    gateway hardcodes ``store: 's3'`` and has no in-memory mode at all.

    Selecting the backend per-ref does NOT relax the deployment guards: the
    ``memory``-outside-development checks in ``core/config.py`` and
    ``temporal/worker.py`` still govern what this process WRITES.
    """
    selected = store_name or config.store
    if selected == "memory":
        return _MEMORY_STORE
    if selected != "s3":
        # Never fall through to the in-memory fake. `ClaimCheckConfig.store` is
        # enum-validated at construction, but `ClaimCheckRef.store` is a plain
        # `str` off the wire — so this is the ref path's only check, and a
        # silent slide into the dict would be an unreadable blob reported as a
        # missing one.
        raise UnknownBlobStore(
            f"unknown claim-check store {selected!r}: expected 'memory' or 's3'"
        )

    resolved = location or resolve_claim_check_location(None, config)
    return S3BlobStore(
        endpoint_url=resolved.endpoint_url,
        access_key=config.access_key.get_secret_value(),
        secret_key=config.secret_key.get_secret_value(),
        region=resolved.region,
        secure=resolved.secure,
        # Stays on `config`, not on the resolved LOCATION: certificate trust
        # is a platform-wide deployment fact (`MINIO_CERT_CHECK`), not part
        # of "which bucket, on which endpoint" that the control plane serves.
        cert_check=config.cert_check,
    )


async def open_store(
    config: ClaimCheckConfig, ref: ClaimCheckRef | None = None
) -> tuple[BlobStore, ClaimCheckLocation]:
    """The location-resolved store, for a caller that holds no snapshot already.

    One helper rather than a resolve/build pair repeated at each edge, so the
    store and the bucket a caller writes to can never be resolved from different
    tiers. A caller that ALREADY has the snapshot (``_offload_text`` needs it for
    ``min_bytes`` too) should use :func:`resolve_claim_check_location` +
    :func:`build_blob_store` directly rather than fetching twice.

    Pass ``ref`` when opening the store in order to READ that ref: the backend
    then follows the ref rather than this process's configured default, which is
    what lets a harness on the dev default (``memory``) dereference the blob the
    gateway wrote to MinIO. Omit it for writes — there is no ref yet, so the
    configured backend is the only answer.

    NEVER raises on the config read: the client is TTL-cached and fail-safe, and
    a control-plane hiccup must not fail an activity that would otherwise have
    succeeded — it degrades to the bootstrap location. An unimplemented backend
    name DOES raise (:class:`UnknownBlobStore`) — that is not a degraded read,
    it is a request we cannot honour.
    """
    snapshot: Any | None = None
    try:
        from harness.core.effective_config import get_effective_config_client

        snapshot = await get_effective_config_client().get()
    except Exception:  # noqa: BLE001 — a config read may never fail a claim-check
        snapshot = None

    location = resolve_claim_check_location(snapshot, config)
    return build_blob_store(config, location, store_name=ref.store if ref else None), location


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_key(data: bytes) -> str:
    """The content-addressed object key: the sha256 hex of the bytes (deterministic)."""
    return _sha256_hex(data)


#: The registry key that supplies the PLATFORM default for the offload threshold.
#: Registered as `global-kv`, `consumedBy: ['harness']` (D-2).
CLAIM_CHECK_MIN_BYTES_KEY = "harness.claimCheck.minBytes"


def resolve_min_bytes(snapshot: Any | None, bootstrap: int) -> int:
    """The offload threshold in force: control plane, else the env bootstrap value.

    Retunable without a redeploy on purpose — the safe threshold depends on how much
    Temporal history an encounter is actually consuming, which differs per environment
    and per workload, and the alternative to tuning it is a workflow that blows its
    ~50 MB history budget mid-encounter.

    A non-positive or non-integer value is REFUSED, not coerced: `min_bytes <= 0` would
    offload EVERY payload including a two-word one, turning a history-budget guard into a
    per-field store round trip. The bootstrap value stands in every rejection case, so a
    degraded control plane changes nothing.
    """
    if snapshot is None or not getattr(snapshot, "ok", False):
        return bootstrap
    value = snapshot.setting(CLAIM_CHECK_MIN_BYTES_KEY)
    # `bool` is an `int` subclass — exclude it, or `True` would become 1.
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return bootstrap
    return value


def should_offload(text: str, *, min_bytes: int) -> bool:
    """True when the utf-8 blob is at/above the offload threshold.

    Below the threshold the blob stays inline — no store round-trip tax on the
    small prompts/notes that dominate typical encounters. Measured in utf-8
    BYTES (not characters), matching what Temporal serializes into history.
    """
    return len(text.encode("utf-8")) >= min_bytes


async def store_bytes(
    data: bytes, *, store: BlobStore, bucket: str, content_type: str
) -> ClaimCheckRef:
    """Write raw BYTES out-of-band and return their content-addressed claim-check ref.

    The binary sibling of :func:`store_blob`, added for the ``agentic.tts`` artifact write
    (TASK-849 lane B). Audio is not text: ``store_blob`` encodes utf-8, and a WAV body has no
    valid utf-8 decoding, so routing audio through it would either raise or silently mangle.

    This is deliberately the SAME mechanism, not a second one — same store, same
    content-addressed key, same integrity fields, same ref shape — so a synthesised audio
    artifact lands wherever the platform already puts offloaded blobs and needs no second
    lifecycle, no second bucket and no second retention rule. The only thing that varies is
    ``content_type``, which the ref already carries as a field.
    """
    key = content_key(data)
    await store.put(bucket, key, data, content_type)
    return ClaimCheckRef(
        store=store.name,
        bucket=bucket,
        key=key,
        size=len(data),
        sha256=_sha256_hex(data),
        content_type=content_type,
    )


async def store_blob(text: str, *, store: BlobStore, bucket: str) -> ClaimCheckRef:
    """Write ``text`` out-of-band and return its content-addressed claim-check ref."""
    return await store_bytes(
        text.encode("utf-8"), store=store, bucket=bucket, content_type=CONTENT_TYPE
    )


async def load_blob(ref: ClaimCheckRef, *, store: BlobStore) -> str:
    """Retrieve the blob for ``ref``, verifying integrity (fail LOUD on mismatch)."""
    data = await store.get(ref.bucket, ref.key)
    actual_sha = _sha256_hex(data)
    if len(data) != ref.size or actual_sha != ref.sha256:
        raise ClaimCheckIntegrityError(
            f"claim-check integrity mismatch for {ref.bucket}/{ref.key}: "
            f"expected size={ref.size} sha256={ref.sha256}, "
            f"got size={len(data)} sha256={actual_sha}"
        )
    return data.decode("utf-8")


async def maybe_offload(
    text: str, *, store: BlobStore, bucket: str, min_bytes: int
) -> tuple[str, ClaimCheckRef | None]:
    """Above threshold ⇒ store & return ``("", ref)``; else ``(text, None)``.

    Emptying the inline field on offload is what keeps the blob OUT of Temporal
    history — the carrier records only the ref. The caller writes ``text``
    (the emptied inline) into the payload's inline field and ``ref`` into its
    ``*_ref`` field.
    """
    if not should_offload(text, min_bytes=min_bytes):
        return text, None
    ref = await store_blob(text, store=store, bucket=bucket)
    return "", ref


async def resolve(inline: str, ref: ClaimCheckRef | None, *, store: BlobStore) -> str:
    """Inline-or-ref: dereference ``ref`` when set, else use the inline field.

    The backward-compatible seam every consuming activity uses at entry — an old
    history (or a below-threshold payload) carries the blob inline with
    ``ref=None``; a new offloaded payload carries ``inline=""`` + the ref.
    """
    if ref is None:
        return inline
    return await load_blob(ref, store=store)
