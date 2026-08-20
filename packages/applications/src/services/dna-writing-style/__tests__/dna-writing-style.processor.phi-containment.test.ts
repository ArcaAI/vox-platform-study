/**
 * TASK-700 — DNA Writing-Style PHI Containment.
 *
 * Proves the closed loop end-to-end once a DNA_ANALYSIS template carries a
 * closed-vocabulary `metaData.promptConfig.outputSchema`:
 *   1. The outgoing TEXT call binds `response_format` from that schema.
 *   2. A response that is valid JSON but violates the schema (extra property,
 *      missing required key, out-of-enum value, or an over-length string
 *      field) hard-fails the job — nothing is ever persisted.
 *   3. The persisted `styleText` is rendered deterministically from the
 *      validated fields only, never the model's raw prose.
 *   4. A doctor who has opted out cannot have a profile generated via EITHER
 *      the automatic path or an explicit `textSamples` (admin/migration) call.
 *   5. The approved-only corpus filter is unaffected by the schema fix.
 *
 * Mocks at the same boundaries as `dna-writing-style.processor.test.ts`
 * (HTTP/TEXT, repositories, job service); see that file for the base-case
 * coverage this file does not repeat.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';

// ─── A representative closed-vocabulary DNA schema (test-local — mirrors the
// shape of `DNA_OUTPUT_SCHEMA` in packages/database/.../seed/07-prompt-template.ts
// without importing across the applications → database boundary, which is
// lint-banned per `04-application-services.md`). ─────────────────────────
const DNA_TEST_SCHEMA = {
  title: 'DnaStyleProfile',
  type: 'object',
  additionalProperties: false,
  properties: {
    sentenceStructure: { type: 'string', enum: ['active', 'passive', 'mixed'] },
    verbosity: { type: 'string', enum: ['terse', 'moderate', 'verbose'] },
    listVsNarrative: { type: 'string', enum: ['list', 'narrative', 'mixed'] },
    sectionOrderPreference: { type: 'string', maxLength: 60 },
    abbreviationFrequency: { type: 'string', enum: ['low', 'medium', 'high'] },
    toneFormality: { type: 'string', enum: ['casual', 'neutral', 'formal'] },
    confidenceScores: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
  },
  required: [
    'sentenceStructure',
    'verbosity',
    'listVsNarrative',
    'sectionOrderPreference',
    'abbreviationFrequency',
    'toneFormality',
    'confidenceScores',
  ],
};

const VALID_PROFILE = {
  sentenceStructure: 'active',
  verbosity: 'terse',
  listVsNarrative: 'narrative',
  sectionOrderPreference: 'Subjective, Objective, Assessment, Plan',
  abbreviationFrequency: 'high',
  toneFormality: 'formal',
  confidenceScores: { sentenceStructure: 0.9 },
};

// ─── Mock Factories (mirrors dna-writing-style.processor.test.ts) ─────────

const createMockJobService = () => ({
  notifyProgress: vi.fn(),
  notifyComplete: vi.fn(),
  notifyFailed: vi.fn(),
});

const createMockContextItemRepository = () => ({ findAll: vi.fn() });
const createMockContextItemVersionRepository = () => ({ getVersionsByChangeReason: vi.fn() });
const createMockDnaReportRepository = () => ({ findLatestForDoctor: vi.fn(), create: vi.fn(), update: vi.fn() });
const createMockDnaVersionRepository = () => ({ create: vi.fn() });
const createMockDnaUsageRecordRepository = () => ({ create: vi.fn() });
const createMockPromptUsageRecordRepository = () => ({ create: vi.fn() });
const createMockPromptManagementService = () => ({ listPromptTemplates: vi.fn() });
const createMockPromptTemplateRepository = () => ({ findById: vi.fn() });
const createMockHttpService = () => ({ axiosRef: { post: vi.fn() } });
const createMockConfigService = () => ({ get: vi.fn().mockReturnValue('http://localhost:8862') });
const createMockClsService = () => ({
  get: vi.fn(),
  set: vi.fn(),
  run: vi.fn(<T>(fn: () => T): T => fn()),
});
const createMockJobMetrics = () => ({
  recordJobStart: vi.fn().mockReturnValue(vi.fn().mockReturnValue(5.0)),
  recordJobComplete: vi.fn(),
  recordJobFailed: vi.fn(),
  recordWaitingDuration: vi.fn(),
  recordTextCallDuration: vi.fn(),
});
const createMockAppSettingsService = () => ({
  getValueWithDefault: vi.fn(<T>(_key: string, defaultValue: T): T => defaultValue),
});
const createMockConfigResolver = () => ({
  resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null }),
});

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DnaWritingStyleReportFactory: {
      CreateDnaWritingStyleReport: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-report-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
    DnaWritingStyleVersionFactory: {
      CreateDnaWritingStyleVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-version-id', createdAt: new Date() })),
    },
    DnaUsageRecordFactory: {
      CreateDnaUsageRecord: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-usage-id', createdAt: new Date() })),
    },
    PromptUsageRecordFactory: {
      CreatePromptUsageRecord: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-prompt-usage-id', createdAt: new Date() })),
    },
  };
});

const createMockJob = (overrides: Record<string, unknown> = {}) => ({
  data: {
    jobId: overrides.jobId ?? 'job-1',
    doctorId: overrides.doctorId ?? 'doctor-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    userId: overrides.userId ?? 'user-1',
    textSamples: overrides.textSamples ?? undefined,
  },
  id: overrides.jobId ?? 'job-1',
  progress: 0,
  timestamp: Date.now(),
  updateProgress: vi.fn().mockResolvedValue(undefined),
});

const createAxiosTextResponse = (content: string) => ({
  data: {
    task_id: 'task-text-1',
    status: 'completed' as const,
    content,
    provider: 'openai',
    model: 'gpt-4',
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 },
    latency_ms: 3200,
    finish_reason: 'stop' as const,
    created_at: '2026-02-18T10:00:00Z',
  },
});

describe('DnaWritingStyleProcessor — PHI containment (TASK-700)', () => {
  let mockJobService: ReturnType<typeof createMockJobService>;
  let mockAppSettings: ReturnType<typeof createMockAppSettingsService>;
  let mockContextItemRepo: ReturnType<typeof createMockContextItemRepository>;
  let mockDnaReportRepo: ReturnType<typeof createMockDnaReportRepository>;
  let mockDnaVersionRepo: ReturnType<typeof createMockDnaVersionRepository>;
  let mockDnaUsageRepo: ReturnType<typeof createMockDnaUsageRecordRepository>;
  let mockPromptUsageRepo: ReturnType<typeof createMockPromptUsageRecordRepository>;
  let mockPromptService: ReturnType<typeof createMockPromptManagementService>;
  let mockPromptTemplateRepo: ReturnType<typeof createMockPromptTemplateRepository>;
  let mockHttpService: ReturnType<typeof createMockHttpService>;
  let mockConfigService: ReturnType<typeof createMockConfigService>;
  let mockJobMetrics: ReturnType<typeof createMockJobMetrics>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockContextItemVersionRepo: ReturnType<typeof createMockContextItemVersionRepository>;
  let mockHarnessPolicyService: { resolveTextSelection: ReturnType<typeof vi.fn> };
  let mockConfigResolver: ReturnType<typeof createMockConfigResolver>;

  const buildProcessor = () =>
    new DnaWritingStyleProcessor(
      mockJobService as never,
      mockAppSettings as never,
      mockContextItemRepo as never,
      mockContextItemVersionRepo as never,
      mockDnaReportRepo as never,
      mockDnaVersionRepo as never,
      mockDnaUsageRepo as never,
      mockPromptUsageRepo as never,
      mockPromptService as never,
      mockHttpService as never,
      mockConfigService as never,
      mockJobMetrics as never,
      mockClsService as never,
      undefined, // secretsService
      mockHarnessPolicyService as never,
      mockConfigResolver as never,
      mockPromptTemplateRepo as never,
      // TASK-710 (re-opened): `IPhiRedactor` is a REQUIRED dependency now — an
      // absent redactor aborts the job rather than posting the raw
      // cross-patient corpus to TEXT. Pass-through double keeps this file's
      // TASK-700 assertions byte-identical.
      { redact: vi.fn(async (text: string) => text) } as never,
    );

  const primeTemplateWithSchema = () => {
    mockPromptService.listPromptTemplates.mockResolvedValue([
      { id: 'dna-tpl-schema', content: 'Analyze.', category: 'DNA_ANALYSIS', currentVersionNumber: 3 },
    ]);
    mockPromptTemplateRepo.findById.mockResolvedValue({
      id: 'dna-tpl-schema',
      metaData: { promptConfig: { outputSchema: DNA_TEST_SCHEMA } },
    });
  };

  const primeStorageMocks = () => {
    mockDnaReportRepo.findLatestForDoctor.mockResolvedValue(null);
    mockDnaReportRepo.create.mockResolvedValue({ id: 'new-report-id', createdAt: new Date(), updatedAt: new Date() });
    mockDnaVersionRepo.create.mockResolvedValue({});
    mockDnaUsageRepo.create.mockResolvedValue({});
    mockPromptUsageRepo.create.mockResolvedValue({});
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockJobService = createMockJobService();
    mockAppSettings = createMockAppSettingsService();
    mockContextItemRepo = createMockContextItemRepository();
    mockDnaReportRepo = createMockDnaReportRepository();
    mockDnaVersionRepo = createMockDnaVersionRepository();
    mockDnaUsageRepo = createMockDnaUsageRecordRepository();
    mockPromptUsageRepo = createMockPromptUsageRecordRepository();
    mockPromptService = createMockPromptManagementService();
    mockPromptTemplateRepo = createMockPromptTemplateRepository();
    mockHttpService = createMockHttpService();
    mockConfigService = createMockConfigService();
    mockJobMetrics = createMockJobMetrics();
    mockClsService = createMockClsService();
    mockContextItemVersionRepo = createMockContextItemVersionRepository();
    mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (contextItemId: string, changeReason: string) =>
      changeReason === 'approved' ? [{ id: 'v', contextItemId, changeReason: 'approved', versionNumber: 1 }] : [],
    );
    mockHarnessPolicyService = { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'resolved-medgemma' }) };
    mockConfigResolver = createMockConfigResolver();
    primeStorageMocks();
  });

  // ─── Task 1 RED test 3: response_format is sent when a schema is resolved ──

  it('binds response_format from the resolved template outputSchema on the outgoing TEXT call', async () => {
    primeTemplateWithSchema();
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(VALID_PROFILE)));

    await buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never);

    const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(requestBody.response_format).toEqual({
      type: 'json_schema',
      json_schema: DNA_TEST_SCHEMA,
      strict: true,
    });
  });

  // FLIPPED: this previously asserted that a schema-less template simply
  // omitted `response_format` and generated anyway. That WAS the fail-open
  // hole — an unconstrained generation whose raw prose became the persisted,
  // cross-patient-injected `styleText`. A schema-less template must now abort
  // before the model is ever called.
  it('never calls the model at all when the resolved template has no schema', async () => {
    mockPromptService.listPromptTemplates.mockResolvedValue([{ id: 'tpl-legacy', content: 'Analyze.', category: 'DNA_ANALYSIS' }]);
    mockPromptTemplateRepo.findById.mockResolvedValue({ id: 'tpl-legacy', metaData: null });

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/schema/i);
    expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
  });

  // ─── Task 5 test 1: PHI-shaped input cannot persist ────────────────────────

  it('hard-fails (never persists) when TEXT adds a free-text property outside the closed schema', async () => {
    primeTemplateWithSchema();
    const withExtraNarrative = { ...VALID_PROFILE, extraNarrative: 'Patient John Doe, MRN 12345, prescribed metformin 500mg.' };
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(withExtraNarrative)));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/unparseable or non-conforming/i);

    expect(mockJobService.notifyFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('unparseable or non-conforming'));
    expect(mockDnaReportRepo.create).not.toHaveBeenCalled();
    expect(mockDnaVersionRepo.create).not.toHaveBeenCalled();
  });

  it('hard-fails when a required schema key is missing from an otherwise-valid response', async () => {
    primeTemplateWithSchema();
    const { toneFormality: _drop, ...missingRequired } = VALID_PROFILE;
    void _drop;
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(missingRequired)));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/unparseable or non-conforming/i);
    expect(mockDnaReportRepo.create).not.toHaveBeenCalled();
  });

  it('hard-fails when an enum-constrained field carries a value outside its closed vocabulary', async () => {
    primeTemplateWithSchema();
    const outOfEnum = { ...VALID_PROFILE, toneFormality: 'Dr. Smith prefers a warm, empathetic tone with the patient.' };
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(outOfEnum)));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/unparseable or non-conforming/i);
    expect(mockDnaReportRepo.create).not.toHaveBeenCalled();
  });

  it('hard-fails when sectionOrderPreference exceeds its declared maxLength (a quoted-sentence proxy)', async () => {
    primeTemplateWithSchema();
    const overLong = {
      ...VALID_PROFILE,
      sectionOrderPreference: 'Patient reports worsening chest pain radiating to the left arm since yesterday evening, MRN 998877.',
    };
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(overLong)));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/unparseable or non-conforming/i);
    expect(mockDnaReportRepo.create).not.toHaveBeenCalled();
  });

  it('renders styleText deterministically from the validated fields — never the raw TEXT content', async () => {
    primeTemplateWithSchema();
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(VALID_PROFILE)));

    const result = await buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never);

    expect(result.styleText).toBe(
      'Sentence structure: active. Verbosity: terse. Lists vs narrative: narrative. Preferred section order: Subjective, Objective, Assessment, Plan. Abbreviation frequency: high. Tone: formal.',
    );
    expect(result.reportData).toMatchObject(VALID_PROFILE);
  });

  // ─── Task 5 test 2: opt-out blocks BOTH the automatic and textSamples paths ─

  it('blocks a doctor who opted out via BOTH the automatic path and an admin-supplied textSamples call', async () => {
    mockConfigResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false });
    primeTemplateWithSchema();

    // Automatic path (no textSamples).
    await expect(buildProcessor().process(createMockJob({}) as never)).rejects.toThrow(/disabled/i);
    expect(mockContextItemRepo.findAll).not.toHaveBeenCalled();

    // Explicit textSamples (admin/migration) path — must be gated identically.
    await expect(buildProcessor().process(createMockJob({ textSamples: ['Explicit sample'] }) as never)).rejects.toThrow(/disabled/i);
    expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
  });

  // ─── Task 5 test 3: the approved-only corpus filter is unaffected ──────────

  it('still learns only from approved summaries on the automatic path once a schema is attached', async () => {
    primeTemplateWithSchema();
    mockContextItemVersionRepo.getVersionsByChangeReason.mockImplementation(async (contextItemId: string, changeReason: string) => {
      if (changeReason !== 'approved') return [];
      return contextItemId === 'ci-approved' ? [{ id: 'v-1', contextItemId, changeReason: 'approved', versionNumber: 1 }] : [];
    });
    mockContextItemRepo.findAll.mockResolvedValue([
      { id: 'ci-approved', content: 'Approved summary body', type: 'RAW_SUMMARY' },
      { id: 'ci-pending', content: 'Pending summary body', type: 'RAW_SUMMARY' },
    ]);
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(JSON.stringify(VALID_PROFILE)));

    await buildProcessor().process(createMockJob({}) as never);

    const [, requestBody] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(requestBody.prompt).toContain('Approved summary body');
    expect(requestBody.prompt).not.toContain('Pending summary body');
  });

  // ─── Fail-closed when NO schema resolves ──────────────────────────────────
  //
  // The schema is the whole containment mechanism: without it the model's raw
  // prose becomes the persisted, cross-patient-injected `styleText`. Any path
  // that leaves `outputSchema` null must therefore FAIL the job, not fall back
  // to permissive parsing. Under owner decision D-A (no production data, no
  // un-migrated tenants) there is nothing left for the permissive branch to be
  // backward-compatible WITH, so it is a fail-open hole, not a compat shim.

  const PHI_BEARING_RESPONSE = JSON.stringify({
    styleText: 'Writes like the note for Patient John Doe, MRN: 88421, DOB 03/14/1985, on metformin 500mg.',
  });

  const expectNothingPersisted = () => {
    expect(mockDnaReportRepo.create).not.toHaveBeenCalled();
    expect(mockDnaReportRepo.update).not.toHaveBeenCalled();
    expect(mockDnaVersionRepo.create).not.toHaveBeenCalled();
  };

  it('hard-fails when the resolved DNA template carries no output schema', async () => {
    mockPromptService.listPromptTemplates.mockResolvedValue([
      { id: 'dna-tpl-no-schema', content: 'Analyze.', category: 'DNA_ANALYSIS', currentVersionNumber: 3 },
    ]);
    mockPromptTemplateRepo.findById.mockResolvedValue({ id: 'dna-tpl-no-schema', metaData: {} });
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(PHI_BEARING_RESPONSE));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/schema/i);
    expectNothingPersisted();
  });

  it('hard-fails when no DNA_ANALYSIS template resolves at all (fallback prompt)', async () => {
    mockPromptService.listPromptTemplates.mockResolvedValue([]);
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(PHI_BEARING_RESPONSE));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/schema/i);
    expectNothingPersisted();
  });

  it('hard-fails when the template-schema read throws instead of degrading to permissive parsing', async () => {
    mockPromptService.listPromptTemplates.mockResolvedValue([
      { id: 'dna-tpl-boom', content: 'Analyze.', category: 'DNA_ANALYSIS', currentVersionNumber: 3 },
    ]);
    mockPromptTemplateRepo.findById.mockRejectedValue(new Error('db down'));
    mockHttpService.axiosRef.post.mockResolvedValue(createAxiosTextResponse(PHI_BEARING_RESPONSE));

    await expect(buildProcessor().process(createMockJob({ textSamples: ['sample'] }) as never)).rejects.toThrow(/schema/i);
    expectNothingPersisted();
  });
});
