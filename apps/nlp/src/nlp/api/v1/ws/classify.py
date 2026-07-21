from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from nlp.api.middleware.auth import enforce_service_token_ws
from nlp.core.concurrency import get_inference_semaphore
from nlp.core.logging import get_logger
from nlp.core.websocket_manager import WebSocketManager
from nlp.dependencies import get_text_classifier, get_token_classifier, get_websocket_manager
from nlp.services.text_classifier import TextClassifier
from nlp.services.token_classifier import TokenClassifier

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP WebSocket Classify"])


def _bounded(process: Callable[[Any], Awaitable[Any]]) -> Callable[[Any], Awaitable[Any]]:
    """Wrap a per-message inference callable in the shared inference bound.

    The streaming paths hand `service.process` to the WebSocket manager, so the
    bound has to travel with the callable rather than wrap a request handler.
    Without this, a socket sending messages back-to-back would bypass the
    ceiling the REST routes respect.
    """

    async def bounded_process(payload: Any) -> Any:
        async with get_inference_semaphore():
            return await process(payload)

    return bounded_process


@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,
    service: TokenClassifier = Depends(get_token_classifier),
    ws_manager: WebSocketManager = Depends(get_websocket_manager),
) -> None:
    if not await enforce_service_token_ws(websocket):
        return
    try:
        await ws_manager.handle_connection(
            websocket=websocket, session_id=session_id, process=_bounded(service.process)
        )

    except WebSocketDisconnect:
        logger.info(f"NLP Token WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"NLP Token WebSocket error: {str(e)}")


@router.websocket("/text/{session_id}")
async def websocket_classify_text(
    websocket: WebSocket,
    session_id: str,
    service: TextClassifier = Depends(get_text_classifier),
    ws_manager: WebSocketManager = Depends(get_websocket_manager),
) -> None:
    if not await enforce_service_token_ws(websocket):
        return
    try:
        await ws_manager.handle_connection(
            websocket=websocket, session_id=session_id, process=_bounded(service.process)
        )
    except WebSocketDisconnect:
        logger.info(f"NLP Text WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"NLP Text WebSocket error: {str(e)}")
