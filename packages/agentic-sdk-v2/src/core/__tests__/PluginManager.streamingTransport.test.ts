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

  it("returns undefined when nothing is named and the provider is 'auto' (pre-865 resolution kept)", () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'auto' }, undefined);
    expect(transport).toBeUndefined();
  });

  it("an EXPLICIT 'backend' provider with nothing named still gets a transport — the gateway resolves the tenant default agent (TASK-865)", () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, undefined) as { pipelineId?: string; agentSlug?: string };
    expect(transport).toBeTruthy();
    expect(transport.pipelineId).toBeUndefined();
    expect(transport.agentSlug).toBeUndefined();
  });

  it('a legacy sttSocket consumer that names nothing keeps the RemoteSTTProvider path (no transport)', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend', sttSocket: 'wss://legacy/ws' }, undefined);
    expect(transport).toBeUndefined();
  });

  it('returns undefined when apiClient is missing even with a pipelineId', () => {
    const noClient = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), undefined, false);
    const transport = noClient.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'pipe-1');
    expect(transport).toBeUndefined();
  });

  it('returns undefined for local providers regardless of pipelineId', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'local', modelId: 'whisper-tiny' }, 'pipe-1');
    expect(transport).toBeUndefined();
  });

  it('builds a transport with a sessionManager, wsClient and the pipelineId', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'pipe-1') as {
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

  it('passes the tenant claim setting to the streaming client', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend', requireTenantClaim: false }, 'pipe-1') as {
      wsClient: { reconnectOptions: { requireTenantClaim: boolean } };
    };

    expect(transport.wsClient.reconnectOptions.requireTenantClaim).toBe(false);
  });

  it('forwards consultationId from runtime options when set', () => {
    manager.setRuntimeOptions({ pipelineId: 'pipe-A', consultationId: 'cons-7' });
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'pipe-A') as {
      pipelineId: string;
      consultationId?: string;
    };

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

  it('injects a selector-less streamingTransport when nothing is named (explicit backend provider; TASK-865)', () => {
    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { pipelineId?: string; agentSlug?: string } | undefined;
    expect(transport).toBeTruthy();
    expect(transport?.pipelineId).toBeUndefined();
    expect(transport?.agentSlug).toBeUndefined();
  });

  it('runtime language overrides static stt.language', () => {
    manager.setRuntimeOptions({ pipelineId: 'p', language: 'th' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.language).toBe('th');
  });

  it('threads the pre-start startOn runtime option into the stt config', () => {
    manager.setRuntimeOptions({ pipelineId: 'p', startOn: 'fallback' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect((cfg.stt as { startOn?: 'primary' | 'fallback' }).startOn).toBe('fallback');
  });

  it('omits startOn from the stt config when no runtime selection is set', () => {
    manager.setRuntimeOptions({ pipelineId: 'p' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect((cfg.stt as { startOn?: 'primary' | 'fallback' }).startOn).toBeUndefined();
  });

  it("defaults languageMode to 'auto' when neither runtime nor static config pins one", () => {
    // Constructor stt config carries no languageMode; no runtime pick either.
    manager.setRuntimeOptions({ pipelineId: 'p' });
    const cfg = manager.getTranscriptionPipelineConfig();
    // An un-selected session must AUTO-DETECT (backend resolves 'auto' to no
    // language override) rather than fall back to a hardcoded language.
    expect(cfg.stt.languageMode).toBe('auto');
  });

  it('a runtime languageMode pick still overrides the auto default', () => {
    manager.setRuntimeOptions({ pipelineId: 'p', languageMode: 'ml-en' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.languageMode).toBe('ml-en');
  });

  it('clearRuntimeOptions() wipes runtime overrides', () => {
    manager.setRuntimeOptions({ pipelineId: 'p', agentSlug: 'a', consultationId: 'c', language: 'th' });
    manager.clearRuntimeOptions();
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.pipelineId).toBeUndefined();
    expect(cfg.stt.agentSlug).toBeUndefined();
    const transport = cfg.stt.streamingTransport as { pipelineId?: string; agentSlug?: string; consultationId?: string } | undefined;
    // The explicit backend provider still yields a transport, but a selector-less one.
    expect(transport?.pipelineId).toBeUndefined();
    expect(transport?.agentSlug).toBeUndefined();
    expect(transport?.consultationId).toBeUndefined();
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
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), makeApiClient(), false);

    const cfg = manager.getTranscriptionPipelineConfig();

    expect(cfg.stt.transcriptionMode).toBeUndefined();
  });
});

describe('PluginManager — agentSlug selects the ASR Agent (TASK-865)', () => {
  let apiClient: AgenticClient;

  beforeEach(() => {
    apiClient = makeApiClient();
  });

  it('builds the streaming transport from an agentSlug alone (no pipelineId anywhere)', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), apiClient, false);
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, undefined, 'clinic-asr') as {
      pipelineId?: string;
      agentSlug?: string;
    };

    expect(transport).toBeTruthy();
    expect(transport.agentSlug).toBe('clinic-asr');
    expect(transport.pipelineId).toBeUndefined();
  });

  it('threads the runtime agentSlug into the pipeline config and its transport', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), apiClient, false);
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', consultationId: 'c-1' });

    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string; pipelineId?: string; consultationId?: string };

    expect(cfg.stt.agentSlug).toBe('clinic-asr');
    expect(cfg.stt.pipelineId).toBeUndefined();
    expect(transport.agentSlug).toBe('clinic-asr');
    expect(transport.pipelineId).toBeUndefined();
    expect(transport.consultationId).toBe('c-1');
  });

  it('a runtime agentSlug WINS over a static stt.pipelineId — the two are never both sent', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', pipelineId: 'static-pipe' } }, createMockLogger(), apiClient, false);
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr' });

    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string; pipelineId?: string };

    expect(cfg.stt.agentSlug).toBe('clinic-asr');
    expect(cfg.stt.pipelineId).toBeUndefined();
    expect(transport.agentSlug).toBe('clinic-asr');
    expect(transport.pipelineId).toBeUndefined();
  });

  it('a static stt.agentSlug is honoured when no runtime option names one', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend', agentSlug: 'static-agent' } }, createMockLogger(), apiClient, false);

    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.agentSlug).toBe('static-agent');
    expect((cfg.stt.streamingTransport as { agentSlug?: string }).agentSlug).toBe('static-agent');
  });

  it('a backend provider with an apiClient but NO agent and NO pipeline still gets a transport (the gateway resolves the tenant default)', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), apiClient, false);

    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string; pipelineId?: string } | undefined;

    expect(transport).toBeTruthy();
    expect(transport?.agentSlug).toBeUndefined();
    expect(transport?.pipelineId).toBeUndefined();
  });

  it("provider 'auto' with neither id keeps the legacy no-transport behaviour (nothing asked for the backend)", () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'auto' } }, createMockLogger(), apiClient, false);
    expect(manager.getTranscriptionPipelineConfig().stt.streamingTransport).toBeUndefined();
  });
});
