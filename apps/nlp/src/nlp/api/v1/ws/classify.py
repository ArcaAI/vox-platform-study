from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect

from nlp.api.middleware.auth import enforce_service_token_ws
from nlp.api.tenant import TENANT_HEADER, assert_tenant_matches_header
from nlp.core.concurrency import get_inference_semaphore
from nlp.core.logging import get_logger
from nlp.core.websocket_manager import WebSocketManager
from nlp.dependencies import (
    get_websocket_manager,
    pinned_text_classifier,
    pinned_token_classifier,
)
from nlp.schemas.classification import (
    WebSocketTextClassifyIncoming,
    WebSocketTokenClassifyIncoming,
)
from nlp.services.model_cache import ModelUnavailableError

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP WebSocket Classify"])


def _require_selection(payload: Any, header_tenant: str | None, what: str) -> None:
    """Every message carries its own tenant and model selection.

    These sockets used to resolve a PROCESS SINGLETON built from settings
    defaults — i.e. a hardcoded checkpoint — on a surface that carried no
    tenant at all. Model identity is configuration, so it arrives per message
    exactly as it does on the REST routes, with the same fail postures: an
    unresolved selection is 503, absent attribution is 428, and a header that
    contradicts the body is 400.
    """
    assert_tenant_matches_header(payload.tenant_id, header_tenant)
    if not (payload.tenant_id or "").strip():
        raise HTTPException(
            status_code=428,
            detail=(
                f"tenant_id is required for tenant-scoped {what}. The caller must "
                "inject it into every message."
            ),
        )
    if not (payload.model_name or "").strip():
        raise HTTPException(
            status_code=503,
            detail=(
                f"{what} model selection is unresolved. apps/nlp names no model of its "
                "own — the caller resolves it from AiRoutingPolicy (fail-closed)."
            ),
        )


def _bounded(
    resolve: Callable[[str, str | None], AbstractAsyncContextManager[Any]],
    parse: Callable[[dict[str, Any]], Any],
    what: str,
    header_tenant: str | None,
) -> Callable[[Any], Awaitable[Any]]:
    """Per-message: validate, resolve the selected model, run it under the bound.

    The model is pinned only for the message it serves, so a socket that stays
    open across a model change picks the new one up on its next message rather
    than holding the old weights for the life of the connection.
    """

    async def process(raw: dict[str, Any]) -> Any:
        payload = parse(raw)
        _require_selection(payload, header_tenant, what)
        try:
            async with resolve(payload.model_name, payload.model_path) as service:
                async with get_inference_semaphore():
                    return await service.process(payload)
        except ModelUnavailableError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e

    return process


@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,
    ws_manager: WebSocketManager = Depends(get_websocket_manager),
) -> None:
    if not await enforce_service_token_ws(websocket):
        return
    try:
        await ws_manager.handle_connection(
            websocket=websocket,
            session_id=session_id,
            process=_bounded(
                pinned_token_classifier,
                WebSocketTokenClassifyIncoming.model_validate,
                "token classification",
                websocket.headers.get(TENANT_HEADER.lower()),
            ),
        )

    except WebSocketDisconnect:
        logger.info(f"NLP Token WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"NLP Token WebSocket error: {str(e)}")


@router.websocket("/text/{session_id}")
async def websocket_classify_text(
    websocket: WebSocket,
    session_id: str,
    ws_manager: WebSocketManager = Depends(get_websocket_manager),
) -> None:
    if not await enforce_service_token_ws(websocket):
        return
    try:
        await ws_manager.handle_connection(
            websocket=websocket,
            session_id=session_id,
            process=_bounded(
                pinned_text_classifier,
                WebSocketTextClassifyIncoming.model_validate,
                "text classification",
                websocket.headers.get(TENANT_HEADER.lower()),
            ),
        )
    except WebSocketDisconnect:
        logger.info(f"NLP Text WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"NLP Text WebSocket error: {str(e)}")
