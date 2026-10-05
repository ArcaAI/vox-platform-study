"""``POST /tokenize`` — exact token counts for note-budget planning.

The one source is the serving engine's own tokenizer (provider ``count_tokens``
hook). When the engine cannot count, the route answers 501
``TOKENIZER_UNAVAILABLE`` and the caller applies its conservative estimate. This
service never fetches a tokenizer or any other model artifact: it serves no
model (the no-serving invariant).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from text.core.dependencies import get_provider_registry
from text.models.requests import ProviderOverride
from text.providers.base import ProviderNotFoundError, ProviderRegistry

router = APIRouter(tags=["tokenize"])


class TokenizeMessage(BaseModel):
    role: str
    content: str


class TokenizeRequest(BaseModel):
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    texts: list[str] = Field(default_factory=list)
    messages: list[TokenizeMessage] | None = None
    provider_overrides: dict[str, ProviderOverride] | None = None


class TokenizerInfo(BaseModel):
    source: Literal["engine"]
    id: str


class TokenizeResponse(BaseModel):
    counts: list[int]
    messagesTotal: int | None = None  # noqa: N815
    tokenizer: TokenizerInfo
    exact: Literal[True] = True


def _unavailable(reason: str) -> HTTPException:
    return HTTPException(
        status_code=501, detail={"code": "TOKENIZER_UNAVAILABLE", "message": reason}
    )


@router.post("/tokenize", response_model=TokenizeResponse, response_model_exclude_none=True)
async def tokenize(
    body: TokenizeRequest,
    providers: ProviderRegistry = Depends(get_provider_registry),
) -> TokenizeResponse:
    # Message contents ride along with the texts so a single pass counts both.
    message_texts = [m.content for m in body.messages or []]
    all_texts = [*body.texts, *message_texts]

    engine_counts: list[int] | None = None
    try:
        provider: Any = providers.get(body.provider)
    except (ProviderNotFoundError, KeyError):
        provider = None
    hook = getattr(provider, "count_tokens", None)
    if hook is not None:
        try:
            engine_counts = await hook(all_texts, model=body.model, request=body)
        except Exception:  # noqa: BLE001 — engine path is best-effort; the caller estimates
            engine_counts = None

    if engine_counts is None or len(engine_counts) != len(all_texts):
        raise _unavailable("the serving engine cannot count tokens for this model")

    info = TokenizerInfo(source="engine", id=f"{body.provider}:{body.model}")
    counts = list(engine_counts)
    n_texts = len(body.texts)
    messages_total: int | None = None
    if body.messages is not None:
        # Content tokens only: the chat template's own overhead is not knowable here.
        messages_total = sum(counts[n_texts:])
    return TokenizeResponse(counts=counts[:n_texts], messagesTotal=messages_total, tokenizer=info)
