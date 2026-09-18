/**
 * @arcaai/stt - Providers
 *
 * STT provider implementations.
 */

// Types
export type { STTProvider, TranscriptionCallback, ErrorCallback } from './types.js';

// Base
export { BaseSTTProvider } from './BaseSTTProvider.js';

// Implementations
export { LocalSTTProvider } from './LocalSTTProvider.js';
export { RemoteSTTProvider } from './BackendSTTProvider.js';

// Pipeline-aware streaming provider.
export {
  StreamingBackendSTTProvider,
  type StreamingRemoteProviderConfig,
  type StreamingSessionLike,
  type StreamingWsClientLike,
  type StreamingTranscriptPayload,
  // TASK-985 M-43 — the gateway's `gap` frame (text it discarded on the way down).
  type StreamingGapPayload,
} from './StreamingBackendSTTProvider.js';

// Backward compatibility alias
export { RemoteSTTProvider as BackendSTTProvider } from './BackendSTTProvider.js';
