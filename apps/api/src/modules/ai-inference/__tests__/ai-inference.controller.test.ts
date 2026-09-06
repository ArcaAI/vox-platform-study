/**
 * AiInferenceController unit tests. The
 * controller maps the validated camelCase DTOs to the upstream snake_case body
 * (with defaults), resolves the SYSTEM `nlp.*` routing election via
 * `IAiRoutingPolicyService.resolveDefault` (fail-closed), and proxies the client response verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiInferenceController } from '../ai-inference.controller';
import { SafetyCheckController } from '../safety-check.controller';

function makeController(
  routingPolicies?: { resolveDefault: ReturnType<typeof vi.fn> },
  aiModels?: { getByTaskTypeSharedRead: ReturnType<typeof vi.fn> },
  cls?: { get: ReturnType<typeof vi.fn> },
  usageLedgerService?: { recordUsage: ReturnType<typeof vi.fn> },
  tenantNlpTaskInstructionsService?: { getRow: ReturnType<typeof vi.fn> },
) {
  const client = { analyzeGuardrail: vi.fn(), classifyTokens: vi.fn(), suggestDiagnosis: vi.fn(), classifyTopic: vi.fn(), classifyIntent: vi.fn() };
  const controller = new AiInferenceController(
    client as never,
    routingPolicies as never,
    aiModels as never,
    cls as never,
    usageLedgerService as never,
    tenantNlpTaskInstructionsService as never,
  );
  return { controller, client };
}

/** TASK-890 §3.11 — a row carries a bucket IDENTITY; the weight path is derived from it. */
const derived = (bucketPrefix: string) => `/mnt/models-bucket/${bucketPrefix}/`;

const effectiveWithModel = (taskKey: string, sourceUri: string, bucketPrefix: string | null = null) => ({
  tenantId: 't1',
  taskKey,
  modelSlug: 'some-slug',
  source: 'system' as const,
  configJson: null,
  model: {
    id: 'm1',
    slug: 'some-slug',
    name: 'Some Model',
    provider: 'built-in',
    architecture: null,
    taskType: 'X',
    format: 'SAFETENSOR',
    sourceUri,
    bucketPrefix,
    primaryObject: null,
    libraryName: 'transformers',
  },
});

/**
 * `/text-analyses/diagnosis` resolves TWO task keys, so its fixtures cannot use
 * a single blanket `mockResolvedValue`. Dispatches on the requested taskKey and
 * throws for an unexpected one, so a test that forgets a key fails loudly
 * instead of silently receiving the wrong model.
 */
const effectiveByKey = (byKey: Record<string, unknown>) =>
  vi.fn(async (_tenantId: string, taskKey: string) => {
    if (!(taskKey in byKey)) throw new Error(`unexpected taskKey '${taskKey}'`);
    return byKey[taskKey];
  });

// the guardrail route moved off `AiInferenceController` (prefix
// `ai`) onto its own `SafetyCheckController` (prefix `safety-checks`). The
// mapping under test is unchanged; only which class owns it moved.
function makeSafetyController() {
  const client = { analyzeGuardrail: vi.fn() };
  return { controller: new SafetyCheckController(client as never), client };
}

describe('SafetyCheckController — guardrail', () => {
  it('maps guardrailType → guardrail_type and returns the verdict verbatim', async () => {
    const { controller, client } = makeSafetyController();
    const verdict = { safe: true, issues: [], confidence: 0.1 };
    client.analyzeGuardrail.mockResolvedValue(verdict);

    const result = await controller.analyzeGuardrail({ text: 'hello', guardrailType: 'pii_detection' });

    expect(client.analyzeGuardrail).toHaveBeenCalledWith({ text: 'hello', guardrail_type: 'pii_detection' });
    expect(result).toBe(verdict);
  });

  it('defaults guardrail_type to comprehensive when omitted', async () => {
    const { controller, client } = makeSafetyController();
    client.analyzeGuardrail.mockResolvedValue({});
    await controller.analyzeGuardrail({ text: 'hello' });
    expect(client.analyzeGuardrail).toHaveBeenCalledWith({ text: 'hello', guardrail_type: 'comprehensive' });
  });
});

