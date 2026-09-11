import { describe, expect, it } from 'vitest';
import { AiProviderConnectionFactory } from '@arcaai/domains';
import { AiProviderConnectionDtoMapper } from '../ai-provider-connection.dto.mapper';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * TASK-952 — the READ projection sanitises `extraJson`.
 *
 * `provider-extras.ts` splits the two paths deliberately: the write validator
 * REJECTS an inadmissible extras object, and `sanitizeProviderExtras` DROPS
 * inadmissible keys on read so "a row stored before this validator existed must
 * degrade to 'that key is missing', never to a failed request". The wire fold
 * (`toOverrideEntry`) already honoured that; this projection returned the column
 * verbatim, so the console saw keys no adapter would ever be given.
 *
 * That became load-bearing when the console stopped rebuilding `extraJson` from
 * its own field list (D-6, so a save no longer wipes a stored key the card has
 * no field for): it now echoes the stored envelope back, and an inadmissible
 * legacy value would return as a 400 on the next save — the same failure class
 * the sanitiser exists to prevent, reached from the other direction.
 */
function row(overrides: Partial<Parameters<typeof AiProviderConnectionFactory.CreateAiProviderConnection>[0]> = {}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: SYSTEM_TENANT_ID,
    service: 'model-registry',
    provider: 's3',
    baseUrl: null,
    enabled: true,
    ...overrides,
  } as never);
}

describe('AiProviderConnectionDtoMapper.toResponse — extraJson', () => {
  it('drops a key the wire fold would never forward (a nested object)', () => {
    const res = AiProviderConnectionDtoMapper.toResponse(row({ extraJson: { model: { name: 'nested' }, region_hint: 'apac' } } as never));

    expect(res.extraJson).toEqual({ region_hint: 'apac' });
  });

  it('drops a RESERVED key rather than handing the console a value it may not send back', () => {
    const res = AiProviderConnectionDtoMapper.toResponse(row({ extraJson: { api_key: 'leaked', funding: 'platform', collection: 'hope' } } as never));

    expect(res.extraJson).toEqual({ collection: 'hope' });
  });

  it('keeps an admissible envelope verbatim — the platform-storage marker still round-trips', () => {
    const res = AiProviderConnectionDtoMapper.toResponse(row({ extraJson: { inheritsPlatformStorage: true } } as never));

    expect(res.extraJson).toEqual({ inheritsPlatformStorage: true });
  });

  it('preserves null — "no extras" and "an empty extras object" are different stored states', () => {
    expect(AiProviderConnectionDtoMapper.toResponse(row({ extraJson: null } as never)).extraJson).toBeNull();
    expect(AiProviderConnectionDtoMapper.toResponse(row({ extraJson: {} } as never)).extraJson).toEqual({});
  });
});
