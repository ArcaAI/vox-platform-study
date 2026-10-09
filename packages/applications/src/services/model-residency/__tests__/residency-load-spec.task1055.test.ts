import { describe, expect, it } from 'vitest';
import { NLP_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/nlp';
import { SYSTEM_TASK_DEFAULT_ROUTING } from '../../../../../database/src/prisma/db_main/seed/16-ai-routing-policy';
import { derivedLocalPath } from '../../ai-model/constants';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError } from '../residency-load-spec.builder';

/**
 * TASK-1055 (cluster e2e 2026-10-09) — after an nlp restart the agent reports no "last seen" cache, so
 * the gateway DERIVES the slot from the catalogue row. It used to derive from `taskType` alone: GLiGuard
 * (a GLiNER2 model, TEXT_CLASSIFICATION) went to `nlp_text_classifier` and nlp failed to open it, and
 * MiniCheck / the symptom-disease suggester were refused outright. The rows below are the SEED rows.
 */

const SYSTEM = '00000000-0000-0000-0000-000000000000';
type Row = (typeof NLP_AI_MODELS)[number] & { resourceStatus?: string; bucketPrefix?: string; primaryObject?: string };

const bySlug = (slug: string): Row => {
  const row = NLP_AI_MODELS.find((m) => m.slug === slug);
  if (!row) throw new Error(`seed row ${slug} missing`);
  return { resourceStatus: 'ENABLED', ...row };
};

/** The SYSTEM elections, by model id — exactly what `seedAiRoutingPolicy` writes for the nlp-served keys. */
function seededPolicies(rows: Row[]) {
  return SYSTEM_TASK_DEFAULT_ROUTING.flatMap((p) => {
    const model = rows.find((m) => m.slug === p.modelSlug);
    return model ? [{ tenantId: SYSTEM, taskKey: p.taskKey, modelId: model.id, isDefault: true, enabled: true, resourceStatus: 'ENABLED' }] : [];
  });
}

function build(rows: Row[], policies = seededPolicies(rows)) {
  const aiModels = {
    findAll: async ({ filters }: { filters: Record<string, unknown> }) =>
      rows.filter(
        (m) =>
          (filters.sourceUri === undefined || m.sourceUri === filters.sourceUri) &&
          (filters.id === undefined || m.id === filters.id) &&
          (filters.resourceStatus === undefined || m.resourceStatus === filters.resourceStatus),
      ),
  };
  const routing = {
    findCandidates: async (tenantIds: string[], taskKey: string) => policies.filter((p) => tenantIds.includes(p.tenantId) && p.taskKey === taskKey),
  };
  return new ResidencyLoadSpecBuilder(aiModels as never, routing as never);
}

const ALL = (): Row[] => NLP_AI_MODELS.map((m) => ({ resourceStatus: 'ENABLED', ...m }));

