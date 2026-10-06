/**
 * TASK-1048 — PluginManager routes the session-creation `warnings` and the runtime `status`
 * degradations (`degraded` + reason, `denoise_degraded`) onto the plugin callback bus.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn() }));

const captured: Record<string, ((...args: any[]) => void) | undefined> = {};

vi.mock('../StreamingSessionManager', () => ({
  StreamingSessionManager: class {
    refreshTicket = vi.fn(async () => 'ticket');
    bindControlChannel = vi.fn();
    onSessionCreated(cb: (response: unknown) => void) {
      captured.onSessionCreated = cb;
    }
  },
}));

vi.mock('../SttWebSocketClient', () => ({
  SttWebSocketClient: class {
    onDisconnect() {}
    onReconnect() {}
    onReconnected() {}
    onReconnectFailed() {}
    onGap() {}
    onStatus(cb: (status: unknown) => void) {
      captured.onStatus = cb;
    }
  },
}));

import { PluginManager } from '../PluginManager';
import { createMockLogger } from '../../__tests__/setup';
import type { AgenticClient } from '../AgenticClient';
import type { AsrSessionWarning } from '@arcaai/types';
import type { AsrDegradation } from '../../types/stt';

const apiClient = { post: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn(), getBaseUrl: vi.fn(() => 'https://api.test') } as unknown as AgenticClient;

describe('PluginManager — ASR warnings & degradations (TASK-1048)', () => {
  let onSttSessionWarnings: ReturnType<typeof vi.fn<(warnings: AsrSessionWarning[]) => void>>;
  let onSttDegraded: ReturnType<typeof vi.fn<(degradation: AsrDegradation) => void>>;

  beforeEach(() => {
    for (const k of Object.keys(captured)) delete captured[k];
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', language: 'en' } }, createMockLogger(), apiClient, false);
    onSttSessionWarnings = vi.fn<(warnings: AsrSessionWarning[]) => void>();
    onSttDegraded = vi.fn<(degradation: AsrDegradation) => void>();
    manager.setCallbacks({ onSttSessionWarnings, onSttDegraded });
    manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'pipe-1');
  });

  it('forwards the warnings of a created session', () => {
    const w = [{ code: 'VAD_MODEL_MISSING', stage: 'vad', severity: 'WARNING', message: 'm', agentSlug: 'a' }];
    captured.onSessionCreated?.({ sessionId: 's', warnings: w });
    expect(onSttSessionWarnings).toHaveBeenCalledWith(w);
  });

  it('fires with [] when the gateway sent none, so a new session resets the old list', () => {
    captured.onSessionCreated?.({ sessionId: 's' });
    expect(onSttSessionWarnings).toHaveBeenCalledWith([]);
  });

  it('maps a degraded status frame to onSttDegraded with its reason and message', () => {
    captured.onStatus?.({ type: 'status', status: 'degraded', reason: 'diarization_unavailable', message: 'no embedder' });
    expect(onSttDegraded).toHaveBeenCalledTimes(1);
    const arg = onSttDegraded.mock.calls[0][0];
    expect(arg.reason).toBe('diarization_unavailable');
    expect(arg.detail).toBe('no embedder');
    expect(typeof arg.at).toBe('number');
  });

  it('maps denoise_degraded to onSttDegraded (reason falls back to the status name)', () => {
    captured.onStatus?.({ type: 'status', status: 'denoise_degraded', reason: 'engine_failed', engine: 'x', detail: 'boom' });
    expect(onSttDegraded.mock.calls[0][0]).toMatchObject({ reason: 'engine_failed', detail: 'boom' });
    captured.onStatus?.({ type: 'status', status: 'denoise_degraded' });
    expect(onSttDegraded.mock.calls[1][0].reason).toBe('denoise_degraded');
  });

  it('ignores a degraded frame without a reason and unrelated statuses', () => {
    captured.onStatus?.({ type: 'status', status: 'degraded' });
    captured.onStatus?.({ type: 'status', status: 'connected' });
    expect(onSttDegraded).not.toHaveBeenCalled();
  });
});
