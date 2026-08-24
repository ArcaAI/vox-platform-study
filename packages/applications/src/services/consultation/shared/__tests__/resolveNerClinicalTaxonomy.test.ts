/**
 * TASK-799 lane G — the gateway half of the nlp clinical-taxonomy move.
 *
 * `apps/nlp` no longer carries an ontology vocabulary, vitals plausibility
 * bands, a ConText/NegEx trigger lexicon or a NER contract of its own. They live
 * on `AiModel._metadata.clinicalTaxonomy` of the row `nlp.ner` selects, and this
 * resolver is what puts them on the wire — the same place, and the same
 * SYSTEM-pinned read, that already resolves `model_name` (decision D-4: nlp
 * models are PLATFORM-SHARED, so the taxonomy is platform scope too).
 *
 * These tests pin the half a schema field cannot: that the blob the DB holds is
 * what the executor receives, and that an absent one is an ABSENT field rather
 * than an invented default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { resolveNerModelInjection, NLP_NER_TASK_KEY } from '../resolveNerModelSelection';

function createMockClsService(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    run: vi.fn((callback: () => unknown) => callback()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
}

const CLINICAL_TAXONOMY = {
  tokenClassifier: { aggregationStrategy: 'simple', ignoreLabels: ['O'], assertionEnabled: true },
  linker: { enabled: true, confidenceFloor: 0.0, vocabulary: [{ aliases: ['metformin'], rxnorm_code: '6809' }] },
  vitals: { systolic: { min: 60, max: 260 }, diastolic: { min: 30, max: 160 } },
  assertion: { triggers: { ABSENT: ['denies', 'no'] } },
};

function serviceReturning(metadata: unknown) {
  return {
    getEffective: vi.fn().mockResolvedValue({
      tenantId: SYSTEM_TENANT_ID,
      taskKey: NLP_NER_TASK_KEY,
      modelSlug: 'medical-ner',
      source: 'system',
      model: { sourceUri: 'blaze999/Medical-NER', slug: 'medical-ner', provider: 'built-in', metadata },
    }),
  };
}

describe('resolveNerModelInjection — clinical taxonomy', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('test');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('injects the taxonomy stored on the selected model row', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });

    const result = await resolveNerModelInjection(serviceReturning({ clinicalTaxonomy: CLINICAL_TAXONOMY }) as never, cls as never, logger);

    expect(result.model_name).toBe('blaze999/Medical-NER');
    // The DB blob is what goes on the wire, byte-for-byte — the executor applies
    // exactly what a platform admin stored, with nothing added or normalised.
    expect(result.clinical_taxonomy).toEqual(CLINICAL_TAXONOMY);
  });

  it('carries a DIFFERENT stored taxonomy through unchanged', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });
    const retuned = { ...CLINICAL_TAXONOMY, vitals: { systolic: { min: 60, max: 120 } } };

    const result = await resolveNerModelInjection(serviceReturning({ clinicalTaxonomy: retuned }) as never, cls as never, logger);

    expect(result.clinical_taxonomy).toEqual(retuned);
  });

  it('OMITS the field when the model row declares no taxonomy — never a default', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });

    const noMeta = await resolveNerModelInjection(serviceReturning(undefined) as never, cls as never, logger);
    expect(noMeta).toEqual({ model_name: 'blaze999/Medical-NER' });
    expect('clinical_taxonomy' in noMeta).toBe(false);

    const otherMeta = await resolveNerModelInjection(serviceReturning({ languages: ['en'] }) as never, cls as never, logger);
    expect('clinical_taxonomy' in otherMeta).toBe(false);
  });

  it('ignores a non-object taxonomy rather than forwarding garbage', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });

    const result = await resolveNerModelInjection(serviceReturning({ clinicalTaxonomy: 'not-an-object' }) as never, cls as never, logger);

    expect('clinical_taxonomy' in result).toBe(false);
  });

  it('still reads the row under the SYSTEM pin, not the ambient caller tenant', async () => {
    const cls = createMockClsService({ tenantId: 'tenant-real' });
    const service = serviceReturning({ clinicalTaxonomy: CLINICAL_TAXONOMY });

    await resolveNerModelInjection(service as never, cls as never, logger);

    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', SYSTEM_TENANT_ID);
    expect(service.getEffective).toHaveBeenCalledWith(NLP_NER_TASK_KEY, SYSTEM_TENANT_ID);
  });
});
