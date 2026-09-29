/**
 * TASK-1021 (D-13) — `vllm` is on BOTH provider lists, and the class table must still say
 * `engine-served`.
 *
 * `PLATFORM_SELF_HOST_PROVIDERS.stt = ['vllm']` is what makes the SYSTEM `stt/vllm` connection
 * platform-only (a tenant row is a 403) and what opens the ASR resolver's credential gate. But the
 * ROW's usability must follow that connection (engine-served: ENABLED is the whole test), not the
 * bucket measurement a platform-self-host row is judged by — the readiness sweep already treats
 * every `ENGINE_SERVED_PROVIDERS` member that way. So the engine check wins the classifier.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_SERVED_PROVIDERS, PLATFORM_SELF_HOST_PROVIDERS, isPlatformSelfHostProvider, providerClassOf } from '../constants';

const SYSTEM = { tenantId: '00000000-0000-0000-0000-000000000000' };

describe('TASK-1021 providerClassOf — an engine that is also a platform self-host provider', () => {
  it('classifies (stt, vllm) as engine-served, though vllm is on the stt self-host list', () => {
    expect(isPlatformSelfHostProvider('stt', 'vllm')).toBe(true);
    expect(ENGINE_SERVED_PROVIDERS.has('vllm')).toBe(true);
    expect(providerClassOf('stt', 'vllm', SYSTEM)).toBe('engine-served');
  });

  it('keeps every other platform self-host provider platform-self-host (none of them is an engine)', () => {
    expect(providerClassOf('embeddings', 'tei-embed', SYSTEM)).toBe('platform-self-host');
    for (const engine of PLATFORM_SELF_HOST_PROVIDERS.tts ?? []) {
      expect(providerClassOf('tts', engine, SYSTEM), engine).toBe('platform-self-host');
    }
    expect(providerClassOf('stt', 'built-in', SYSTEM)).toBe('platform-self-host');
  });

  it('a TENANT row naming vllm is still the tenant`s own BYO declaration', () => {
    expect(providerClassOf('stt', 'vllm', { tenantId: 'tenant-a' })).toBe('cloud-byo');
  });
});
