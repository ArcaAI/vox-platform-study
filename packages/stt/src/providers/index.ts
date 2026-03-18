/**
 * @arcaai/stt - Providers
 *
 * STT provider implementations.
 */

// Types
export type {
  STTProvider,
  TranscriptionCallback,
  ErrorCallback,
} from './types.js';

// Base
export { BaseSTTProvider } from './BaseSTTProvider.js';

// Implementations
export { LocalSTTProvider } from './LocalSTTProvider.js';
export { RemoteSTTProvider } from './BackendSTTProvider.js';

// Backward compatibility alias
export { RemoteSTTProvider as BackendSTTProvider } from './BackendSTTProvider.js';