describe('ResidencyLoadSpecBuilder.nlpSpec — derives the slot from the catalogue row (TASK-1055)', () => {
  it('GLiGuard (GLiNER2, TEXT_CLASSIFICATION) loads into nlp_gliner2_guard, not the transformers text classifier', async () => {
    const spec = await build(ALL()).build('nlp', 'fastino/gliguard-LLMGuardrails-300M');
    expect(spec).toEqual({ cache: 'nlp_gliner2_guard', model_path: null });
  });

  it('the GLiNER2 PII rows (TOKEN_CLASSIFICATION) load into nlp_gliner2_guard too', async () => {
    const builder = build(ALL());
    await expect(builder.build('nlp', 'fastino/gliner2-privacy-filter-PII-multi')).resolves.toEqual({ cache: 'nlp_gliner2_guard', model_path: null });
    await expect(builder.build('nlp', 'fastino/GLiNER2-Guardrails-PII-Multi')).resolves.toEqual({ cache: 'nlp_gliner2_guard', model_path: null });
  });

  it('MiniCheck loads into nlp_entailment_scorer with its derived path and the row calibration, camelCase, verbatim', async () => {
    const minicheck = { ...bySlug('minicheck-flan-t5-large'), bucketPrefix: 'nlp/minicheck-flan-t5-large', primaryObject: 'minicheck-flan-t5-large-q6_k.gguf' };
    const rows = [...ALL().filter((m) => m.slug !== 'minicheck-flan-t5-large'), minicheck];
    const spec = await build(rows).build('nlp', 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF');
    expect(spec).toEqual({
      cache: 'nlp_entailment_scorer',
      model_path: derivedLocalPath(minicheck as never),
      calibration: {
        adapter: 'minicheck-flan-t5',
        labelTokenNo: 3,
        labelTokenYes: 209,
        supportedMin: 0.6,
        unsupportedMax: 0.4,
        document: 'A group of students gather in the school library to study for their upcoming final exams.',
        supportedClaim: 'The students are preparing for an examination.',
        unsupportedClaim: 'The students are on vacation.',
      },
    });
    expect(spec.model_path).toMatch(/minicheck-flan-t5-large-q6_k\.gguf$/);
  });

  it('the entailment scorer fails closed, by name, when the row carries no calibration', async () => {
    const minicheck = { ...bySlug('minicheck-flan-t5-large'), bucketPrefix: 'nlp/minicheck', primaryObject: 'm.gguf', metaData: {} };
    const builder = build([minicheck]);
    // nlp reported the slot, but the row has no `_metadata.entailment` to send with it.
    const error = await builder.build('nlp', minicheck.sourceUri, 'nlp_entailment_scorer').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResidencyLoadSpecError);
    expect((error as ResidencyLoadSpecError).code).toBe('LOAD_FAILED');
    expect((error as Error).message).toMatch(/_metadata\.entailment/);
  });

  it('the entailment scorer refuses by name when the row has no published local path (it never auto-downloads)', async () => {
    const error = await build(ALL())
      .build('nlp', 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResidencyLoadSpecError);
    expect((error as Error).message).toMatch(/local path/);
  });

  it('the symptom-disease model elected for nlp.diagnosis loads as the suggester, paired with the nlp.ner election', async () => {
    const spec = await build(ALL()).build('nlp', 'shanover/symps_disease_bert_v3_c41');
    expect(spec).toEqual({
      cache: 'nlp_medical_suggester',
      model_path: null,
      ner_model_name: 'blaze999/Medical-NER',
      ner_model_path: null,
    });
  });

  it('the suggester carries the NER row’s derived path when it is published', async () => {
    const ner = { ...bySlug('medical-ner'), bucketPrefix: 'nlp/medical-ner' };
    const rows = [...ALL().filter((m) => m.slug !== 'medical-ner'), ner];
    const spec = await build(rows).build('nlp', 'shanover/symps_disease_bert_v3_c41');
    expect(spec).toMatchObject({ cache: 'nlp_medical_suggester', ner_model_name: 'blaze999/Medical-NER', ner_model_path: derivedLocalPath(ner as never) });
  });

  it('the suggester refuses by name when no nlp.ner model is elected', async () => {
    const rows = ALL();
    const policies = seededPolicies(rows).filter((p) => p.taskKey !== 'nlp.ner');
    const error = await build(rows, policies)
      .build('nlp', 'shanover/symps_disease_bert_v3_c41')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResidencyLoadSpecError);
    expect((error as Error).message).toMatch(/nlp\.ner/);
  });

  it('a report beats derivation: a reported simple cache is used as-is', async () => {
    const spec = await build(ALL()).build('nlp', 'shanover/symps_disease_bert_v3_c41', 'nlp_text_classifier');
    expect(spec).toEqual({ cache: 'nlp_text_classifier', model_path: null });
  });

  it('a reported suggester slot is built with its NER even though the row alone could not say so', async () => {
    const rows = ALL();
    const policies = seededPolicies(rows).filter((p) => p.taskKey !== 'nlp.diagnosis');
    const spec = await build(rows, policies).build('nlp', 'shanover/symps_disease_bert_v3_c41', 'nlp_medical_suggester');
    expect(spec).toMatchObject({ cache: 'nlp_medical_suggester', ner_model_name: 'blaze999/Medical-NER' });
  });

  it('regression: Medical NER (transformers token classifier) still maps to nlp_token_classifier', async () => {
    await expect(build(ALL()).build('nlp', 'blaze999/Medical-NER')).resolves.toEqual({ cache: 'nlp_token_classifier', model_path: null });
  });

  it('an unknown model is MODEL_UNKNOWN', async () => {
    const error = await build(ALL())
      .build('nlp', 'nobody/nothing')
      .catch((e: unknown) => e);
    expect((error as ResidencyLoadSpecError).code).toBe('MODEL_UNKNOWN');
  });
});
