/**
 * PluginManager — streaming-transport wiring
 *
 * Verifies that `getTranscriptionPipelineConfig()` builds a
 * `streamingTransport` (StreamingSessionManager + SttWebSocketClient)
 * when a runtime `pipelineId` has been set via `setRuntimeOptions(...)`,
 * and forwards `consultationId` correctly. The legacy path (no pipelineId)
 * must remain unaffected.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';
import { createMockLogger } from '../../__tests__/setup';
import type { AgenticClient } from '../AgenticClient';

vi.mock('@arcaai/noise-filter', () => ({ createNoiseFilter: vi.fn() }));
vi.mock('@arcaai/vad', () => ({ createVAD: vi.fn() }));
vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn() }));
vi.mock('@arcaai/med-ner', () => ({ createMedNER: vi.fn() }));

function makeApiClient(): AgenticClient {
  return {
    post: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getBaseUrl: vi.fn(() => 'https://api.test'),
  } as unknown as AgenticClient;
}

describe('PluginManager.buildStreamingTransport', () => {
  let manager: PluginManager;
  let apiClient: AgenticClient;

  beforeEach(() => {
    apiClient = makeApiClient();
    manager = new PluginManager(
      {
        stt: { enabled: true, provider: 'backend', language: 'en' },
      },
      createMockLogger(),
      apiClient,
      false,
    );
  });

  it('returns undefined when no runtime pipelineId is set', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, undefined);
    expect(transport).toBeUndefined();
  });

  it('returns undefined when apiClient is missing even with a pipelineId', () => {
    const noClient = new PluginManager(
      { stt: { enabled: true, provider: 'backend' } },
      createMockLogger(),
      undefined,
      false,
    );
    const transport = noClient.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'pipe-1');
    expect(transport).toBeUndefined();
  });

  it('returns undefined for local providers regardless of pipelineId', () => {
    const transport = manager.buildStreamingTransport(
      { enabled: true, provider: 'local', modelId: 'whisper-tiny' },
      'pipe-1',
    );
    expect(transport).toBeUndefined();
  });

  it('builds a transport with a sessionManager, wsClient and the pipelineId', () => {
    const transport = manager.buildStreamingTransport(
      { enabled: true, provider: 'backend' },
      'pipe-1',
    ) as {
      sessionManager: unknown;
      wsClient: unknown;
      pipelineId: string;
      consultationId?: string;
    };

    expect(transport).toBeTruthy();
    expect(transport.pipelineId).toBe('pipe-1');
    expect(transport.sessionManager).toBeTruthy();
    expect(transport.wsClient).toBeTruthy();
    expect(transport.consultationId).toBeUndefined();
  });

  it('forwards consultationId from runtime options when set', () => {
    manager.setRuntimeOptions({ pipelineId: 'pipe-A', consultationId: 'cons-7' });
    const transport = manager.buildStreamingTransport(
      { enabled: true, provider: 'backend' },
      'pipe-A',
    ) as { pipelineId: string; consultationId?: string };

    expect(transport.consultationId).toBe('cons-7');
  });
});

describe('PluginManager.getTranscriptionPipelineConfig', () => {
  let manager: PluginManager;
  let apiClient: AgenticClient;

  beforeEach(() => {
    apiClient = makeApiClient();
    manager = new PluginManager(
      {
        stt: { enabled: true, provider: 'backend', language: 'en' },
      },
      createMockLogger(),
      apiClient,
      false,
    );
  });

  it('injects streamingTransport on stt config when runtime pipelineId is set', () => {
    manager.setRuntimeOptions({ pipelineId: 'p-runtime', consultationId: 'cons-9' });

    const cfg = manager.getTranscriptionPipelineConfig();

    expect(cfg.stt.pipelineId).toBe('p-runtime');
    expect(cfg.stt.streamingTransport).toBeTruthy();
    const t = cfg.stt.streamingTransport as { pipelineId: string; consultationId?: string };
    expect(t.pipelineId).toBe('p-runtime');
    expect(t.consultationId).toBe('cons-9');
  });

  it('does not inject streamingTransport when runtime pipelineId is absent', () => {
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.streamingTransport).toBeUndefined();
  });

  it('runtime language overrides static stt.language', () => {
    manager.setRuntimeOptions({ pipelineId: 'p', language: 'th' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.language).toBe('th');
  });

  it('clearRuntimeOptions() wipes runtime overrides', () => {
    manager.setRuntimeOptions({ pipelineId: 'p', consultationId: 'c', language: 'th' });
    manager.clearRuntimeOptions();
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.pipelineId).toBeUndefined();
    expect(cfg.stt.streamingTransport).toBeUndefined();
  });
});

// The server-resolved EFFECTIVE transcription mode (injected
// by AgenticProvider into resolvedConfig.stt.transcriptionMode) must reach the
// pipeline config so TranscriptionPipeline.resolveSTTRuntimeProvider() honors it.
describe('PluginManager — transcriptionMode passthrough', () => {
  it('forwards stt.transcriptionMode into the pipeline config when set', () => {
    const manager = new PluginManager(
      { stt: { enabled: true, provider: 'backend', transcriptionMode: 'LOCAL' } },
      createMockLogger(),
      makeApiClient(),
      false,
    );

    const cfg = manager.getTranscriptionPipelineConfig();

    expect(cfg.stt.transcriptionMode).toBe('LOCAL');
  });

  it('leaves transcriptionMode undefined when the resolved config has none (back-compat)', () => {
    const manager = new PluginManager(
      { stt: { enabled: true, provider: 'backend' } },
      createMockLogger(),
      makeApiClient(),
      false,
    );

    const cfg = manager.getTranscriptionPipelineConfig();

    expect(cfg.stt.transcriptionMode).toBeUndefined();
  });
});
