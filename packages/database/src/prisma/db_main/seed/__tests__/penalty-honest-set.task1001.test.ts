/**
 * TASK-1001 OD-10 — `supportedGenerationParams` is the HONEST set: what this platform can actually
 * deliver to a provider, per row. The publish gate compares an agent's `parameters.generation`
 * keys against it, so it is load-bearing in BOTH directions:
 *
 *  - a penalty that now reaches an engine but is NOT declared blocks a tenant from publishing the
 *    one agent-level fix for repeated sentences on the model the owner chose to keep (OD-7);
 *  - a penalty declared on an engine that REJECTS it lets an author publish a parameter that turns
 *    every call into a provider 400 — worse than the silent drop the honest set was built to stop.
 *
 * Per engine:
 *  - LM Studio (`lm-studio`, OpenAI-compatible `/v1/chat/completions` over llama.cpp): accepts
 *    `frequency_penalty` / `presence_penalty` and maps them onto llama.cpp's sampler — DECLARED.
 *  - Azure OpenAI `gpt-5.4-mini`: a GPT-5-family REASONING deployment, for which the Azure/OpenAI
 *    APIs refuse `presence_penalty` / `frequency_penalty` as unsupported — NOT declared.
 *  - granite-guardian: a GUARDRAIL row with no generation capability set at all — untouched.
 */
import { describe, expect, it } from 'vitest';

import { LLM_AI_MODELS } from '../ai-models/llm';

const PENALTIES = ['frequencyPenalty', 'presencePenalty'] as const;

function declared(slug: string): readonly string[] | undefined {
  const row = LLM_AI_MODELS.find((model) => model.slug === slug);
  if (!row) throw new Error(`'${slug}' is not a row of LLM_AI_MODELS`);
  const params = (row.metaData as Record<string, unknown> | undefined)?.supportedGenerationParams;
  return Array.isArray(params) ? (params as string[]) : undefined;
}

describe('TASK-1001 — the honest generation set declares penalties only where an engine accepts them', () => {
  it.each(['lms-gemma-4-e2b-it-qat', 'lms-gemma-4-e4b'])('%s (LM Studio, OpenAI-compatible) declares both penalties', (slug) => {
    const params = declared(slug);
    for (const penalty of PENALTIES) expect(params, `${slug} → ${penalty}`).toContain(penalty);
  });

  it.each(['lms-gemma-4-e2b-it-qat', 'lms-gemma-4-e4b'])('%s keeps the rest of its set unchanged', (slug) => {
    const params = declared(slug);
    for (const kept of ['temperature', 'maxTokens', 'topP', 'reasoning']) expect(params, `${slug} → ${kept}`).toContain(kept);
    // Still not claimed: nothing on the TEXT plane forwards these to a provider.
    for (const never of ['seed', 'stopSequences']) expect(params, `${slug} → ${never}`).not.toContain(never);
  });

  it('the Azure GPT-5 reasoning deployment does NOT declare a penalty (the engine refuses them)', () => {
    const params = declared('azure-gpt-5.4-mini');
    expect(params).toEqual(['temperature', 'maxTokens', 'topP']);
    for (const penalty of PENALTIES) expect(params).not.toContain(penalty);
  });

  it('the guardrail row declares no generation set, penalties included', () => {
    expect(declared('granite-guardian-4.1-8b')).toBeUndefined();
  });

  it('every row that declares a penalty declares BOTH — they reach the wire together', () => {
    for (const model of LLM_AI_MODELS) {
      const params = declared(model.slug) ?? [];
      const present = PENALTIES.filter((penalty) => params.includes(penalty));
      expect(present.length === 0 || present.length === PENALTIES.length, model.slug).toBe(true);
    }
  });
});
