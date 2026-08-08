/**
 * SummaryService — bounded JSON auto-repair on the FINALIZE path.
 *
 * The live-doc flush carries a single bounded corrective retry
 * (`live-documentation.service.ts` → `generateJsonWithRepair`). The durable
 * end-of-visit summary — the higher-stakes path, since its output is what the
 * clinician signs — had none: a malformed structured response was stored VERBATIM
 * as the clinical note. These tests pin the same contract on the finalize path.
 *
 * Contract (mirrors `live-documentation.repair.test.ts`):
 *   - structured request + malformed JSON  → EXACTLY ONE corrective retry
 *   - structured request + valid JSON      → no retry (byte-identical to before)
 *   - unstructured request (prose)         → no retry (byte-identical to before)
 *   - the corrective instruction is APPENDED, keeping the prefix-cache-stable
 *     lead-in intact
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { CORRECTIVE_RETRY_INSTRUCTION } from '../../shared/bounded-json-repair';

const VALID_SUMMARY_JSON = JSON.stringify({
  subjective: 'Chest tightness on exertion.',
  objective: 'BP 150/95.',
  assessment: 'Hypertension.',
  plan: 'Start amlodipine 5mg daily.',
});

/** Truncated JSON — strict parse fails, but it clearly opens a JSON object. */
const MALFORMED_SUMMARY_JSON = '{"subjective": "Chest tightness", "objective":';

const SOAP_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'soap_note', schema: { type: 'object' } },
  strict: true,
};

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'user-1' };
    return null;
  }),
  set: vi.fn(),
});

const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  findCaseNotes: vi.fn().mockResolvedValue([]),
  findTranscripts: vi.fn().mockResolvedValue([]),
  findLatestPreSummary: vi.fn().mockResolvedValue(null),
  findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
  create: vi.fn().mockImplementation((entity: { content?: string }) =>
    Promise.resolve({
      id: 'ctx-new',
      consultationId: 'c-1',
      type: 'RAW_SUMMARY',
      content: entity?.content,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  ),
});

const createMockConsultationRepository = () => ({
  findById: vi.fn().mockResolvedValue({
    id: 'c-1',
    tenantId: 'tenant-1',
    departmentId: 'dept-1',
    doctorId: 'doc-1',
    parentConsultationId: null,
  }),
});

const createMockPromptAssemblyService = (responseFormat: unknown) => ({
  assemble: vi.fn().mockResolvedValue({
    userPrompt: 'STABLE PROMPT LEAD-IN — assembled prompt text',
    systemPrompt: 'system',
    hyperparameters: {},
    responseFormat,
    resolvedFrom: 'default',
    promptId: 'prompt-1',
  }),
});

/** `/generate` returns `responses[n]` on the n-th call, repeating the last one. */
function createMockHttpService(responses: string[]) {
  let generateCalls = 0;
  const post = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/generate')) {
      const body = responses[Math.min(generateCalls, responses.length - 1)];
      generateCalls += 1;
      return Promise.resolve({ data: { summary: body, modelName: 'gpt-4o' } });
    }
    return Promise.resolve({ data: {} });
  });
  return {
    axiosRef: { post },
    get generateCalls() {
      return generateCalls;
    },
  };
}

const buildService = (responseFormat: unknown, responses: string[]) => {
  const ctx = createMockContextItemRepository();
  const http = createMockHttpService(responses);
  const promptAssembly = createMockPromptAssemblyService(responseFormat);
  const service = new SummaryService(
    ctx as never,
    createMockConsultationRepository() as never,
    { create: vi.fn().mockResolvedValue({ id: 'meta-1' }) } as never,
    { create: vi.fn() } as never,
    http as never,
    { get: vi.fn().mockReturnValue(undefined) } as never,
    { emit: vi.fn() } as never,
    createMockClsService() as never,
    { create: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) } as never,
    promptAssembly as never,
  );
  return { service, ctx, http };
};

/** The content of the RAW_SUMMARY entity handed to the repository. */
const persistedSummary = (ctx: { create: ReturnType<typeof vi.fn> }): string => (ctx.create.mock.calls[0][0] as { content: string }).content;

