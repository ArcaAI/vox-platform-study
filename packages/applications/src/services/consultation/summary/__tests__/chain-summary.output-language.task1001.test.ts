// MUST be first — `services/index.ts` participates in a PRE-EXISTING import cycle, so requiring a
// deep module file first can leave `imports` entries `undefined` at decoration time. Importing the
// package barrel reproduces the production evaluation order (as `text-enrichment.di-wiring.task808`).
import '../../../../index';
/**
 * TASK-1001 (OD-12) — the synchronous chain (comprehensive) summary writes in the platform-default
 * output language, `consultation.summary.outputLanguage`.
 *
 * It used to resolve "the request's `options.conversationLanguage` / `language` / `locale`, else the
 * literal `'en'`" — a hardcoded default and a per-call language that is neither admin configuration
 * nor the default. It now reads the SAME setting, through the same helper, as `SummaryService`.
 *
 * Driven through the real `generateComprehensiveSummary`; `assemble` records its input and stops.
 */
import { describe, expect, it, vi } from 'vitest';

import { ChainSummaryService } from '../chain-summary.service';
import { ChainSummaryServiceModule } from '../chain-summary.service.module';
import { EffectiveSettingsService } from '../../../settings-registry/effective-settings.service';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';
import { resolvableTokens } from '../../../gate-edit-mining/__tests__/module-graph.helper';

const TENANT = 'tenant-1';
const STOP = new Error('stop after prompt assembly');

function build(platformDefault?: unknown) {
  const consultation = {
    id: 'c-1',
    tenantId: TENANT,
    doctorId: 'doc-1',
    departmentId: 'dept-1',
    patientId: 'pat-1',
    metadata: { summaryLanguage: 'ml-en' },
  };
  const assemble = vi.fn(async (_params: unknown) => {
    throw STOP;
  });
  const settings =
    platformDefault === undefined
      ? undefined
      : {
          resolveEffective: vi.fn(async (key: string) => {
            if (platformDefault === 'throw') throw new Error('settings backend down');
            return { key, tier: 'global-kv', value: platformDefault, sourceScope: 'system' };
          }),
        };

  const service = new ChainSummaryService(
    {
      findById: vi.fn(),
      findTranscripts: vi.fn().mockResolvedValue([{ id: 't-1', content: 'transcript', consultationId: 'c-1' }]),
      findCaseNotes: vi.fn().mockResolvedValue([]),
      findSummaries: vi.fn().mockResolvedValue([]),
      findPreSummaries: vi.fn().mockResolvedValue([]),
      findSharedContext: vi.fn().mockResolvedValue([]),
    } as never,
    {
      findById: vi.fn().mockResolvedValue(consultation),
      findConsultationChain: vi.fn().mockResolvedValue([consultation]),
      findByPatientAndDate: vi.fn().mockResolvedValue([consultation]),
    } as never,
    { create: vi.fn() } as never,
    { findByContextItem: vi.fn().mockResolvedValue([]) } as never,
    { axiosRef: { post: vi.fn() } } as never,
    { get: vi.fn(() => 'http://text') } as never,
    { emit: vi.fn() } as never,
    {
      get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
      set: vi.fn(),
      run: vi.fn((cb: () => unknown) => cb()),
    } as never,
    { assemble } as never,
    undefined, // 9  secretsService
    undefined, // 10 harnessPolicyService
    undefined, // 11 configResolver
    undefined, // 12 usageLedger
    undefined, // 13 unitOfWork
    undefined, // 14 noteGenerationService
    undefined, // 15 textRequestEnrichment
    undefined, // 16 visitTypes
    undefined, // 17 computeDevice
    settings as never, // 18 effectiveSettings
  );

  return { service, assemble, settings };
}

/** A request that asks for a language per call — which must NOT choose the output. */
const REQUEST = { includeNER: false, options: { conversationLanguage: 'ml', language: 'ml-en', locale: 'ml-IN' } } as never;

const assembledLanguage = (assemble: { mock: { calls: unknown[][] } }) =>
  (assemble.mock.calls.at(-1)![0] as { conversationLanguage: string }).conversationLanguage;

describe('ChainSummaryService — the platform-default output language', () => {
  it('writes English by default — never the per-request option, never the declared `ml-en`', async () => {
    const { service, assemble } = build();

    await expect(service.generateComprehensiveSummary('c-1', REQUEST)).rejects.toBe(STOP);

    expect(assembledLanguage(assemble)).toBe('en');
  });

  it('follows the platform default a platform admin sets, read for the consultation`s tenant', async () => {
    const { service, assemble, settings } = build('ml');

    await expect(service.generateComprehensiveSummary('c-1', REQUEST)).rejects.toBe(STOP);

    expect(settings!.resolveEffective).toHaveBeenCalledWith(CONSULTATION_OUTPUT_LANGUAGE_KEY, { tenantId: TENANT });
    expect(assembledLanguage(assemble)).toBe('ml');
  });

  it('a settings-backend failure degrades to English rather than failing the summary', async () => {
    const { service, assemble } = build('throw');

    await expect(service.generateComprehensiveSummary('c-1', REQUEST)).rejects.toBe(STOP);

    expect(assembledLanguage(assemble)).toBe('en');
  });
});

describe('ChainSummaryServiceModule — the settings facade is actually wired', () => {
  it('resolves EffectiveSettingsService, so a platform admin`s write reaches the chain path', () => {
    expect(resolvableTokens(ChainSummaryServiceModule).has(EffectiveSettingsService)).toBe(true);
  });
});
