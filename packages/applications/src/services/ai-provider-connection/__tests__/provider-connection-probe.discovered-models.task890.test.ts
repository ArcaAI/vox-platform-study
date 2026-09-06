/**
 * TASK-890 §3.7 — `discoveredModels` on the test-connection response.
 *
 * The probe ALREADY fetches the vendor's model list on three providers and
 * throws it away (§2.7 #7): Azure lists deployments to validate
 * `deploymentName`, OpenAI and Anthropic list models to prove the key. Keeping
 * that list is what lets the console offer "derive models from provider"
 * instead of asking a tenant admin to retype deployment names they can't see.
 *
 * Two properties are pinned here:
 *  - the list is only present when the vendor actually returned one, so the
 *    frozen four-field response shape is unchanged for every other provider and
 *    for a failed probe;
 *  - it carries ids, never anything else from the vendor payload.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionProbe } from '../provider-connection-probe';

const TENANT = 'tenant-abc';
const secrets = { decrypt: vi.fn(), supportsTransit: vi.fn(() => true) };

function connections() {
  return { assertResolvable: vi.fn(), findRow: vi.fn(async () => null) };
}

describe('discoveredModels', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('Azure OpenAI: the deployment listing becomes the discovered set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o-mini', model: 'gpt-4o-mini' }, { id: 'embed-3' }] }) })),
    );
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('llm', 'azure', TENANT, { apiKey: 'k', baseUrl: 'https://acme.openai.azure.com' });

    expect(res.ok).toBe(true);
    expect(res.discoveredModels).toEqual(['gpt-4o-mini', 'embed-3']);
  });

  it('OpenAI: /models ids become the discovered set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4.1' }, { id: 'o4-mini' }] }) })),
    );
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('llm', 'openai', TENANT, { apiKey: 'sk', baseUrl: 'https://api.openai.com/v1' });

    expect(res.discoveredModels).toEqual(['gpt-4.1', 'o4-mini']);
  });

  it('Anthropic: /v1/models ids become the discovered set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-4-sonnet' }] }) })),
    );
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('llm', 'anthropic', TENANT, { apiKey: 'sk', baseUrl: 'https://api.anthropic.com' });

    expect(res.discoveredModels).toEqual(['claude-4-sonnet']);
  });

  it('is ABSENT when the vendor returned no parsable list — never an empty promise of a list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: 'yes' }) })),
    );
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('llm', 'openai', TENANT, { apiKey: 'sk', baseUrl: 'https://api.openai.com/v1' });

    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('discoveredModels');
  });

  it('is ABSENT on a rejected key — a failed probe discovered nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 })),
    );
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('llm', 'anthropic', TENANT, { apiKey: 'bad', baseUrl: 'https://api.anthropic.com' });

    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty('discoveredModels');
  });
});
