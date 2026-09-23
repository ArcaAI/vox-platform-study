/**
 * buildTextGeneratePayload — structured SOAP output forwarding
 *
 * Proves the assembled `responseFormat` (json_schema) actually reaches the TEXT
 * provider payload for non-Ollama providers, and is suppressed for Ollama
 * (which does not accept OpenAI-style response_format).
 */

import { describe, it, expect } from 'vitest';
import { buildTextGeneratePayload } from '../text-generate';
import type { AssembledPrompt } from '../../prompt/prompt-assembly.service';

const SOAP_RESPONSE_FORMAT: AssembledPrompt['responseFormat'] = {
  type: 'json_schema',
  strict: true,
  json_schema: {
    title: 'SOAPNote',
    type: 'object',
    properties: {
      subjective: { type: 'string' },
      objective: { type: 'string' },
      assessment: { type: 'string' },
      plan: { type: 'string' },
    },
    required: ['subjective', 'objective', 'assessment', 'plan'],
  },
};

function makeAssembledPrompt(overrides: Partial<AssembledPrompt> = {}): AssembledPrompt {
  return {
    userPrompt: 'Summarize the consultation.',
    systemPrompt: 'You are a medical scribe AI assistant.',
    hyperparameters: { temperature: 0.1, max_tokens: 6000, top_p: 0.95 },
    responseFormat: SOAP_RESPONSE_FORMAT,
    resolvedFrom: 'department',
    ...overrides,
  };
}

describe('buildTextGeneratePayload — SOAP json_schema forwarding', () => {
  it('forwards response_format (json_schema) for non-Ollama providers', () => {
    const payload = buildTextGeneratePayload(makeAssembledPrompt(), { provider: 'openai' });

    expect(payload.response_format).toBeDefined();
    expect(payload.response_format).not.toBeUndefined();
    expect(payload.response_format!.type).toBe('json_schema');
    expect(payload.response_format!.json_schema.title).toBe('SOAPNote');
    expect(payload.response_format!.strict).toBe(true);
  });

  it('omits response_format for the Ollama provider', () => {
    const payload = buildTextGeneratePayload(makeAssembledPrompt(), { provider: 'ollama' });

    expect(payload.response_format).toBeUndefined();
  });

  it('treats provider case-insensitively (OLLAMA suppressed)', () => {
    const payload = buildTextGeneratePayload(makeAssembledPrompt(), { provider: 'OLLAMA' });

    expect(payload.response_format).toBeUndefined();
  });

  it('omits response_format when the assembled prompt has none (no schema)', () => {
    const payload = buildTextGeneratePayload(makeAssembledPrompt({ responseFormat: null }), { provider: 'openai' });

    expect(payload.response_format).toBeUndefined();
  });
});

/**
 * TASK-1001 OD-10 — decode-time repetition pressure reaches the `/generate` body the same way
 * `top_p` does: from the caller's options first, then the assembled prompt's hyperparameters,
 * both spellings accepted. ABSENT means the key is not sent at all, so TEXT applies the platform
 * default (`text.generation.frequencyPenalty` / `.presencePenalty`) — sending `null`, or a
 * synthesised `0`, would override that default with an opinion nobody stated.
 */
describe('buildTextGeneratePayload — repetition penalties (TASK-1001)', () => {
  /** What actually crosses the wire: axios JSON-serialises the body. */
  const wire = (payload: unknown) => JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  it('forwards penalties authored on the prompt hyperparameters (snake_case)', () => {
    const payload = buildTextGeneratePayload(
      makeAssembledPrompt({ hyperparameters: { temperature: 0.1, frequency_penalty: 0.4, presence_penalty: 0.2 } }),
      { provider: 'lm-studio' },
    );

    expect(wire(payload)).toMatchObject({ frequency_penalty: 0.4, presence_penalty: 0.2 });
  });

  it('accepts the camelCase spelling an Agent`s `parameters.generation` uses', () => {
    const payload = buildTextGeneratePayload(
      makeAssembledPrompt({ hyperparameters: { frequencyPenalty: 0.5, presencePenalty: -0.1 } }),
      { provider: 'lm-studio' },
    );

    expect(wire(payload)).toMatchObject({ frequency_penalty: 0.5, presence_penalty: -0.1 });
  });

  it('a caller-supplied value wins over the prompt hyperparameters, exactly like top_p', () => {
    const payload = buildTextGeneratePayload(
      makeAssembledPrompt({ hyperparameters: { frequency_penalty: 0.4, presence_penalty: 0.2 } }),
      { provider: 'lm-studio', frequencyPenalty: 0.9, presence_penalty: 0 },
    );

    // `0` is a deliberate value, not an absence: it travels.
    expect(wire(payload)).toMatchObject({ frequency_penalty: 0.9, presence_penalty: 0 });
  });

  it('OMITS both keys when nobody authored one, so TEXT applies the platform default', () => {
    const payload = buildTextGeneratePayload(makeAssembledPrompt(), { provider: 'lm-studio' });

    expect(wire(payload)).not.toHaveProperty('frequency_penalty');
    expect(wire(payload)).not.toHaveProperty('presence_penalty');
    expect('frequency_penalty' in payload).toBe(false);
    expect('presence_penalty' in payload).toBe(false);
  });
});
