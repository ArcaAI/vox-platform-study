/**
 * The ONE mapping from a resolved model row to the egress locality stamped on every `apps/text`
 * `/generate` body (`provider_locality`, keyed by provider name).
 *
 *   `AiModel.deploymentKind`: SELF_HOSTED ⇒ local; CLOUD / BYOK ⇒ cloud.
 *   No row known: an engine-served provider (or the platform's `built-in` sentinel) ⇒ local.
 *   Otherwise: OMITTED, so `apps/text` fails closed to cloud.
 *
 * A known cloud provider name is ALWAYS cloud — a row that claims otherwise is a data defect, and
 * the gateway never helps it downgrade a vendor call to "no redaction".
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CLOUD_PROVIDERS, providerLocality, stampProviderLocality } from '../provider-locality';

describe('providerLocality', () => {
  it('reads the model row first: SELF_HOSTED is local, CLOUD and BYOK are cloud', () => {
    expect(providerLocality('openai-compat', 'SELF_HOSTED')).toBe('local');
    expect(providerLocality('lm-studio', 'CLOUD')).toBe('cloud');
    expect(providerLocality('some-engine', 'BYOK')).toBe('cloud');
  });

  it('falls back to the engine-served providers when no row is known', () => {
    for (const provider of ['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp', 'built-in']) {
      expect(providerLocality(provider), provider).toBe('local');
    }
  });

  it('omits the stamp for an unknown provider with no row, so text fails closed to cloud', () => {
    expect(providerLocality('openai-compat')).toBeUndefined();
    expect(providerLocality('openai-compat', null)).toBeUndefined();
    expect(providerLocality('openai-compat', 'SOMETHING_NEW')).toBeUndefined();
  });

  it('never stamps a known cloud provider local, whatever the row says', () => {
    for (const provider of KNOWN_CLOUD_PROVIDERS) {
      expect(providerLocality(provider, 'SELF_HOSTED'), provider).toBe('cloud');
      expect(providerLocality(provider), provider).toBe('cloud');
    }
    expect(KNOWN_CLOUD_PROVIDERS).toEqual(
      expect.arrayContaining(['azure', 'azure-openai', 'bedrock', 'openai', 'anthropic', 'vertex', 'google', 'gemini', 'mistral', 'cohere', 'groq', 'together', 'openrouter']),
    );
  });

  it('is case-insensitive on the provider name', () => {
    expect(providerLocality('LM-Studio')).toBe('local');
    expect(providerLocality('Azure-OpenAI', 'SELF_HOSTED')).toBe('cloud');
  });
});

describe('stampProviderLocality', () => {
  it('stamps `provider` and `fallback_provider`, each from its own row', () => {
    const body: Record<string, unknown> = { provider: 'lm-studio', fallback_provider: 'azure-openai' };
    stampProviderLocality(body, { deploymentKind: 'SELF_HOSTED' });
    expect(body.provider_locality).toEqual({ 'lm-studio': 'local', 'azure-openai': 'cloud' });
  });

  it('REPLACES a caller-supplied map — locality is never accepted from a client', () => {
    const body: Record<string, unknown> = { provider: 'openai-compat', provider_locality: { 'openai-compat': 'local' } };
    stampProviderLocality(body, {});
    expect(body).not.toHaveProperty('provider_locality');
  });

  it('writes nothing when no provider can be stamped', () => {
    const body: Record<string, unknown> = { provider: 'openai-compat' };
    stampProviderLocality(body);
    expect(body).not.toHaveProperty('provider_locality');
  });
});
