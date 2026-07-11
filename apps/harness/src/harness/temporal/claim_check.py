"""Claim-check payloads for the Temporal history budget (TASK-483).

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

Replay-safety posture (see the TASK-483 README §Replay safety): the ref fields
are **additive-optional** on the existing payloads and the store/load happen
**inside the existing activities**, so no new ``execute_activity`` command is
added and no ``workflow.patched()`` marker is needed — the exact posture the
codebase already uses for ``phi_enabled`` (TASK-357) and ``prior_verdicts``
(TASK-359 WS-1).

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
    ) -> None:
        import boto3  # lazy — hermetic suite never imports this

        self._client: Any = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            use_ssl=secure,
        )

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


def build_blob_store(config: ClaimCheckConfig) -> BlobStore:
    """Construct the configured backend: ``s3`` (MinIO) or the in-memory fake.

    ``s3`` builds a fresh :class:`S3BlobStore` (stateless durable backend);
    ``memory`` returns the process-shared singleton so blobs survive across the
    per-call construction pattern the activities use.
    """
    if config.store == "s3":
        return S3BlobStore(
            endpoint_url=config.endpoint_url,
            access_key=config.access_key.get_secret_value(),
            secret_key=config.secret_key.get_secret_value(),
            region=config.region,
            secure=config.secure,
        )
    return _MEMORY_STORE


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_key(data: bytes) -> str:
    """The content-addressed object key: the sha256 hex of the bytes (deterministic)."""
    return _sha256_hex(data)


def should_offload(text: str, *, min_bytes: int) -> bool:
    """True when the utf-8 blob is at/above the offload threshold (AC-2).

    Below the threshold the blob stays inline — no store round-trip tax on the
    small prompts/notes that dominate typical encounters. Measured in utf-8
    BYTES (not characters), matching what Temporal serializes into history.
    """
    return len(text.encode("utf-8")) >= min_bytes


async def store_blob(text: str, *, store: BlobStore, bucket: str) -> ClaimCheckRef:
    """Write ``text`` out-of-band and return its content-addressed claim-check ref."""
    data = text.encode("utf-8")
    key = content_key(data)
    await store.put(bucket, key, data, CONTENT_TYPE)
    return ClaimCheckRef(
        store=store.name,
        bucket=bucket,
        key=key,
        size=len(data),
        sha256=_sha256_hex(data),
        content_type=CONTENT_TYPE,
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
    history (AC-6) — the carrier records only the ref. The caller writes ``text``
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