describe('AiInferenceController — NER entities', () => {
  // the controller no longer substitutes `aggregation_strategy: 'simple'`
  // when the caller omits one. That default silently outranked the model row's own
  // `clinicalTaxonomy.aggregationStrategy` on EVERY request, so re-pointing
  // `nlp.ner` at a checkpoint with different conventions had no effect. Absent a
  // caller value the field is omitted and the row's declaration governs.
  it('forwards aggregationStrategy when given, and omits it entirely when not', async () => {
    const routingPolicies = { resolveDefault: vi.fn().mockResolvedValue(effectiveWithModel('nlp.ner', 'blaze999/Medical-NER')) };
    const { controller, client } = makeController(routingPolicies);
    const entities = { entities: [], model_version: 'v1' };
    client.classifyTokens.mockResolvedValue(entities);

    const result = await controller.extractEntities({ text: 'aspirin 100mg' });

    expect(client.classifyTokens).toHaveBeenCalledWith({
      text: 'aspirin 100mg',
      model_name: 'blaze999/Medical-NER',
    });
    expect(result).toBe(entities);
  });

  it('forwards language and a custom aggregation strategy when supplied', async () => {
    const routingPolicies = { resolveDefault: vi.fn().mockResolvedValue(effectiveWithModel('nlp.ner', 'blaze999/Medical-NER')) };
    const { controller, client } = makeController(routingPolicies);
    client.classifyTokens.mockResolvedValue({});
    await controller.extractEntities({ text: 'x', aggregationStrategy: 'max', language: 'vi' });
    expect(client.classifyTokens).toHaveBeenCalledWith({
      text: 'x',
      aggregation_strategy: 'max',
      language: 'vi',
      model_name: 'blaze999/Medical-NER',
    });
  });

  it('injects model_name from the effective nlp.ner default when the caller supplies no model', async () => {
    const routingPolicies = { resolveDefault: vi.fn().mockResolvedValue(effectiveWithModel('nlp.ner', 'blaze999/Medical-NER')) };
    const { controller, client } = makeController(routingPolicies);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x' });

    expect(routingPolicies.resolveDefault).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'nlp.ner', { systemOnly: true });
    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', model_name: 'blaze999/Medical-NER' });
  });

  // r2605 Finding B (security) — a caller-supplied modelName was previously
  // forwarded UNVALIDATED, letting any authenticated user make the clinical
  // NLP service download/load an arbitrary HuggingFace model. The override
  // must now resolve against ENABLED TOKEN_CLASSIFICATION registry rows
  // (shared-read: [tenant, SYSTEM]) by slug OR sourceUri; the row's sourceUri
  // is what gets forwarded. Anything else → 400.
  describe('modelName override validation (r2605 Finding B)', () => {
    const registryRows = [
      { id: 'm1', slug: 'medical-ner', sourceUri: 'blaze999/Medical-NER', taskType: 'TOKEN_CLASSIFICATION' },
      { id: 'm2', slug: 'clinical-ner-v2', sourceUri: 'org/clinical-ner-v2', taskType: 'TOKEN_CLASSIFICATION' },
    ];

    it('a registry SLUG override is forwarded as that row sourceUri', async () => {
      const routingPolicies = { resolveDefault: vi.fn() };
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockResolvedValue(registryRows) };
      const { controller, client } = makeController(routingPolicies, aiModels);
      client.classifyTokens.mockResolvedValue({});

      await controller.extractEntities({ text: 'x', modelName: 'medical-ner' });

      expect(aiModels.getByTaskTypeSharedRead).toHaveBeenCalledWith('TOKEN_CLASSIFICATION');
      expect(routingPolicies.resolveDefault).not.toHaveBeenCalled();
      expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', model_name: 'blaze999/Medical-NER' });
    });

    it('a registry SOURCE URI override passes and forwards that sourceUri', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockResolvedValue(registryRows) };
      const { controller, client } = makeController(undefined, aiModels);
      client.classifyTokens.mockResolvedValue({});

      await controller.extractEntities({ text: 'x', modelName: 'org/clinical-ner-v2' });

      expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', model_name: 'org/clinical-ner-v2' });
    });

    it('an UNKNOWN override → 400 and nothing is forwarded upstream', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockResolvedValue(registryRows) };
      const { controller, client } = makeController(undefined, aiModels);

      await expect(controller.extractEntities({ text: 'x', modelName: 'evil/arbitrary-model' })).rejects.toBeInstanceOf(BadRequestException);
      expect(client.classifyTokens).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: an override with no registry service wired → 400 (unlike the fail-open default injection)', async () => {
      const { controller, client } = makeController(undefined, undefined);

      await expect(controller.extractEntities({ text: 'x', modelName: 'medical-ner' })).rejects.toBeInstanceOf(BadRequestException);
      expect(client.classifyTokens).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: a registry read error under an override → 400, never an unvalidated forward', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockRejectedValue(new Error('db down')) };
      const { controller, client } = makeController(undefined, aiModels);

      await expect(controller.extractEntities({ text: 'x', modelName: 'medical-ner' })).rejects.toBeInstanceOf(BadRequestException);
      expect(client.classifyTokens).not.toHaveBeenCalled();
    });
  });

  it('FAILS CLOSED: null SYSTEM default → 503, never forwards without model_name', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const routingPolicies = {
      resolveDefault: vi.fn().mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.ner', modelSlug: null, source: null, configJson: null, model: null }),
    };
    const { controller, client } = makeController(routingPolicies);

    await expect(controller.extractEntities({ text: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.classifyTokens).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when default resolution throws → 503', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const routingPolicies = { resolveDefault: vi.fn().mockRejectedValue(new Error('db down')) };
    const { controller, client } = makeController(routingPolicies);

    await expect(controller.extractEntities({ text: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.classifyTokens).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED without the routing-policy service wired → 503', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const { controller, client } = makeController(undefined);

    await expect(controller.extractEntities({ text: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.classifyTokens).not.toHaveBeenCalled();
  });
});

//  — playground NER usage-ledger emission.
describe('AiInferenceController — NER usage-ledger emission', () => {
  const routingPolicies = () => ({ resolveDefault: vi.fn().mockResolvedValue(effectiveWithModel('nlp.ner', 'blaze999/Medical-NER')) });
  const clsFor = (user: { id: string; roles?: string[] } | undefined, tenantId = 't1') => ({
    get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : key === 'user' ? user : undefined)),
  });

  it('emits a TEXT_UNIT + REQUEST row with an nlp:<generated requestId> key and NO consultation attribution', async () => {
    const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const cls = clsFor({ id: 'user-1', roles: [] });
    const { controller, client } = makeController(routingPolicies(), undefined, cls, usageLedgerService);
    client.classifyTokens.mockResolvedValue({ entities: [] });

    await controller.extractEntities({ text: 'aspirin 100mg' });

    expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
    const [input] = usageLedgerService.recordUsage.mock.calls[0];
    expect(input.common.consultationId).toBeNull();
    expect(input.common.idempotencyKey).toMatch(/^nlp:.+/);
    expect(input.common.idempotencyKey).not.toBe('nlp:'); // a real id was generated, not blank
    expect(input.common.tenantId).toBe('t1');
    expect(input.common.model).toBe('blaze999/Medical-NER');
    expect(input.units).toEqual([
      { unit: 'TEXT_UNIT', quantity: 0.13 },
      { unit: 'REQUEST', quantity: 1 },
    ]);
  });

  it('attributes doctorId when the CLS user is a clinician (DOCTOR/SPECIALIST/CONSULTANT)', async () => {
    const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const cls = clsFor({ id: 'doctor-9', roles: ['DOCTOR'] });
    const { controller, client } = makeController(routingPolicies(), undefined, cls, usageLedgerService);
    client.classifyTokens.mockResolvedValue({ entities: [] });

    await controller.extractEntities({ text: 'x' });

    const [input] = usageLedgerService.recordUsage.mock.calls[0];
    expect(input.common.doctorId).toBe('doctor-9');
  });

  it('omits doctorId when the CLS user has no clinician role (e.g. a SUPER_ADMIN using the playground)', async () => {
    const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    const cls = clsFor({ id: 'admin-1', roles: ['SUPER_ADMIN'] });
    const { controller, client } = makeController(routingPolicies(), undefined, cls, usageLedgerService);
    client.classifyTokens.mockResolvedValue({ entities: [] });

    await controller.extractEntities({ text: 'x' });

    const [input] = usageLedgerService.recordUsage.mock.calls[0];
    expect(input.common.doctorId).toBeNull();
  });

  it('does not emit when no tenantId is available in CLS', async () => {
    const usageLedgerService = { recordUsage: vi.fn() };
    const cls = clsFor({ id: 'user-1' }, null as never);
    const { controller, client } = makeController(routingPolicies(), undefined, cls, usageLedgerService);
    client.classifyTokens.mockResolvedValue({ entities: [] });

    await controller.extractEntities({ text: 'x' });

    expect(usageLedgerService.recordUsage).not.toHaveBeenCalled();
  });

  it('does not emit when no usage-ledger service is wired (test-fixture ergonomics, unaffected proxying)', async () => {
    const cls = clsFor({ id: 'user-1' });
    const { controller, client } = makeController(routingPolicies(), undefined, cls, undefined);
    const entities = { entities: [], model_version: 'v1' };
    client.classifyTokens.mockResolvedValue(entities);

    const result = await controller.extractEntities({ text: 'x' });
    expect(result).toBe(entities);
  });

  it('never fails extractEntities when the ledger rejects (best-effort, like every other emitter in this codebase)', async () => {
    const usageLedgerService = { recordUsage: vi.fn().mockRejectedValue(new Error('outbox unavailable')) };
    const cls = clsFor({ id: 'user-1' });
    const { controller, client } = makeController(routingPolicies(), undefined, cls, usageLedgerService);
    const entities = { entities: [], model_version: 'v1' };
    client.classifyTokens.mockResolvedValue(entities);

    await expect(controller.extractEntities({ text: 'x' })).resolves.toBe(entities);
  });
});

// The route runs TWO models — a symptom-extraction NER feeding a
// disease classifier — so it resolves TWO AiTaskDefault keys and injects both.
// Before this, only `nlp.diagnosis` was injected and the NER half ran a
// hardcoded `blaze999/Medical-NER` literal inside apps/nlp, which made half of
// a clinical route un-configurable. `nlp.ner` is the SAME key the playground
// NER tab and the three clinical NER callers already resolve, and it resolves
// to that very checkpoint — so this is behaviour-preserving AND governed.
const DIAGNOSIS_KEYS = {
  'nlp.diagnosis': effectiveWithModel('nlp.diagnosis', 'shanover/symps_disease_bert_v3_c41'),
  'nlp.ner': effectiveWithModel('nlp.ner', 'blaze999/Medical-NER'),
};

describe('AiInferenceController — diagnosis suggestions', () => {
  it('maps minConfidence → min_confidence, forwards language, injects BOTH model selections', async () => {
    const routingPolicies = { resolveDefault: effectiveByKey(DIAGNOSIS_KEYS) };
    const { controller, client } = makeController(routingPolicies);
    const suggestions = { suggestions: [{ diagnosis: 'flu', confidence: 0.8 }] };
    client.suggestDiagnosis.mockResolvedValue(suggestions);

    const result = await controller.suggestDiagnosis({ text: 'fever and cough', minConfidence: 0.3, language: 'en' });

    expect(routingPolicies.resolveDefault).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'nlp.diagnosis', { systemOnly: true });
    expect(routingPolicies.resolveDefault).toHaveBeenCalledWith(SYSTEM_TENANT_ID, 'nlp.ner', { systemOnly: true });
    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'fever and cough',
      min_confidence: 0.3,
      language: 'en',
      model_name: 'shanover/symps_disease_bert_v3_c41',
      ner_model_name: 'blaze999/Medical-NER',
    });
    expect(result).toBe(suggestions);
  });

  it('forwards ner_model_path derived from the NER registry row own bucket identity', async () => {
    const routingPolicies = {
      resolveDefault: effectiveByKey({
        'nlp.diagnosis': effectiveWithModel('nlp.diagnosis', 'shanover/symps_disease_bert_v3_c41', 'symps/1'),
        'nlp.ner': effectiveWithModel('nlp.ner', 'blaze999/Medical-NER', 'medical-ner/1'),
      }),
    };
    const { controller, client } = makeController(routingPolicies);
    client.suggestDiagnosis.mockResolvedValue({});

    await controller.suggestDiagnosis({ text: 'fever' });

    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'fever',
      model_name: 'shanover/symps_disease_bert_v3_c41',
      model_path: derived('symps/1'),
      ner_model_name: 'blaze999/Medical-NER',
      ner_model_path: derived('medical-ner/1'),
    });
  });

  it('FAILS CLOSED when the NER half is unresolved → 503, never a partial call', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const routingPolicies = {
      resolveDefault: effectiveByKey({
        'nlp.diagnosis': effectiveWithModel('nlp.diagnosis', 'shanover/symps_disease_bert_v3_c41'),
        // Row exists but has no ENABLED model — the fail-closed case.
        'nlp.ner': { ...effectiveWithModel('nlp.ner', 'x'), model: null },
      }),
    };
    const { controller, client } = makeController(routingPolicies);

    await expect(controller.suggestDiagnosis({ text: 'headache' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.suggestDiagnosis).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when NER resolution throws → 503', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const routingPolicies = {
      resolveDefault: vi.fn(async (_tenantId: string, taskKey: string) => {
        if (taskKey === 'nlp.ner') throw new Error('resolver down');
        return effectiveWithModel('nlp.diagnosis', 'shanover/symps_disease_bert_v3_c41');
      }),
    };
    const { controller, client } = makeController(routingPolicies);

    await expect(controller.suggestDiagnosis({ text: 'headache' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.suggestDiagnosis).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED on resolution error for diagnosis → 503', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const routingPolicies = { resolveDefault: vi.fn().mockRejectedValue(new Error('resolver down')) };
    const { controller, client } = makeController(routingPolicies);

    await expect(controller.suggestDiagnosis({ text: 'headache' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.suggestDiagnosis).not.toHaveBeenCalled();
  });

  it('forwards minConfidence: 0 (falsy but valid) when SYSTEM default resolves', async () => {
    const routingPolicies = { resolveDefault: effectiveByKey(DIAGNOSIS_KEYS) };
    const { controller, client } = makeController(routingPolicies);
    client.suggestDiagnosis.mockResolvedValue({});
    await controller.suggestDiagnosis({ text: 'x', minConfidence: 0 });
    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'x',
      min_confidence: 0,
      model_name: 'shanover/symps_disease_bert_v3_c41',
      ner_model_name: 'blaze999/Medical-NER',
    });
  });
});

