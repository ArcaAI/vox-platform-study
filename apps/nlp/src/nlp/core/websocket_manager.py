import asyncio
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from nlp.schemas.common import WebSocketMessage, WebSocketMessageType
from nlp.utils import get_current_time

logger = logging.getLogger(__name__)


class WebSocketSession:
    def __init__(self, session_id: str, websocket: WebSocket):
        self.session_id = session_id
        self.websocket = websocket
        self.is_active = True
        self.last_heartbeat = get_current_time()


class WebSocketManager:
    def __init__(self) -> None:
        self.sessions: dict[str, WebSocketSession] = {}
        self.websockets: set[WebSocket] = set()
        self.heartbeat_task: asyncio.Task[None] | None = None
        self.cleanup_task: asyncio.Task[None] | None = None

        self.HEARTBEAT_INTERVAL = 30
        self.CLEANUP_INTERVAL = 60
        self.WAIT_TIMEOUT = 60
        self.SPANNING_TIMEOUT = 30
        self.HEARTBEAT_TIMEOUT = 90

        self.is_initialized = False

    async def initialize(self) -> None:
        """Initialize the WebSocket service"""
        try:
            self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            self.cleanup_task = asyncio.create_task(self._cleanup_loop())
            self.is_initialized = True

            logger.info("WebSocket service initialized")

        except Exception as e:
            logger.error(f"Failed to initialize WebSocket service: {str(e)}")
            raise

    async def handle_connection(self, websocket: WebSocket, session_id: str, process: Callable[..., Any]) -> None:
        """Handle a new WebSocket connection"""
        await websocket.accept()

        session = WebSocketSession(session_id, websocket)
        self.sessions[session_id] = session
        self.websockets.add(websocket)

        logger.info(f"WebSocket session established: {session_id}")

        try:
            while session.is_active:
                try:
                    message_data = await asyncio.wait_for(websocket.receive_text(), timeout=self.WAIT_TIMEOUT)

                    result = await process(json.loads(message_data))
                    await self._send_message(
                        session,
                        WebSocketMessage(
                            type=WebSocketMessageType.MESSAGE,
                            session_id=session_id,
                            data=result,
                        )
                    )

                except TimeoutError:
                    await self._send_heartbeat(session)

                except WebSocketDisconnect:
                    logger.info(f"WebSocket client disconnected: {session_id}")
                    break

                except Exception as e:
                    logger.error(f"Error processing message for session {session_id}: {str(e)}")
                    await self._send_error(session, "PROCESSING_ERROR", str(e))

        except Exception as e:
            logger.error(f"WebSocket connection error for session {session_id}: {str(e)}")
        finally:
            await self.cleanup_session(session_id)

    async def _heartbeat_loop(self) -> None:
        """Background task to send periodic heartbeats"""
        while self.is_initialized:
            try:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)

                for session in list(self.sessions.values()):
                    if session.is_active:
                        try:
                            await self._send_heartbeat(session)
                        except Exception as e:
                            logger.warning(f"Heartbeat failed for session {session.session_id}: {str(e)}")

            except Exception as e:
                logger.error(f"Heartbeat loop error: {str(e)}")

    async def _cleanup_loop(self) -> None:
        """Background task to cleanup inactive sessions"""
        while self.is_initialized:
            try:
                await asyncio.sleep(self.CLEANUP_INTERVAL)

                current_time = datetime.now(UTC)
                inactive_sessions = []

                # Find inactive sessions
                for session_id, session in self.sessions.items():
                    time_since_heartbeat = (current_time - session.last_heartbeat).total_seconds()
                    if time_since_heartbeat > self.HEARTBEAT_TIMEOUT + self.SPANNING_TIMEOUT:
                        inactive_sessions.append(session_id)

                # Cleanup inactive sessions
                for session_id in inactive_sessions:
                    logger.info(f"Cleaning up inactive session: {session_id}")
                    await self.cleanup_session(session_id)

            except Exception as e:
                logger.error(f"Cleanup loop error: {str(e)}")

    async def cleanup_session(self, session_id: str) -> None:
        """Cleanup a WebSocket session"""
        try:
            if session_id in self.sessions:
                session = self.sessions[session_id]
                session.is_active = False

                # Remove from active connections
                if session.websocket in self.websockets:
                    self.websockets.remove(session.websocket)

                await session.websocket.close()

                del self.sessions[session_id]

                logger.info(f"Session cleanup completed: {session_id}")

        except Exception as e:
            logger.error(f"Error during session cleanup for {session_id}: {str(e)}")

    async def shutdown(self) -> None:
        """Shutdown the WebSocket service"""
        try:
            self.is_initialized = False

            # Cancel background tasks
            if self.heartbeat_task:
                self.heartbeat_task.cancel()
            if self.cleanup_task:
                self.cleanup_task.cancel()

            # Cleanup all sessions
            session_ids = list(self.sessions.keys())
            for session_id in session_ids:
                await self.cleanup_session(session_id)

            logger.info("WebSocket classification service shutdown completed")

        except Exception as e:
            logger.error(f"Error during WebSocket service shutdown: {str(e)}")

    async def _send_message(self, session: WebSocketSession, message: WebSocketMessage) -> None:
        try:
            # Use mode='json' to ensure datetime objects are serialized as ISO strings
            message_dict = message.model_dump(mode='json')
            await session.websocket.send_json(message_dict)

            logger.debug(f"Sent message to session {session.session_id}: {json.dumps(message_dict)}")
        except Exception as e:
            logger.error(f"Failed to send message to session {session.session_id}: {str(e)}")
            raise

    async def _send_error(self, session: WebSocketSession, error_code: str, error_message: str, details: dict | None = None) -> None:
        error_msg = WebSocketMessage(
            type=WebSocketMessageType.ERROR,
            session_id=session.session_id,
            data={
                "error_code": error_code,
                "error_message": error_message,
                "details": details
            }
        )
        await self._send_message(session, error_msg)

    async def _send_heartbeat(self, session: WebSocketSession) -> None:
        """Send heartbeat message to client"""
        try:
            heartbeat_msg = WebSocketMessage(
                type=WebSocketMessageType.HEARTBEAT,
                session_id=session.session_id,
                data={
                    "is_active": session.is_active
                }
            )

            await self._send_message(session, heartbeat_msg)
            session.last_heartbeat = get_current_time()

        except Exception as e:
            logger.error(f"Failed to send heartbeat to session {session.session_id}: {str(e)}")
