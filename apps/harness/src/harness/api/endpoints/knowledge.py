"""Internal institutional-knowledge ingest endpoint.

``POST /api/v1/internal/knowledge/ingest`` is the cross-lane contract Lane B's
BullMQ ``IngestKnowledgeDocument`` processor calls after a ``KnowledgeDocument`` is
APPROVED. Chunking, dense (LM Studio) + sparse (fastembed BM25) embedding, and the
Qdrant upsert into the dedicated ``knowledge_chunks`` collection all happen **inside
this endpoint**; it returns one descriptor per chunk so Lane B can persist
``KnowledgeChunk`` rows keyed by ``qdrantPointId``.

Auth: the ``X-Service-Token`` header must match the dedicated
``HARNESS_INTERNAL_SERVICE_TOKEN`` **or** the shared ``HARNESS_SERVICE_TOKEN``
(extends the existing internal-endpoint mechanism); empty (both) disables the
guard for local dev. On an embeddings / sparse / Qdrant failure the endpoint
returns HTTP 503 with a structured error body so Lane B can fail + retry the job
(nothing is half-written: the upsert is the last step).

Point id = a stable ``uuid5`` per ``(tenant, document, chunkIndex)`` so re-ingesting
the same document is idempotent. The Qdrant payload ``chunk_id`` is set equal to the
point id (the stable join key Lane B persists as ``KnowledgeChunk.qdrantPointId``).
"""

from __future__ import annotations

import secrets
import uuid
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from harness.core.config import Settings
from harness.core.logging import get_logger
from harness.core.provider_credentials import (
    VECTOR_CONNECTION_PROVIDER,
    CredentialUnavailable,
    ProviderCredential,
    apply_embeddings_credential,
    apply_vector_credential,
    require_embeddings_model,
    resolve_embeddings_credential,
)
from harness.guides.retrieval.chunker import chunk_text
from harness.guides.retrieval.qdrant_store import (
    APPROVED_STATUS,
    KnowledgeQdrantStore,
    UpsertItem,
)
from harness.guides.retrieval.sparse import SparseBm25Embedder
from harness.services.api_client import ApiClient
from harness.services.embeddings_client import EmbeddingsClient, EmbeddingsServiceError

logger = get_logger(__name__)

router = APIRouter(tags=["internal"])