// /ai/nlp/topic + /ai/nlp/intent proxy routes.
describe('AiInferenceController — nlp/topic, nlp/intent ', () => {
  const clsFor = (tenantId?: string) => ({ get: vi.fn((k: string) => (k === 'tenantId' ? tenantId : undefined)) });

  it('classifyTopic FAILS CLOSED with 503 when there is no CLS tenant', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const { controller, client } = makeController(undefined, undefined, clsFor(undefined));

    await expect(controller.classifyTopic({ text: 'a billing question' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.classifyTopic).not.toHaveBeenCalled();
  });

  it('classifyTopic resolves TenantNlpTaskInstructions and injects instructions + tenant_id', async () => {
    const instructions = { getRow: vi.fn().mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.topic', instructionsJson: ['billing', 'appointments'], version: 1 }) };
    const { controller, client } = makeController(undefined, undefined, clsFor('t1'), undefined, instructions);
    client.classifyTopic.mockResolvedValue({ predicted_topic: 'billing', available_topics: ['billing', 'appointments'] });

    const result = await controller.classifyTopic({ text: 'a billing question', language: 'en' });

    expect(instructions.getRow).toHaveBeenCalledWith('nlp.topic', 't1');
    expect(client.classifyTopic).toHaveBeenCalledWith({
      text: 'a billing question',
      language: 'en',
      instructions: ['billing', 'appointments'],
      tenant_id: 't1',
    });
    expect(result).toEqual({ predicted_topic: 'billing', available_topics: ['billing', 'appointments'] });
  });

  it('classifyTopic proceeds without instructions when the service is unwired (NLP fails closed itself)', async () => {
    const { controller, client } = makeController(undefined, undefined, clsFor('t1'), undefined, undefined);
    client.classifyTopic.mockResolvedValue({});

    await controller.classifyTopic({ text: 'x' });

    expect(client.classifyTopic).toHaveBeenCalledWith({ text: 'x', tenant_id: 't1' });
  });

  it('classifyTopic degrades to no instructions on a resolution error (never blocks the proxy)', async () => {
    const instructions = { getRow: vi.fn().mockRejectedValue(new Error('db down')) };
    const { controller, client } = makeController(undefined, undefined, clsFor('t1'), undefined, instructions);
    client.classifyTopic.mockResolvedValue({});

    await controller.classifyTopic({ text: 'x' });

    expect(client.classifyTopic).toHaveBeenCalledWith({ text: 'x', tenant_id: 't1' });
  });

  it('classifyIntent resolves TenantNlpTaskInstructions (nlp.intent) and injects instructions + tenant_id', async () => {
    const instructions = { getRow: vi.fn().mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.intent', instructionsJson: ['schedule_appointment'], version: 1 }) };
    const { controller, client } = makeController(undefined, undefined, clsFor('t1'), undefined, instructions);
    client.classifyIntent.mockResolvedValue({ predicted_intent: 'schedule_appointment', available_intents: ['schedule_appointment'] });

    const result = await controller.classifyIntent({ text: 'book me an appointment' });

    expect(instructions.getRow).toHaveBeenCalledWith('nlp.intent', 't1');
    expect(client.classifyIntent).toHaveBeenCalledWith({
      text: 'book me an appointment',
      instructions: ['schedule_appointment'],
      tenant_id: 't1',
    });
    expect(result).toEqual({ predicted_intent: 'schedule_appointment', available_intents: ['schedule_appointment'] });
  });

  it('classifyIntent FAILS CLOSED with 503 when there is no CLS tenant', async () => {
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const { controller, client } = makeController(undefined, undefined, clsFor(undefined));

    await expect(controller.classifyIntent({ text: 'book me an appointment' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.classifyIntent).not.toHaveBeenCalled();
  });
});
