/**
 * Unit tests for the shared `nlp.ner` model-injection resolver.
 *
 * Covers the contract: fail-CLOSED on any resolution hiccup (throws
 * `ServiceUnavailableException` naming the key, rather than posting without
 * `model_name` and taking the same 503 back from NLP one hop later), and the
 * SYSTEM-pin CLS discipline (the SYSTEM-only read must not depend on — or leak
 * into — the caller's ambient CLS tenant).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { resolveNerModelInjection, NLP_NER_TASK_KEY } from '../resolveNerModelSelection';

// Mirrors the mock ClsService double used across the processor test suites
// (see ner.processor.test.ts) — a bare passthrough `run()`, with `set`/`get`
// backed by a shared Map so call ORDER can be asserted.
function createMockClsService(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const setOrder: Array<[string, unknown]> = [];
  return {
    run: vi.fn((callback: () => unknown) => callback()),
    set: vi.fn((key: string, value: unknown) => {
      setOrder.push([key, value]);
      store.set(key, value);
    }),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    setOrder,
  };
}

describe('resolveNerModelInjection', () => {
  let logger: Logger;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new Logger('test');
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('throws naming the key when the AiTaskDefault service is not wired — fail-closed', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });

    await expect(resolveNerModelInjection(undefined, cls as any, logger)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(resolveNerModelInjection(undefined, cls as any, logger)).rejects.toThrow(NLP_NER_TASK_KEY);
    expect(cls.run).not.toHaveBeenCalled();
  });

  it('throws naming the key when there is no CLS scope to pin the SYSTEM-only read to — fail-closed', async () => {
    const aiTaskDefaultService = {
      getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'some/model' } }),
    };

    await expect(resolveNerModelInjection(aiTaskDefaultService as any, undefined, logger)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(resolveNerModelInjection(aiTaskDefaultService as any, undefined, logger)).rejects.toThrow(NLP_NER_TASK_KEY);
    // The SYSTEM row is never read under whatever ambient tenant happens to apply.
    expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalled();
  });

  it('resolves model_name from the effective nlp.ner AiTaskDefault row', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });
    const aiTaskDefaultService = {
      getEffective: vi.fn().mockResolvedValue({
        tenantId: SYSTEM_TENANT_ID,
        taskKey: NLP_NER_TASK_KEY,
        modelSlug: 'blaze-medical-ner',
        source: 'system',
        model: { sourceUri: 'blaze999/Medical-NER', slug: 'blaze-medical-ner', provider: 'built-in' },
      }),
    };

    const result = await resolveNerModelInjection(aiTaskDefaultService as any, cls as any, logger);

    expect(result).toEqual({ model_name: 'blaze999/Medical-NER' });
    expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith(NLP_NER_TASK_KEY, SYSTEM_TENANT_ID);
  });

  it('pins the read to a nested CLS scope with tenantId=SYSTEM_TENANT_ID rather than the ambient caller tenant', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });
    const aiTaskDefaultService = {
      getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'some/model' } }),
    };

    await resolveNerModelInjection(aiTaskDefaultService as any, cls as any, logger);

    // A NESTED cls.run() scope was opened for the read (not a bare ambient call).
    expect(cls.run).toHaveBeenCalledTimes(1);
    // Inside it, tenantId was explicitly pinned to SYSTEM — never left to whatever
    // the ambient (real, non-SYSTEM) tenant happened to be.
    expect(cls.setOrder).toContainEqual(['tenantId', SYSTEM_TENANT_ID]);
  });

  it('throws naming the key when the resolved AiTaskDefault has no ENABLED model — fail-closed', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });
    const aiTaskDefaultService = {
      getEffective: vi.fn().mockResolvedValue({ model: null }),
    };

    await expect(resolveNerModelInjection(aiTaskDefaultService as any, cls as any, logger)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(resolveNerModelInjection(aiTaskDefaultService as any, cls as any, logger)).rejects.toThrow(NLP_NER_TASK_KEY);
  });

  it('throws naming the key, and logs, when resolution fails — fail-closed', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });
    const aiTaskDefaultService = {
      getEffective: vi.fn().mockRejectedValue(new Error('registry read failed')),
    };

    await expect(resolveNerModelInjection(aiTaskDefaultService as any, cls as any, logger)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(resolveNerModelInjection(aiTaskDefaultService as any, cls as any, logger)).rejects.toThrow(NLP_NER_TASK_KEY);
    expect(warnSpy).toHaveBeenCalled();
  });
});
