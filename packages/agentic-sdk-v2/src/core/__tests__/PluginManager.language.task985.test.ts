/**
 * TASK-985 QW-2 / M-02 — the SDK must not manufacture a language opinion.
 *
 * ⚠ MERGE HAZARD, restated where an engineer will meet it: the literals these
 * tests forbid were MASKING a server-side prompt defect. `languageMode: 'auto'`
 * resolves to an unprompted decode; the agent's own configured mode resolves to
 * a pair-primed one that scores far worse on the same audio. Removing the
 * defaults is correct AND it uncovers that. Ship this with the
 * prompt-configuration fix, not ahead of it. TASK-985 §2.7.
 *
 * The mechanism: the STT service backfills with `if not language_mode:`, and
 * `'auto'` is a non-empty string — so it is truthy, and it is also a REAL
 * catalog entry, not a "no opinion" sentinel. Sending it does not mean "you
 * decide"; it means "decode with no language, and ignore the agent". The only
 * way to say nothing is to send no field, which `JSON.stringify` does for
 * `undefined`.
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

describe('PluginManager — language/languageMode are only sent when declared (TASK-985 QW-2)', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager({ stt: { enabled: true, provider: 'backend' } }, createMockLogger(), makeApiClient(), false);
  });

  it('resolves BOTH to undefined when nothing — runtime option, preference or plugin config — expressed one', () => {
    const config = manager.getTranscriptionPipelineConfig();

    expect(config.stt.language).toBeUndefined();
    expect(config.stt.languageMode).toBeUndefined();
  });

  it('serializes to a session body carrying NEITHER key — the shape the backend reads as "no opinion"', () => {
    const config = manager.getTranscriptionPipelineConfig();

    // What actually goes on the wire: an `undefined` field is omitted by
    // JSON.stringify, which is exactly the absence the backfill tests for.
    const body = JSON.parse(JSON.stringify({ sampleRate: 16000, language: config.stt.language, languageMode: config.stt.languageMode }));

    expect(body).not.toHaveProperty('language');
    expect(body).not.toHaveProperty('languageMode');
    expect(body).toEqual({ sampleRate: 16000 });
  });

  it('still forwards an EXPLICIT per-capture declaration verbatim — this is not "ignore the clinician"', () => {
    manager.setRuntimeOptions({ language: 'ml', languageMode: 'ml-en' });
    const config = manager.getTranscriptionPipelineConfig();

    expect(config.stt.language).toBe('ml');
    expect(config.stt.languageMode).toBe('ml-en');
  });

  it('honours a user preference when no per-capture option was given', () => {
    manager.setUserPreferences({ language: 'ml' } as Parameters<typeof manager.setUserPreferences>[0]);
    const config = manager.getTranscriptionPipelineConfig();

    expect(config.stt.language).toBe('ml');
    // A language preference is not a MODE preference; the agent still decides.
    expect(config.stt.languageMode).toBeUndefined();
  });

  it('honours a static plugin-config language, and a runtime option still beats it', () => {
    const configured = new PluginManager(
      { stt: { enabled: true, provider: 'backend', language: 'en', languageMode: 'en' } },
      createMockLogger(),
      makeApiClient(),
      false,
    );

    expect(configured.getTranscriptionPipelineConfig().stt.language).toBe('en');
    expect(configured.getTranscriptionPipelineConfig().stt.languageMode).toBe('en');

    configured.setRuntimeOptions({ language: 'ml', languageMode: 'ml-en' });
    expect(configured.getTranscriptionPipelineConfig().stt.language).toBe('ml');
    expect(configured.getTranscriptionPipelineConfig().stt.languageMode).toBe('ml-en');
  });
});
