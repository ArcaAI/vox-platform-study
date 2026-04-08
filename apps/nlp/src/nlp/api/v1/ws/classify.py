from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from nlp.core.logging import get_logger
from nlp.core.websocket_manager import WebSocketManager
from nlp.dependencies import get_text_classifier, get_token_classifier, get_websocket_manager
from nlp.services.text_classifier import TextClassifier
from nlp.services.token_classifier import TokenClassifier

logger = get_logger(__name__)

router = APIRouter(prefix="/classify", tags=["NLP WebSocket Classify"])


@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,
    service: TokenClassifier = Depends(get_token_classifier),
    ws_manager: WebSocketManager = Depends(get_websocket_manager),
):
    try:
        await ws_manager.handle_connection(websocket=websocket, session_id=session_id, process=service.process)

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
):
    try:
        await ws_manager.handle_connection(websocket=websocket, session_id=session_id, process=service.process)
    except WebSocketDisconnect:
        logger.info(f"NLP Text WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"NLP Text WebSocket error: {str(e)}")
