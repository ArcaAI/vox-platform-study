"""``/api/v1/internal/models/resolvable`` — can THIS process load these weights?

TASK-890 J1 MAJOR-A. The gateway used to decide a self-hosted model's usability
from ``AiModel.availability``, a measurement of the ``hope-models`` MinIO bucket.
NLP never reads that bucket: its models resolve out of the HuggingFace cache
under ``HF_HOME``. So ``medical-ner``, the three ``gliner2`` rows and
``symps-disease-bert`` reported "weights not available" with the weights on this
host's disk.

Same contract as ``apps/stt`` and ``apps/tts``: read-only, network-free
(``local_files_only``), service-token gated (the exempt set is health/docs/
metrics only), and it ANSWERS rather than decides — the gateway's readiness
sweep folds the verdict in.

The cache dir is deliberately the PROCESS default (``cache_dir=None``): NLP
loads through ``transformers`` / the hub library, which reads ``HF_HOME`` and
resolves ``$HF_HOME/hub``. Since TASK-890 F3 the resolver tries BOTH layouts —
``$HF_HOME/hub`` and ``HF_HOME`` itself, which is what STT's own resolver
passes — so neither service can report a warm cache as cold by reading the
other one's directory.

``warm`` on every response is the boot warm-up's verdict (TASK-890 F6):
``"pending"`` until the process has touched its cache roots once, then ``true``
when they answered and ``false`` when even a 60 s budget did not get an answer
out of them. It is the difference between "this host has not looked yet" and
"this host looked and the volume is not answering", which a per-row verdict
cannot express.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from hope_runtime_models import ResolvableQuery, check_resolvable_many, warmup_state
from pydantic import BaseModel, Field

router = APIRouter(prefix="/internal/models", tags=["internal"])

SERVICE_NAME = "nlp"


class ResolvableItem(BaseModel):
    """One catalogue row the gateway wants a verdict on."""

    id: str | None = None
    sourceUri: str | None = None  # noqa: N815 — the gateway's wire shape is camelCase
    library: str | None = None
    revision: str | None = None
    localPath: str | None = None  # noqa: N815 — see above


class ResolvableRequest(BaseModel):
    models: list[ResolvableItem] = Field(default_factory=list)


def _query(item: ResolvableItem) -> ResolvableQuery:
    return ResolvableQuery(
        id=item.id,
        source_uri=item.sourceUri,
        library=item.library,
        revision=item.revision,
        local_path=item.localPath,
    )


async def _verdicts(items: list[ResolvableItem]) -> list[dict[str, Any]]:
    """Off the event loop, inside one budget — see `check_resolvable_many`.

    Before TASK-890 F3 this ran synchronously in the handler, and a filesystem
    read under `HF_HOME` that never returned took the whole service with it —
    health probe included. Nothing on this path may block the loop again.
    """
    results = await check_resolvable_many([_query(item) for item in items])
    return [result.as_dict() for result in results]


@router.get("/resolvable")
async def resolvable_one(
    source_uri: str | None = Query(default=None),
    id: str | None = Query(default=None),  # noqa: A002 — the catalogue row's id
    library: str | None = Query(default=None),
    revision: str | None = Query(default=None),
) -> dict[str, Any]:
    """One row, for a hand check. The gateway sweep uses the batch POST."""
    (result,) = await _verdicts(
        [ResolvableItem(id=id, sourceUri=source_uri, library=library, revision=revision)]
    )
    return {
        "service": SERVICE_NAME,
        "checkedAt": datetime.now(UTC).isoformat(),
        "warm": warmup_state(),
        "result": result,
    }


@router.post("/resolvable")
async def resolvable_batch(body: ResolvableRequest) -> dict[str, Any]:
    """Every row the gateway serves through this service, in ONE call."""
    return {
        "service": SERVICE_NAME,
        "checkedAt": datetime.now(UTC).isoformat(),
        "warm": warmup_state(),
        "results": await _verdicts(body.models),
    }
