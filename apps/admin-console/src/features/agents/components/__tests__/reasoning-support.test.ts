/**
 * TASK-970 (L3) — pins `reasoningSupportFor`'s classification table against the committed
 * cross-language contract fixture (`tests/contracts/reasoning-posture.fixture.json`), the same
 * way `packages/applications`'s `build-resolved-asr-spec.test.ts` pins the ASR spec builder
 * against `resolved-asr-spec.fixture.json`. L1 (the Python transport lane) is the sole WRITER
 * of the fixture's `support` block and must verify it against the deployed engines; this test
 * only READS it, so a future correction there (e.g. a provider's class changing once verified)
 * fails this suite loudly instead of leaving the console telling admins something stale.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reasoningSupportFor, type ReasoningSupportClass } from '../reasoning-support';

interface ReasoningPostureFixture {
  support: Record<string, { class: ReasoningSupportClass; renders: string | null; verified: boolean }>;
}

const FIXTURE_PATH = fileURLToPath(new URL('../../../../../../../tests/contracts/reasoning-posture.fixture.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as ReasoningPostureFixture;

// The fixture's `support` object carries one non-adapter key: `$comment`, documentation for
// humans reading the JSON. Every other key is a real adapter entry.
const adapterEntries = Object.entries(fixture.support).filter(([key]) => key !== '$comment');
const adapterKeys = adapterEntries.map(([key]) => key);

describe('reasoningSupportFor — the committed contract fixture', () => {
  it.each(adapterEntries)('%s: classifies exactly as the fixture declares', (adapter, expected) => {
    expect(reasoningSupportFor(adapter)?.class).toBe(expected.class);
  });

  it('covers every adapter the fixture declares — an added adapter cannot go unnoticed here', () => {
    expect(adapterKeys.sort()).toEqual(['anthropic', 'azure_openai', 'bedrock', 'llama_cpp', 'lmstudio', 'ollama', 'openai', 'openai_compat', 'vertex', 'vllm']);
  });
});

describe('reasoningSupportFor — the AiModel.provider spelling aliases (TASK-970)', () => {
  it('maps the live seeded TS provider ids onto the fixture adapter they mean', () => {
    // `azure` is the only Azure LLM provider id the catalogue seeds today (TASK-970 README §2 F-4).
    expect(reasoningSupportFor('azure')?.class).toBe(fixture.support.azure_openai.class);
    // `lm-studio` (hyphenated) and `lmstudio` are kept as deliberate aliases in
    // `ENGINE_SERVED_PROVIDERS` (packages/applications/.../ai-provider-connection/constants.ts).
    expect(reasoningSupportFor('lm-studio')?.class).toBe(fixture.support.lmstudio.class);
    expect(reasoningSupportFor('lmstudio')?.class).toBe(fixture.support.lmstudio.class);
    expect(reasoningSupportFor('llama-cpp')?.class).toBe(fixture.support.llama_cpp.class);
  });

  it('passes the fixture spelling through unchanged for the providers that already match', () => {
    for (const adapter of ['openai', 'vllm', 'ollama', 'anthropic', 'bedrock', 'vertex']) {
      expect(reasoningSupportFor(adapter)?.class).toBe(fixture.support[adapter].class);
    }
  });
});

describe('reasoningSupportFor — never fabricates a claim', () => {
  it('returns null for no provider at all', () => {
    expect(reasoningSupportFor(undefined)).toBeNull();
    expect(reasoningSupportFor(null)).toBeNull();
    expect(reasoningSupportFor('')).toBeNull();
  });

  it('returns null for a provider id this table does not recognise, rather than guessing', () => {
    expect(reasoningSupportFor('a-future-engine-nobody-seeded-yet')).toBeNull();
  });

  it('carries a non-empty admin-facing label alongside every classification', () => {
    for (const adapter of adapterKeys) {
      const support = reasoningSupportFor(adapter);
      expect(support?.providerLabel.length).toBeGreaterThan(0);
    }
  });
});
