"""``/api/v1/internal/models/resolvable`` — can THIS process load these weights?

TASK-890 J1 MAJOR-A. The gateway used to decide a self-hosted model's usability
from ``AiModel.availability``, a measurement of the ``hope-models`` MinIO bucket.
TTS never reads that bucket for its local voices: ``kokoro`` and
``indic-parler-tts`` resolve out of the HuggingFace cache, so both reported
"weights not available" whatever this host actually held.

Same contract as ``apps/stt`` and ``apps/nlp``: read-only, network-free
(``local_files_only``), service-token gated (the exempt set is health/docs/
metrics only), and it ANSWERS rather than decides — the gateway's readiness
sweep folds the verdict in.

⚠ TTS is not always running in a local stack. When it is down the gateway records
``unknown`` for its rows rather than a verdict: nobody looked, so nothing is
claimed. That is the whole reason this route reports a FACT and the sweep owns
the interpretation.

The cache dir is the PROCESS default (``cache_dir=None``): the local voice
runtimes load through the hub library, which reads ``HF_HOME`` and resolves
``$HF_HOME/hub``. Passing ``HF_HOME`` itself — the way STT must, because its own
resolver does — would read a different directory from the loaders and report a
warm cache as cold.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from hope_runtime_models import ResolvableQuery, check_resolvable
from pydantic import BaseModel, Field

router = APIRouter(prefix="/internal/models", tags=["internal"])

SERVICE_NAME = "tts"


class ResolvableItem(BaseModel):
    """One catalogue row the gateway wants a verdict on."""

    id: str | None = None
    sourceUri: str | None = None  # noqa: N815 — the gateway's wire shape is camelCase
    library: str | None = None
    revision: str | None = None
    localPath: str | None = None  # noqa: N815 — see above


class ResolvableRequest(BaseModel):
    models: list[ResolvableItem] = Field(default_factory=list)


def _verdict(item: ResolvableItem) -> dict[str, Any]:
    return check_resolvable(
        ResolvableQuery(
            id=item.id,
            source_uri=item.sourceUri,
            library=item.library,
            revision=item.revision,
            local_path=item.localPath,
        ),
    ).as_dict()


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
