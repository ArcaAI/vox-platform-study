import { describe, expect, it } from 'vitest';
import { contextWindowCopy } from './test-error-copy';

describe('contextWindowCopy', () => {
  it('recognises the context-window failure codes and phrases', () => {
    for (const text of ['CONTEXT_WINDOW_EXCEEDED', 'engine: kv_exhausted', 'KV cache is full']) expect(contextWindowCopy(text)).toMatch(/context window/);
  });
  it('is null for other errors and empty input', () => {
    expect(contextWindowCopy('internal error', null, undefined)).toBeNull();
  });
});