# Stable namespace for deterministic per-chunk point ids (idempotent re-ingest).
_POINT_NS = uuid.uuid5(uuid.NAMESPACE_URL, "hope:harness:knowledge_chunks")


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def require_internal_service_token(
    request: Request,
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Accept the dedicated ingest token OR the shared service token (constant-time).

    Empty configured tokens (both) disable the guard for local dev. Extends the
    existing ``require_service_token`` mechanism rather than replacing it, so the
    same internal surface keeps working while Lane B can present the contract's
    ``HARNESS_INTERNAL_SERVICE_TOKEN``.
    """
    settings = _settings(request)
    accepted = [
        tok
        for tok in (
            settings.internal_service_token.get_secret_value(),
            settings.service_token.get_secret_value(),
        )
        if tok
    ]
    if not accepted:
        return
    if not x_service_token or not any(
        secrets.compare_digest(x_service_token, tok) for tok in accepted
    ):
        raise HTTPException(status_code=401, detail="invalid or missing service token")


def _embeddings_client(
    settings: Settings, credential: ProviderCredential | None = None
) -> EmbeddingsClient:
    """Build the dense-embeddings client, applying a resolved connection if any.

    D-1c — the ingest side of the same fold the retriever uses, so a
    tenant's corpus and its queries are embedded by the SAME model on the SAME
    endpoint. Deriving them separately would produce vectors a query can never
    match, which is a silent failure rather than a loud one.

    Raises :class:`CredentialUnavailable` when no tier supplied a model id: the
    literal default was retired (a model id is a SELECTION), and selection fails
    CLOSED. The caller turns that into a 503 rather than embedding a corpus with
    a model it chose itself.
    """
    rc = apply_embeddings_credential(settings.retrieval, credential)
    return EmbeddingsClient(
        rc.embeddings_base_url,
        model=require_embeddings_model(rc),
        timeout=rc.embeddings_timeout_s,
        api_key=rc.embeddings_api_key.get_secret_value() if rc.embeddings_api_key else None,
    )


def _sparse_embedder() -> SparseBm25Embedder:
    return SparseBm25Embedder()


async def _resolve_embeddings_credential(settings: Settings, tenant_id: str) -> ProviderCredential:
    """Resolve this tenant's embeddings credential from the gateway's BYO plane.

    D-1c — the sibling of :func:`_resolve_qdrant_credential`, for the
    OTHER connection the retrieval stack needs. Kept as its own function (rather
    than a `service`/`provider` parameter on that one) so the hermetic suite can
    stub each plane independently and a test that pins one cannot accidentally
    pin the other. Never raises; see :mod:`harness.core.provider_credentials`.

    Two lanes, tenant BYO then the platform's own server, through the SHARED
    :func:`resolve_embeddings_credential` — so ingest and retrieval can never
    disagree about which tier (and therefore which model) embedded a corpus.
    """
    client = _connection_client(settings)
    return await resolve_embeddings_credential(
        lambda service, provider: client.resolve_provider_credential(
            service, provider, tenant_id=tenant_id
        )
    )


async def _resolve_qdrant_credential(settings: Settings, tenant_id: str) -> ProviderCredential:
    """Resolve this tenant's Qdrant credential from the gateway's BYO plane.

    The mirror of the Temporal activity's resolve, for the two endpoints the
    gateway calls directly. It IS an extra hop back to the caller — the gateway
    invokes ingest/delete, and this asks the gateway for the credential — but the
    route it calls (`/internal/harness/provider-credential`) makes no onward call
    into harness, so nothing waits on itself. That extra hop buys the property
    that matters: ONE resolution path for the Qdrant credential, so a secured
    cluster is reachable from ingest and delete exactly as it is from retrieval.
    Never raises; see :mod:`harness.core.provider_credentials`.

    Factored out like every other client factory here so tests can stub it.
    """
    return await _connection_client(settings).resolve_provider_credential(
        "vector", VECTOR_CONNECTION_PROVIDER, tenant_id=tenant_id
    )


def _connection_client(settings: Settings) -> ApiClient:
    """The gateway client the two credential resolvers above share."""
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.peer_service_token(settings.service_token),
        timeout=settings.api_timeout_s,
    )


def _qdrant_store(
    settings: Settings, credential: ProviderCredential | None = None
) -> KnowledgeQdrantStore:
    """Build the store, applying a gateway-resolved credential when there is one.

    `credential=None` / outcome `ABSENT` keeps the UNAUTHENTICATED path — correct
    for a local dev Qdrant, and not an env fallback (there is no env path left:
    `RetrievalConfig.qdrant_api_key` is `validation_alias`-closed).

    D-1b — the fold is the SHARED one, so the tenant's `collection`
    prefix derived here is byte-identical to the one the retriever derives.
    """
    rc = apply_vector_credential(settings.retrieval, credential)
    return KnowledgeQdrantStore(
        rc.qdrant_url,
        rc.collection,
        timeout=rc.qdrant_timeout_s,
        api_key=rc.qdrant_api_key.get_secret_value() if rc.qdrant_api_key else None,
    )


def _point_id(tenant_id: str, document_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(_POINT_NS, f"{tenant_id}:{document_id}:{chunk_index}"))


class IngestRequest(BaseModel):
    """Body for ``knowledge/ingest`` (camelCase at the Lane B boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str = Field(alias="tenantId")
    knowledge_document_id: str = Field(alias="knowledgeDocumentId")
    title: str = ""
    source: str = ""
    mime_type: str = Field(default="text/plain", alias="mimeType")
    text: str = ""


@router.post(
    "/knowledge/ingest",
    dependencies=[Depends(require_internal_service_token)],
)
async def ingest_knowledge(body: IngestRequest, request: Request) -> dict[str, Any]:
    """Chunk -> dense+sparse embed -> upsert -> return chunk descriptors."""
    settings = _settings(request)

    chunks = chunk_text(body.text)
    if not chunks:
        return {"chunkCount": 0, "chunks": []}

    texts = [c.text for c in chunks]

    # D-1c — the embeddings endpoint/key/model are a tenant's to own,
    # so resolve them BEFORE embedding. A DENIED (tenant veto) / UNAVAILABLE
    # (gateway fault) credential is a 503 with the same fail-closed posture the
    # Qdrant resolve below already has: Lane B fails and retries the job. It never
    # embeds on the platform's endpoint on the assumption the tenant would agree.
    embeddings_credential = await _resolve_embeddings_credential(settings, body.tenant_id)
    if not embeddings_credential.usable:
        logger.warning(
            "harness.knowledge.ingest.credential_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            outcome=embeddings_credential.outcome.value,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "error": "embeddings_credential_unavailable",
                "detail": embeddings_credential.reason or embeddings_credential.outcome.value,
            },
        )
    try:
        embeddings = _embeddings_client(settings, embeddings_credential)
    except CredentialUnavailable as exc:
        # D-1c — no tier supplied a model id. Same 503 + fail-closed posture as an
        # unusable credential: never embed with a model this service picked.
        logger.warning(
            "harness.knowledge.ingest.embeddings_model_unresolved",
            knowledge_document_id=body.knowledge_document_id,
            cause=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "embeddings_model_unresolved", "detail": str(exc)},
        ) from exc

    try:
        dense_vectors = await embeddings.embed(texts)
    except EmbeddingsServiceError as exc:
        logger.warning(
            "harness.knowledge.ingest.embeddings_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "embeddings_unavailable", "detail": str(exc)},
        ) from exc

    try:
        sparse_vectors = _sparse_embedder().embed_documents(texts)
    except Exception as exc:  # noqa: BLE001 — any sparse failure degrades the job
        logger.warning(
            "harness.knowledge.ingest.sparse_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "sparse_embeddings_unavailable", "detail": str(exc)},
        ) from exc

    items: list[UpsertItem] = []
    descriptors: list[dict[str, Any]] = []
    for i, chunk in enumerate(chunks):
        point_id = _point_id(body.tenant_id, body.knowledge_document_id, chunk.chunk_index)
        items.append(
            UpsertItem(
                point_id=point_id,
                dense=dense_vectors[i],
                sparse=sparse_vectors[i],
                payload={
                    "tenant_id": body.tenant_id,
                    "knowledge_document_id": body.knowledge_document_id,
                    "chunk_id": point_id,
                    "status": APPROVED_STATUS,
                    "chunk_index": chunk.chunk_index,
                    "text": chunk.text,
                },
            )
        )
        descriptors.append(
            {
                "chunkIndex": chunk.chunk_index,
                "text": chunk.text,
                "qdrantPointId": point_id,
                "startOffset": chunk.start_offset,
                "endOffset": chunk.end_offset,
                "tokenCount": chunk.token_count,
                # The model that ACTUALLY embedded this chunk — the tenant's when
                # its connection row pinned one, the platform floor otherwise.
                "embeddingModel": embeddings.model,
                "embeddingDim": len(dense_vectors[i]),
                "status": APPROVED_STATUS,
            }
        )

    # A DENIED (tenant veto) / UNAVAILABLE (gateway fault) credential is a 503,
    # matching this endpoint's existing fail-closed posture for a Qdrant outage:
    # Lane B fails and retries the job. It NEVER writes unauthenticated on the
    # assumption the cluster is open.
    qdrant_credential = await _resolve_qdrant_credential(settings, body.tenant_id)
    if not qdrant_credential.usable:
        logger.warning(
            "harness.knowledge.ingest.credential_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            outcome=qdrant_credential.outcome.value,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "error": "qdrant_credential_unavailable",
                "detail": qdrant_credential.reason or qdrant_credential.outcome.value,
            },
        )

    try:
        _qdrant_store(settings, qdrant_credential).upsert_chunks(items)
    except Exception as exc:  # noqa: BLE001 — Qdrant outage degrades the job (retryable)
        logger.warning(
            "harness.knowledge.ingest.qdrant_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "qdrant_unavailable", "detail": str(exc)},
        ) from exc

    logger.info(
        "harness.knowledge.ingest.completed",
        knowledge_document_id=body.knowledge_document_id,
        tenant_id=body.tenant_id,
        chunk_count=len(descriptors),
    )
    return {"chunkCount": len(descriptors), "chunks": descriptors}


