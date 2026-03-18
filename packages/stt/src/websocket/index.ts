/**
 * @arcaai/stt - WebSocket
 *
 * WebSocket client and message handling for backend STT service.
 */

export {
  WebSocketClient,
  type WebSocketClientOptions,
  type WebSocketCallbacks,
  type ConnectionState,
  DEFAULT_WS_OPTIONS,
} from './WebSocketClient.js';

export {
  MessageHandler,
  type MessageHandlerCallbacks,
} from './MessageHandler.js';
