/**
 * buildSmrGeneratePayload — structured SOAP output forwarding
 *
 * Proves the assembled `responseFormat` (json_schema) actually reaches the SMR
 * provider payload for non-Ollama providers, and is suppressed for Ollama
 * (which does not accept OpenAI-style response_format).
 */

import { describe, it, expect } from 'vitest';
import { buildSmrGeneratePayload } from '../text-generate';
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

describe('buildSmrGeneratePayload — SOAP json_schema forwarding', () => {
  it('forwards response_format (json_schema) for non-Ollama providers', () => {
    const payload = buildSmrGeneratePayload(makeAssembledPrompt(), { provider: 'openai' });

    expect(payload.response_format).toBeDefined();
    expect(payload.response_format).not.toBeUndefined();
    expect(payload.response_format!.type).toBe('json_schema');
    expect(payload.response_format!.json_schema.title).toBe('SOAPNote');
    expect(payload.response_format!.strict).toBe(true);
  });

  it('omits response_format for the Ollama provider', () => {
    const payload = buildSmrGeneratePayload(makeAssembledPrompt(), { provider: 'ollama' });

    expect(payload.response_format).toBeUndefined();
  });

  it('treats provider case-insensitively (OLLAMA suppressed)', () => {
    const payload = buildSmrGeneratePayload(makeAssembledPrompt(), { provider: 'OLLAMA' });

    expect(payload.response_format).toBeUndefined();
  });

  it('omits response_format when the assembled prompt has none (no schema)', () => {
    const payload = buildSmrGeneratePayload(makeAssembledPrompt({ responseFormat: null }), { provider: 'openai' });

    expect(payload.response_format).toBeUndefined();
  });
});
