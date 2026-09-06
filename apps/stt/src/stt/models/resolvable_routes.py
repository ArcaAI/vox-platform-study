"""``/api/v1/internal/models/resolvable`` — can THIS process load these weights?

TASK-890 J1 MAJOR-A. The gateway used to decide a self-hosted model's usability
from ``AiModel.availability``, which is a measurement of the ``hope-models``
MinIO bucket. STT never reads that bucket for these rows: ``source_resolver.py``
resolves ``source_uri`` into the HuggingFace cache. So every whisper row read as
"weights not available" while the weights sat on this host's disk.

This route answers for the runtime path instead. Properties, all deliberate:

* **Read-only and network-free.** ``check_resolvable`` only reads the cache; no
  download, no S3 client, no hub call. A readiness probe that fetched weights
  would be a denial of service wearing a health check.
* **Service-token gated.** It is mounted inside the app, so
  ``ServiceAuthMiddleware`` covers it — the exempt set is health/docs/metrics
  only. It reports filesystem paths, which are operational information.
* **It answers, it never decides.** The verdict per row is a fact about this
  host; the gateway's readiness sweep folds it into the snapshot and
  ``usabilityOf`` combines it with the bucket measurement (bucket OR runtime).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from hope_runtime_models import ResolvableQuery, check_resolvable
from pydantic import BaseModel, Field

from stt.core.config.settings import get_settings

router = APIRouter(prefix="/api/v1/internal/models", tags=["Internal"])

SERVICE_NAME = "stt"


class ResolvableItem(BaseModel):
    """One catalogue row the gateway wants a verdict on."""

    id: str | None = None
    sourceUri: str | None = None  # noqa: N815 — the gateway's wire shape is camelCase
    library: str | None = None
    revision: str | None = None
    localPath: str | None = None  # noqa: N815 — see above


class ResolvableRequest(BaseModel):
    models: list[ResolvableItem] = Field(default_factory=list)


def _cache_dirs() -> tuple[str | None, str | None]:
    """The dirs the LOADERS use, not the process defaults.

    STT passes ``huggingface_cache_dir`` to ``snapshot_download`` as ``cache_dir``
    (``source_resolver.config_from_settings``), and that value defaults to
    ``HF_HOME`` ITSELF — not ``$HF_HOME/hub``, which is where the hub library
    would look on its own. Reading the wrong one reports a warm cache as cold.
    The same directory is the resolver's object-store cache root.
    """
    settings = get_settings()
    cache_dir = settings.huggingface_cache_dir
    return cache_dir, cache_dir


def _verdict(item: ResolvableItem) -> dict[str, Any]:
    hf_cache_dir, s3_cache_dir = _cache_dirs()
    result = check_resolvable(
        ResolvableQuery(
            id=item.id,
            source_uri=item.sourceUri,
            library=item.library,
            revision=item.revision,
            local_path=item.localPath,
        ),
        hf_cache_dir=hf_cache_dir,
        s3_cache_dir=s3_cache_dir,
    )
    return result.as_dict()


@router.get("/resolvable")
async def resolvable_one(
    source_uri: str | None = Query(default=None),
    id: str | None = Query(default=None),  # noqa: A002 — the catalogue row's id
    library: str | None = Query(default=None),
    revision: str | None = Query(default=None),
) -> dict[str, Any]:
    """One row, for a hand check. The gateway sweep uses the batch POST."""
    return {
        "service": SERVICE_NAME,
        "checkedAt": datetime.now(UTC).isoformat(),
        "result": _verdict(
            ResolvableItem(id=id, sourceUri=source_uri, library=library, revision=revision)
        ),
    }


@router.post("/resolvable")
async def resolvable_batch(body: ResolvableRequest) -> dict[str, Any]:
    """Every row the gateway serves through this service, in ONE call."""
    return {
        "service": SERVICE_NAME,
        "checkedAt": datetime.now(UTC).isoformat(),
        "results": [_verdict(item) for item in body.models],
    }