const generateBodies = (http: { axiosRef: { post: ReturnType<typeof vi.fn> } }) =>
  http.axiosRef.post.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/generate')).map((c: unknown[]) => c[1] as { prompt: string });

describe('SummaryService — bounded JSON auto-repair on the finalize path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('repairs a malformed structured response with EXACTLY ONE corrective retry and persists the repaired note', async () => {
    const { service, ctx, http } = buildService(SOAP_RESPONSE_FORMAT, [MALFORMED_SUMMARY_JSON, VALID_SUMMARY_JSON]);

    await service.generateSummary('c-1', {
      transcription: 'patient transcript',
      options: { provider: 'lm-studio' },
    } as never);

    // Exactly one retry — never more.
    expect(http.generateCalls).toBe(2);

    // The REPAIRED response is what reaches the clinical record, not the truncated blob.
    expect(persistedSummary(ctx)).toBe(VALID_SUMMARY_JSON);
    expect(persistedSummary(ctx)).not.toBe(MALFORMED_SUMMARY_JSON);
  });

  it('appends the corrective instruction AFTER the stable prompt (prefix-cache discipline)', async () => {
    const { service, http } = buildService(SOAP_RESPONSE_FORMAT, [MALFORMED_SUMMARY_JSON, VALID_SUMMARY_JSON]);

    await service.generateSummary('c-1', {
      transcription: 'patient transcript',
      options: { provider: 'lm-studio' },
    } as never);

    const [first, repair] = generateBodies(http);
    expect(first.prompt).not.toContain(CORRECTIVE_RETRY_INSTRUCTION);
    expect(repair.prompt).toContain(CORRECTIVE_RETRY_INSTRUCTION);
    // Appended, not prepended: the original prompt is a byte-identical prefix.
    expect(repair.prompt.startsWith(first.prompt)).toBe(true);
  });

  it('does NOT retry when the structured response already parses', async () => {
    const { service, ctx, http } = buildService(SOAP_RESPONSE_FORMAT, [VALID_SUMMARY_JSON]);

    await service.generateSummary('c-1', {
      transcription: 'patient transcript',
      options: { provider: 'lm-studio' },
    } as never);

    expect(http.generateCalls).toBe(1);
    expect(persistedSummary(ctx)).toBe(VALID_SUMMARY_JSON);
  });

  it('does NOT retry an unstructured (prose) response — no response_format was sent', async () => {
    const prose = 'Subjective: chest tightness. Objective: BP 150/95. Assessment: HTN. Plan: amlodipine.';
    const { service, ctx, http } = buildService(null, [prose]);

    await service.generateSummary('c-1', {
      transcription: 'patient transcript',
      options: { provider: 'lm-studio' },
    } as never);

    // Prose is the contract on an unstructured request — a retry could never yield JSON.
    expect(http.generateCalls).toBe(1);
    expect(persistedSummary(ctx)).toBe(prose);
  });

  it('does NOT retry prose returned on a structured request (tolerant path, no wasted regen)', async () => {
    const prose = 'Subjective: chest tightness. Plan: amlodipine.';
    const { service, ctx, http } = buildService(SOAP_RESPONSE_FORMAT, [prose]);

    await service.generateSummary('c-1', {
      transcription: 'patient transcript',
      options: { provider: 'lm-studio' },
    } as never);

    expect(http.generateCalls).toBe(1);
    expect(persistedSummary(ctx)).toBe(prose);
  });

  it('falls back to the retry response when the repair also fails to parse (never blocks the caller)', async () => {
    const stillBroken = '{"subjective": "still truncated"';
    const { service, ctx, http } = buildService(SOAP_RESPONSE_FORMAT, [MALFORMED_SUMMARY_JSON, stillBroken]);

    await service.generateSummary('c-1', {
      transcription: 'patient transcript',
      options: { provider: 'lm-studio' },
    } as never);

    expect(http.generateCalls).toBe(2);
    expect(persistedSummary(ctx)).toBe(stillBroken);
  });
});
