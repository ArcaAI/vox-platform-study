"""``POST /tokenize`` — exact token counts for note-budget planning.

Source order: the serving engine's own tokenizer (provider ``count_tokens``
hook), then a sha-pinned HF ``tokenizer.json`` named by the caller from model
metadata, then 501 ``TOKENIZER_UNAVAILABLE``. The conservative estimate is the
CALLER's fallback; this route only ever answers exactly or refuses.
"""

from __future__ import annotations

from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from text.core.dependencies import get_provider_registry
from text.models.requests import ProviderOverride
from text.providers.base import ProviderNotFoundError, ProviderRegistry
from text.services.tokenizer_registry import (
    TokenizerRegistry,
    TokenizerUnavailableError,
    count,
)

router = APIRouter(tags=["tokenize"])


class TokenizerSpec(BaseModel):
    hubRepo: str = Field(..., min_length=1)  # noqa: N815 — wire name from AiModel metadata
    file: str = Field(..., min_length=1)
    sha256: str = Field(..., min_length=64, max_length=64)


class TokenizeMessage(BaseModel):
    role: str
    content: str


class TokenizeRequest(BaseModel):
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    texts: list[str] = Field(default_factory=list)
    messages: list[TokenizeMessage] | None = None
    tokenizer: TokenizerSpec | None = None
    provider_overrides: dict[str, ProviderOverride] | None = None


class TokenizerInfo(BaseModel):
    source: Literal["engine", "hf"]
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


def _get_tokenizer_registry(request: Request) -> TokenizerRegistry:
    registry = getattr(request.app.state, "tokenizer_registry", None)
    if registry is None:
        registry = TokenizerRegistry()
        request.app.state.tokenizer_registry = registry
    return cast(TokenizerRegistry, registry)


@router.post("/tokenize", response_model=TokenizeResponse, response_model_exclude_none=True)
async def tokenize(
    body: TokenizeRequest,
    providers: ProviderRegistry = Depends(get_provider_registry),
    tokenizers: TokenizerRegistry = Depends(_get_tokenizer_registry),
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
        except Exception:  # noqa: BLE001 — engine path is best-effort, HF is next
            engine_counts = None

    if engine_counts is not None and len(engine_counts) == len(all_texts):
        info = TokenizerInfo(source="engine", id=f"{body.provider}:{body.model}")
        counts = list(engine_counts)
    elif body.tokenizer is not None:
        spec = body.tokenizer
        try:
            tok = await tokenizers.get(spec.hubRepo, spec.file, spec.sha256)
        except TokenizerUnavailableError as exc:
            raise _unavailable(str(exc)) from exc
        info = TokenizerInfo(source="hf", id=f"{spec.hubRepo}@{spec.sha256.lower()}")
        counts = [count(tok, t) for t in all_texts]
    else:
        raise _unavailable("no engine tokenizer and no pinned tokenizer supplied")

    n_texts = len(body.texts)
    messages_total: int | None = None
    if body.messages is not None:
        # Content tokens only: the chat template's own overhead is not knowable here.
        messages_total = sum(counts[n_texts:])
    return TokenizeResponse(counts=counts[:n_texts], messagesTotal=messages_total, tokenizer=info)
