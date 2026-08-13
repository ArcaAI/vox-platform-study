/**
 * PluginManager — streaming client connection/provider-switch wiring.
 *
 * `buildStreamingTransport` must wire the previously-dangling SttWebSocketClient
 * lifecycle callbacks (onDisconnect/onReconnect/onReconnected/onReconnectFailed)
 * and the `provider_switched` status into the plugin callback bus, so the vox
 * hook/store can surface a live connection-health + fallback signal.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@arcaai/noise-filter', () => ({ createNoiseFilter: vi.fn() }));
vi.mock('@arcaai/vad', () => ({ createVAD: vi.fn() }));
vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn() }));
vi.mock('@arcaai/med-ner', () => ({ createMedNER: vi.fn() }));

// Capture the callbacks the PluginManager registers on the ws client so we can
// drive them and assert they reach the plugin callback bus.
const captured: Record<string, ((...args: any[]) => void) | undefined> = {};

vi.mock('../StreamingSessionManager', () => ({
  StreamingSessionManager: class {
    refreshTicket = vi.fn(async () => 'ticket');
    // Captured like the ws-client callbacks below so the session-create
    // echo can be driven from a test.
    onSessionCreated(cb: (response: unknown) => void) {
      captured.onSessionCreated = cb;
    }
  },
}));

vi.mock('../SttWebSocketClient', () => ({
  SttWebSocketClient: class {
    onDisconnect(cb: () => void) {
      captured.onDisconnect = cb;
    }
    onReconnect(cb: (attempt: number) => void) {
      captured.onReconnect = cb;
    }
    onReconnected(cb: () => void) {
      captured.onReconnected = cb;
    }
    onReconnectFailed(cb: () => void) {
      captured.onReconnectFailed = cb;
    }
    onStatus(cb: (status: unknown) => void) {
      captured.onStatus = cb;
    }
  },
}));

import { PluginManager } from '../PluginManager';
import { createMockLogger } from '../../__tests__/setup';
import type { AgenticClient } from '../AgenticClient';
import type { SttConnectionState, ProviderSwitchInfo } from '../../types/audio';

function makeApiClient(): AgenticClient {
  return { post: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn(), getBaseUrl: vi.fn(() => 'https://api.test') } as unknown as AgenticClient;
}

describe('PluginManager — provider-switch / connection wiring', () => {
  let manager: PluginManager;
  let onSttConnectionState: ReturnType<typeof vi.fn<(state: SttConnectionState) => void>>;
  let onProviderSwitched: ReturnType<typeof vi.fn<(info: ProviderSwitchInfo) => void>>;

  beforeEach(() => {
    for (const k of Object.keys(captured)) delete captured[k];
    manager = new PluginManager({ stt: { enabled: true, provider: 'backend', language: 'en' } }, createMockLogger(), makeApiClient(), false);
    onSttConnectionState = vi.fn<(state: SttConnectionState) => void>();
    onProviderSwitched = vi.fn<(info: ProviderSwitchInfo) => void>();
    manager.setCallbacks({ onSttConnectionState, onProviderSwitched });
    manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'pipe-1');
  });

  // The session-create echo is routed to the plugin bus so the store's
  // `activePipeline` can be server-derived instead of an echo of the request.
  it('routes a session-create echo to onStreamingSessionCreated', () => {
    const onStreamingSessionCreated = vi.fn();
    manager.setCallbacks({ onSttConnectionState, onProviderSwitched, onStreamingSessionCreated });

    captured.onSessionCreated?.({ sessionId: 's-1', pipelineId: 'resolved-pipe', activeEngine: 'fallback' });

    expect(onStreamingSessionCreated).toHaveBeenCalledWith({ pipelineId: 'resolved-pipe', isFallback: true });
  });

  it('stays silent when the gateway echoes no pipeline (older backend)', () => {
    // The consumer must then keep its own request-derived value rather than
    // receive a half-filled baseline it cannot distinguish from a real one.
    const onStreamingSessionCreated = vi.fn();
    manager.setCallbacks({ onSttConnectionState, onProviderSwitched, onStreamingSessionCreated });

    captured.onSessionCreated?.({ sessionId: 's-1' });

    expect(onStreamingSessionCreated).not.toHaveBeenCalled();
  });

  it('registers all four lifecycle callbacks and onStatus on the ws client', () => {
    expect(typeof captured.onDisconnect).toBe('function');
    expect(typeof captured.onReconnect).toBe('function');
    expect(typeof captured.onReconnected).toBe('function');
    expect(typeof captured.onReconnectFailed).toBe('function');
    expect(typeof captured.onStatus).toBe('function');
  });

  it('maps disconnect/reconnect → reconnecting, reconnected → connected, failed → error', () => {
    captured.onDisconnect?.();
    captured.onReconnect?.(1);
    captured.onReconnected?.();
    captured.onReconnectFailed?.();

    expect(onSttConnectionState.mock.calls.map((c) => c[0])).toEqual(['reconnecting', 'reconnecting', 'connected', 'error']);
  });

  it('routes a provider_switched status frame to onProviderSwitched (coercing utterance_index)', () => {
    captured.onStatus?.({
      type: 'status',
      status: 'provider_switched',
      from_pipeline: 'azure_speech_transcription',
      to_pipeline: 'sarvam_transcription',
      reason: 'auto',
      utterance_index: '7',
    });

    expect(onProviderSwitched).toHaveBeenCalledWith({
      fromPipeline: 'azure_speech_transcription',
      toPipeline: 'sarvam_transcription',
      reason: 'auto',
      utteranceIndex: 7,
    });
  });

  it('forwards the bidirectional active/is_fallback fields on a primary→fallback frame', () => {
    captured.onStatus?.({
      type: 'status',
      status: 'provider_switched',
      from_pipeline: 'pipe-1',
      to_pipeline: 'sarvam_transcription',
      reason: 'user',
      active: 'fallback',
      is_fallback: true,
    });

    expect(onProviderSwitched).toHaveBeenCalledWith({
      fromPipeline: 'pipe-1',
      toPipeline: 'sarvam_transcription',
      reason: 'user',
      active: 'fallback',
      isFallback: true,
    });
  });

  it('forwards active=primary / is_fallback=false on a switch BACK to primary', () => {
    captured.onStatus?.({
      type: 'status',
      status: 'provider_switched',
      from_pipeline: 'sarvam_transcription',
      to_pipeline: 'pipe-1',
      reason: 'user',
      active: 'primary',
      is_fallback: false,
    });

    expect(onProviderSwitched).toHaveBeenCalledWith({
      fromPipeline: 'sarvam_transcription',
      toPipeline: 'pipe-1',
      reason: 'user',
      active: 'primary',
      isFallback: false,
    });
  });

  it('ignores non-switch status frames', () => {
    captured.onStatus?.({ type: 'status', status: 'finalizing', message: 'wrapping up' });
    expect(onProviderSwitched).not.toHaveBeenCalled();
  });
});