@router.delete(
    "/knowledge/{document_id}",
    dependencies=[Depends(require_internal_service_token)],
)
async def delete_knowledge_document(
    document_id: str,
    request: Request,
    tenant_id: str = Query(..., alias="tenantId"),
) -> dict[str, Any]:
    """Remove every Qdrant point for one document, tenant-scoped.

    Lane B (`KnowledgeDocumentService.deleteDocument`) calls this BEFORE
    committing the Postgres soft-delete (fail-closed: a 503 here means the
    delete is aborted rather than leaving vectors retrievable behind a
    "deleted" Postgres row — see ). Idempotent: deleting an id with no
    matching points is a normal 200, not an error.
    """
    settings = _settings(request)
    # Fail closed for the same reason the Qdrant-outage branch below does: Lane B
    # aborts its Postgres soft-delete on a 503, so a credential we cannot resolve
    # must never leave vectors retrievable behind a "deleted" row.
    qdrant_credential = await _resolve_qdrant_credential(settings, tenant_id)
    if not qdrant_credential.usable:
        logger.warning(
            "harness.knowledge.delete.credential_unavailable",
            knowledge_document_id=document_id,
            tenant_id=tenant_id,
            outcome=qdrant_credential.outcome.value,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "error": "qdrant_credential_unavailable",
                "detail": qdrant_credential.reason or qdrant_credential.outcome.value,
            },
        )

    try:
        _qdrant_store(settings, qdrant_credential).delete_by_document(
            tenant_id=tenant_id, knowledge_document_id=document_id
        )
    except Exception as exc:  # noqa: BLE001 — Qdrant outage aborts the caller's delete (retryable)
        logger.warning(
            "harness.knowledge.delete.qdrant_unavailable",
            knowledge_document_id=document_id,
            tenant_id=tenant_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "qdrant_unavailable", "detail": str(exc)},
        ) from exc

    logger.info(
        "harness.knowledge.delete.completed",
        knowledge_document_id=document_id,
        tenant_id=tenant_id,
    )
    return {"status": "deleted", "knowledgeDocumentId": document_id}
