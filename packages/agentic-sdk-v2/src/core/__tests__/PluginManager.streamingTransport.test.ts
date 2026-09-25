/**
 * PluginManager — streaming-transport wiring
 *
 * Verifies that `getTranscriptionPipelineConfig()` builds a
 * `streamingTransport` (StreamingSessionManager + SttWebSocketClient)
 * when a runtime `agentSlug` has been set via `setRuntimeOptions(...)`,
 * and forwards `consultationId` correctly. The legacy path (nothing named)
 * must remain unaffected.
 *
 * TASK-1006 — `pipelineId` selection was removed (`AsrPipeline` retired
 * under TASK-861); `buildStreamingTransport` now takes `(sttConfig, agentSlug?)`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManager } from '../PluginManager';
import { createMockLogger } from '../../__tests__/setup';
import type { AgenticClient } from '../AgenticClient';

vi.mock('@arcaai/stt', () => ({ createSTT: vi.fn() }));

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
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'auto' });
    expect(transport).toBeUndefined();
  });

  it("an EXPLICIT 'backend' provider with nothing named still gets a transport — the gateway resolves the tenant default agent (TASK-865)", () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }) as { agentSlug?: string };
    expect(transport).toBeTruthy();
    expect(transport.agentSlug).toBeUndefined();
  });

  it('a legacy sttSocket consumer that names nothing keeps the RemoteSTTProvider path (no transport)', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend', sttSocket: 'wss://legacy/ws' });
    expect(transport).toBeUndefined();
  });

  it('returns undefined when apiClient is missing even with an agentSlug', () => {
    const noClient = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), undefined, false);
    const transport = noClient.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'clinic-asr');
    expect(transport).toBeUndefined();
  });

  it('builds a transport with a sessionManager, wsClient and the agentSlug', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'clinic-asr') as {
      sessionManager: unknown;
      wsClient: unknown;
      agentSlug: string;
      consultationId?: string;
    };

    expect(transport).toBeTruthy();
    expect(transport.agentSlug).toBe('clinic-asr');
    expect(transport.sessionManager).toBeTruthy();
    expect(transport.wsClient).toBeTruthy();
    expect(transport.consultationId).toBeUndefined();
  });

  it('passes the tenant claim setting to the streaming client', () => {
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend', requireTenantClaim: false }, 'clinic-asr') as {
      wsClient: { reconnectOptions: { requireTenantClaim: boolean } };
    };

    expect(transport.wsClient.reconnectOptions.requireTenantClaim).toBe(false);
  });

  it('forwards consultationId from runtime options when set', () => {
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', consultationId: 'cons-7' });
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'clinic-asr') as {
      agentSlug: string;
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

  it('injects streamingTransport on stt config when runtime agentSlug is set', () => {
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', consultationId: 'cons-9' });

    const cfg = manager.getTranscriptionPipelineConfig();

    expect(cfg.stt.agentSlug).toBe('clinic-asr');
    expect(cfg.stt.streamingTransport).toBeTruthy();
    const t = cfg.stt.streamingTransport as { agentSlug: string; consultationId?: string };
    expect(t.agentSlug).toBe('clinic-asr');
    expect(t.consultationId).toBe('cons-9');
  });

  it('injects a selector-less streamingTransport when nothing is named (explicit backend provider; TASK-865)', () => {
    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string } | undefined;
    expect(transport).toBeTruthy();
    expect(transport?.agentSlug).toBeUndefined();
  });

  it('runtime language overrides static stt.language', () => {
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', language: 'th' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.language).toBe('th');
  });

  it('threads the pre-start startOn runtime option into the stt config', () => {
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', startOn: 'fallback' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect((cfg.stt as { startOn?: 'primary' | 'fallback' }).startOn).toBe('fallback');
  });

  it('omits startOn from the stt config when no runtime selection is set', () => {
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect((cfg.stt as { startOn?: 'primary' | 'fallback' }).startOn).toBeUndefined();
  });

  it('sends NO languageMode when neither runtime nor static config pins one', () => {
    // TASK-985 (QW-2 / M-02) — this test previously asserted `'auto'`, and that
    // was the defect, not the contract. The old comment's premise ("backend
    // resolves 'auto' to no language override") is false: the backfill is
    // `if not language_mode:`, and `'auto'` is a truthy string AND a real
    // catalog entry, so the literal SKIPPED the tenant's configured ASR agent
    // instead of deferring to it. An un-selected session must send the field
    // NOT AT ALL and let the agent decide.
    //
    // The blast radius is why this matters: `'auto'` resolves to an unprompted
    // decode and the agent's `ml-en` to a pair-primed one, which measured
    // 0.885/0.935/0.918 medical_wer against 0.033/0.048/0.131 (TASK-985 §2.7).
    // The literal was accidentally shielding the clinical scribe from that.
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.languageMode).toBeUndefined();
  });

  it('a runtime languageMode pick is still honoured', () => {
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', languageMode: 'ml-en' });
    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.languageMode).toBe('ml-en');
  });

  it('clearRuntimeOptions() wipes runtime overrides', () => {
    manager.setRuntimeOptions({ agentSlug: 'a', consultationId: 'c', language: 'th' });
    manager.clearRuntimeOptions();
    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string; consultationId?: string } | undefined;
    // The explicit backend provider still yields a transport, but a selector-less one.
    expect(transport?.agentSlug).toBeUndefined();
    expect(transport?.consultationId).toBeUndefined();
  });
});

// The server-resolved EFFECTIVE transcription mode (injected
// by AgenticProvider into resolvedConfig.stt.transcriptionMode) must reach the
// pipeline config. Wire-compatible only since TASK-1006 (nothing branches on it
// any more — the local stage it used to select is gone).
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

describe('PluginManager — agentSlug selects the ASR Agent (TASK-865/TASK-1006)', () => {
  let apiClient: AgenticClient;

  beforeEach(() => {
    apiClient = makeApiClient();
  });

  it('builds the streaming transport from an agentSlug alone', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), apiClient, false);
    const transport = manager.buildStreamingTransport({ enabled: true, provider: 'backend' }, 'clinic-asr') as {
      agentSlug?: string;
    };

    expect(transport).toBeTruthy();
    expect(transport.agentSlug).toBe('clinic-asr');
  });

  it('threads the runtime agentSlug into the pipeline config and its transport', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), apiClient, false);
    manager.setRuntimeOptions({ agentSlug: 'clinic-asr', consultationId: 'c-1' });

    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string; consultationId?: string };

    expect(cfg.stt.agentSlug).toBe('clinic-asr');
    expect(transport.agentSlug).toBe('clinic-asr');
    expect(transport.consultationId).toBe('c-1');
  });

  it('a static stt.agentSlug is honoured when no runtime option names one', () => {
    const manager = new PluginManager(
      { stt: { enabled: true, provider: 'backend', agentSlug: 'static-agent' } },
      createMockLogger(),
      apiClient,
      false,
    );

    const cfg = manager.getTranscriptionPipelineConfig();
    expect(cfg.stt.agentSlug).toBe('static-agent');
    expect((cfg.stt.streamingTransport as { agentSlug?: string }).agentSlug).toBe('static-agent');
  });

  it('a backend provider with an apiClient but NO agent still gets a transport (the gateway resolves the tenant default)', () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), apiClient, false);

    const cfg = manager.getTranscriptionPipelineConfig();
    const transport = cfg.stt.streamingTransport as { agentSlug?: string } | undefined;

    expect(transport).toBeTruthy();
    expect(transport?.agentSlug).toBeUndefined();
  });

  it("provider 'auto' with no agentSlug keeps the legacy no-transport behaviour (nothing asked for the backend)", () => {
    const manager = new PluginManager({ stt: { enabled: true, provider: 'auto' } }, createMockLogger(), apiClient, false);
    expect(manager.getTranscriptionPipelineConfig().stt.streamingTransport).toBeUndefined();
  });
});
