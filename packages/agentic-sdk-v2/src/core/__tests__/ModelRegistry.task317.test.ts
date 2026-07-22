/**
 * ModelRegistry selected-models storage.
 *
 *  - `SELECTED_MODELS` reads/writes are namespaced
 *    `arcaai-selected-models/${tenantId}::${userId}`, not a shared global key.
 *  - The parsed JSON is validated with a valibot schema
 *    (`{ stt?, vad?, ner? }` of strings); a poisoned/typed-wrong payload yields
 *    `null` + a `logger.warn` rather than throwing on construction.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelRegistry } from '../ModelRegistry';
import { AgenticClient } from '../AgenticClient';
import { createMockLogger } from '../../__tests__/setup';

const NS_A = 'tenantA::userA';
const NS_B = 'tenantB::userB';

describe('ModelRegistry SELECTED_MODELS namespacing', () => {
  let mockApiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockApiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'k' }, mockLogger);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('writes a selection to the namespaced key, never the bare global key', () => {
    const reg = new ModelRegistry({}, mockApiClient, mockLogger, NS_A);

    reg.selectModel('stt', 'whisper-tiny');

    expect(localStorage.getItem('arcaai-selected-models/tenantA::userA')).toContain('whisper-tiny');
    // The unscoped global key must never be written.
    expect(localStorage.getItem('arcaai-selected-models')).toBeNull();
  });

  it('isolates selections across namespaces (no cross-read)', () => {
    localStorage.setItem('arcaai-selected-models/tenantA::userA', JSON.stringify({ stt: 'whisper-tiny' }));
    localStorage.setItem('arcaai-selected-models/tenantB::userB', JSON.stringify({ stt: 'whisper-base' }));

    const a = new ModelRegistry({}, mockApiClient, mockLogger, NS_A);
    const b = new ModelRegistry({}, mockApiClient, mockLogger, NS_B);

    expect(a.getSelectedModelId('stt')).toBe('whisper-tiny');
    expect(b.getSelectedModelId('stt')).toBe('whisper-base');
  });
});

describe('ModelRegistry loadSelectedFromStorage validation', () => {
  let mockApiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockApiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'k' }, mockLogger);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('loads a well-formed selection', () => {
    localStorage.setItem('arcaai-selected-models/tenantA::userA', JSON.stringify({ stt: 'whisper-tiny', vad: 'silero-vad-v5' }));

    const reg = new ModelRegistry({}, mockApiClient, mockLogger, NS_A);

    expect(reg.getSelectedModelId('stt')).toBe('whisper-tiny');
    expect(reg.getSelectedModelId('vad')).toBe('silero-vad-v5');
  });

  it.each([
    ['wrong-typed field', JSON.stringify({ stt: 123 })],
    ['non-object payload', JSON.stringify('not-an-object')],
    ['array payload', JSON.stringify([1, 2, 3])],
    ['nested object field', JSON.stringify({ vad: { nested: true } })],
    ['unparseable JSON', '{not valid json'],
  ])('discards %s, returning null + warn and falling back to config.selected', (_label, poison) => {
    localStorage.setItem('arcaai-selected-models/tenantA::userA', poison);

    const reg = new ModelRegistry({ selected: { stt: 'whisper-base' } }, mockApiClient, mockLogger, NS_A);

    // Poisoned storage is ignored → falls back to config.selected.
    expect(reg.getSelectedModelId('stt')).toBe('whisper-base');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('never throws on a poisoned payload during construction', () => {
    localStorage.setItem('arcaai-selected-models/tenantA::userA', '{"stt":{"deep":1}}');

    expect(() => new ModelRegistry({}, mockApiClient, mockLogger, NS_A)).not.toThrow();
  });
});
