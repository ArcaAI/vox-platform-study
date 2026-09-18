/**
 * TASK-985 — what the streaming provider puts on the wire, and what it carries
 * back off it.
 *
 * - QW-2 / M-02: an undeclared language must reach the session body as an
 *   ABSENT key, not as a literal. The backend backfills with
 *   `if not language_mode:`, so any literal — `'en'`, `'auto'` — is an opinion
 *   that outranks the tenant's ASR agent.
 *   ⚠ MERGE HAZARD: those literals were masking a server-side prompt defect.
 *   Land this with the prompt-configuration fix. TASK-985 §2.7.
 * - M-22: an OPEN socket is not a ready one. The gateway registers its
 *   result-stream handler and only then emits `ready`; audio sent before that
 *   is ingested with nothing listening for its results.
 * - M-27 (transport half): `stableChars` / `utteranceIndex` must survive the
 *   `@arcaai/stt` hop. Carried, never rendered on — today's server-side
 *   `stableChars` is not monotone, so a UI that split on it would make an
 *   invisible server defect visible as text that un-commits itself.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';

import { StreamingBackendSTTProvider, type StreamingTranscriptPayload } from '../providers/StreamingBackendSTTProvider.js';
import type { TranscriptionResult } from '../types/index.js';

type SessionRequest = Record<string, unknown>;

function makeHarness(options: { whenReady?: () => Promise<void> } = {}) {
  const createSession = vi.fn(async (_request: SessionRequest) => ({
    sessionId: 's-1',
    wsUrl: 'ws://localhost/ws',
    ticket: 't',
    maxConcurrent: 1,
    currentActive: 1,
    status: 'active',
  }));
  const sessionManager = {
    createSession,
    getWebSocketUrl: () => 'ws://localhost/ws?sessionId=s-1',
    closeSession: async () => undefined,
    getSessionId: () => 's-1',
  };

  const order: string[] = [];
  const captured: { transcript?: (payload: StreamingTranscriptPayload) => void } = {};
  const wsClient = {
    connect: vi.fn(async () => {
      order.push('connect');
    }),
    isConnected: () => true,
    sendAudioFrame: () => true,
    sendStop: () => undefined,
    disconnect: () => undefined,
    onTranscript: (cb: (payload: StreamingTranscriptPayload) => void) => {
      captured.transcript = cb;
    },
    onWsError: () => undefined,
    ...(options.whenReady
      ? {
          whenReady: vi.fn(async () => {
            order.push('whenReady');
            await options.whenReady!();
          }),
        }
      : {}),
  };

  const provider = new StreamingBackendSTTProvider({
    sessionManager,
    wsClient,
  } as unknown as ConstructorParameters<typeof StreamingBackendSTTProvider>[0]);

  return { provider, createSession, wsClient, order, captured };
}

/** Let every pending microtask AND timer turn settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The wire body, as `JSON.stringify` would actually render it. */
function wireBody(createSession: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return JSON.parse(JSON.stringify(createSession.mock.calls[0]![0])) as Record<string, unknown>;
}

describe('session body — no manufactured language (TASK-985 QW-2)', () => {
  it('carries NEITHER language nor languageMode when the caller declared neither', async () => {
    const { provider, createSession } = makeHarness();

    await provider.init({ sampleRate: 16000 } as Parameters<typeof provider.init>[0]);

    const body = wireBody(createSession);
    expect(body).not.toHaveProperty('language');
    expect(body).not.toHaveProperty('languageMode');
  });

  it('forwards an explicit declaration verbatim', async () => {
    const { provider, createSession } = makeHarness();

    await provider.init({ sampleRate: 16000, language: 'ml', languageMode: 'ml-en' } as Parameters<typeof provider.init>[0]);

    const body = wireBody(createSession);
    expect(body.language).toBe('ml');
    expect(body.languageMode).toBe('ml-en');
  });
});

describe('readiness gate (TASK-985 M-22)', () => {
  it('waits for the server `ready` frame after connecting, before init resolves', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider, order } = makeHarness({ whenReady: () => gate });

    let initialized = false;
    const initializing = provider.init({ sampleRate: 16000 } as Parameters<typeof provider.init>[0]).then(() => {
      initialized = true;
    });

    await flush();
    expect(order).toEqual(['connect', 'whenReady']);
    expect(initialized).toBe(false);

    release();
    await initializing;
    expect(initialized).toBe(true);
  });

  it('starts anyway when the client cannot report readiness — an older gateway must not wedge a session', async () => {
    // No `whenReady` on the duck-typed client at all.
    const { provider } = makeHarness();
    await expect(provider.init({ sampleRate: 16000 } as Parameters<typeof provider.init>[0])).resolves.toBeUndefined();
  });

  it('starts anyway when the readiness gate rejects', async () => {
    const { provider } = makeHarness({ whenReady: () => Promise.reject(new Error('no ready frame')) });
    await expect(provider.init({ sampleRate: 16000 } as Parameters<typeof provider.init>[0])).resolves.toBeUndefined();
  });
});

describe('commit geometry survives the transport hop (TASK-985 M-27)', () => {
  function normalize(provider: StreamingBackendSTTProvider, payload: StreamingTranscriptPayload): TranscriptionResult {
    return (provider as unknown as { normalizeTranscript: (p: StreamingTranscriptPayload) => TranscriptionResult }).normalizeTranscript(payload);
  }

  const partial: StreamingTranscriptPayload = {
    type: 'transcript',
    text: 'the patient reports chest pain',
    startTime: 1,
    endTime: 2,
    isFinal: false,
  };

  it('carries stableChars and utteranceIndex through', () => {
    const { provider } = makeHarness();

    const result = normalize(provider, { ...partial, stableChars: 11, utteranceIndex: 3 });

    expect(result.stableChars).toBe(11);
    expect(result.utteranceIndex).toBe(3);
  });

  it('preserves a stableChars of 0 — "nothing is settled yet" is a real answer', () => {
    const { provider } = makeHarness();

    const result = normalize(provider, { ...partial, stableChars: 0, utteranceIndex: 0 });

    expect(result.stableChars).toBe(0);
    expect(result.utteranceIndex).toBe(0);
  });

  it('leaves both keys ABSENT on a backend that does not publish them — absent is not zero', () => {
    const { provider } = makeHarness();

    const result = normalize(provider, partial);

    expect('stableChars' in result).toBe(false);
    expect('utteranceIndex' in result).toBe(false);
  });
});
