// MUST be first — `services/index.ts` participates in a PRE-EXISTING import cycle, so requiring a
// deep module file first can leave `imports` entries `undefined` at decoration time. Importing the
// package barrel reproduces the production evaluation order (as `text-enrichment.di-wiring.task808`).
import '../../../../../index';
/**
 * TASK-1001 (OD-12) — the pre-summary QUEUE processor writes in the
 * platform-default output language, `consultation.summary.outputLanguage`.
 *
 * It used to resolve the output language as "the job's `options.conversationLanguage` /
 * `language` / `locale`, else the literal `'en'`": a hardcoded default (the config rule) and a
 * per-call language that is neither admin configuration nor the default (the owner rule, *"English
 * by admin configuration OR by default"*). It now reads the SAME setting, through the same helper,
 * as `SummaryService` — so a platform admin's write reaches the job path too.
 *
 * (`ComprehensiveSummaryProcessor` was covered here too until TASK-1006 removed it outright —
 * the comprehensive summary now runs synchronously on the agent plane.)
 *
 * Driven through the real `process()`; `assemble` records its input and then stops the job.
 */
import { describe, expect, it, vi } from 'vitest';

import { PreSummaryProcessor } from '../pre-summary.processor';
import { ConsultationJobServiceModule } from '../../consultation-job.service.module';
import { EffectiveSettingsService } from '../../../../settings-registry/effective-settings.service';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../../settings-registry/descriptors/consultation-output-language.descriptors';
import { resolvableTokens } from '../../../../gate-edit-mining/__tests__/module-graph.helper';

const TENANT = 'tenant-1';
const STOP = new Error('stop after prompt assembly');

const consultation = {
  id: 'consult-1',
  tenantId: TENANT,
  departmentId: null as string | null,
  parentConsultationId: null as string | null,
  doctorId: 'doctor-1',
  metadata: { summaryLanguage: 'ml-en' },
};

/** `undefined` ⇒ no settings graph wired; `'throw'` ⇒ the backend fails. */
function settingsFor(platformDefault: unknown) {
  if (platformDefault === undefined) return undefined;
  return {
    resolveEffective: vi.fn(async (key: string) => {
      if (platformDefault === 'throw') throw new Error('settings backend down');
      return { key, tier: 'global-kv', value: platformDefault, sourceScope: 'system' };
    }),
  };
}

const common = () => ({
  jobService: {
    notifyProgress: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
    notifyFailed: vi.fn().mockResolvedValue(undefined),
  },
  consultationRepository: { findById: vi.fn().mockResolvedValue(consultation) },
  httpService: { axiosRef: { post: vi.fn() } },
  configService: { get: vi.fn(() => 'http://text.test') },
  promptResolutionService: { resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'tenant', template: 'Pre-Summary', promptId: 'p1' }) },
  promptAssemblyService: {
    assemble: vi.fn(async (_params: unknown) => {
      throw STOP;
    }),
  },
  jobMetrics: {
    recordJobStart: vi.fn(() => () => 1),
    recordWaitingDuration: vi.fn(),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordTextCallDuration: vi.fn(),
  },
  cls: { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() },
});

function preSummary(platformDefault?: unknown) {
  const deps = common();
  const settings = settingsFor(platformDefault);
  const processor = new PreSummaryProcessor(
    deps.jobService as any,
    {
      findByConsultation: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'Chest pain for three days.' }]),
      findById: vi.fn(),
    } as any,
    deps.consultationRepository as any,
    deps.httpService as any,
    deps.configService as any,
    deps.promptResolutionService as any,
    deps.promptAssemblyService as any,
    deps.jobMetrics as any,
    deps.cls as any,
    undefined, // 9  secretsService
    undefined, // 10 harnessPolicyService
    undefined, // 11 configResolver
    undefined, // 12 noteGenerationService
    undefined, // 13 textRequestEnrichment
    undefined, // 14 visitTypes
    settings as any, // 15 effectiveSettings
  );
  return { processor, assemble: deps.promptAssemblyService.assemble, settings };
}

/** A job whose caller asked for a language per call — which must NOT choose the output. */
const job = (request: Record<string, unknown>) =>
  ({
    id: 'bull-1',
    timestamp: Date.now(),
    data: {
      jobId: 'job-1',
      consultationId: 'consult-1',
      tenantId: TENANT,
      userId: 'user-1',
      request: { ...request, options: { conversationLanguage: 'ml', language: 'ml-en', locale: 'ml-IN' } },
    },
  }) as any;

const assembledLanguage = (assemble: { mock: { calls: unknown[][] } }) =>
  (assemble.mock.calls.at(-1)![0] as { conversationLanguage: string }).conversationLanguage;

describe('PreSummaryProcessor — the platform-default output language', () => {
  it('writes English by default — never the per-request option, never the declared `ml-en`', async () => {
    const { processor, assemble } = preSummary();

    await expect(processor.process(job({}))).rejects.toBe(STOP);

    expect(assembledLanguage(assemble)).toBe('en');
  });

  it('follows the platform default a platform admin sets, read for the JOB`s tenant', async () => {
    const { processor, assemble, settings } = preSummary('ml');

    await expect(processor.process(job({}))).rejects.toBe(STOP);

    expect(settings!.resolveEffective).toHaveBeenCalledWith(CONSULTATION_OUTPUT_LANGUAGE_KEY, { tenantId: TENANT });
    expect(assembledLanguage(assemble)).toBe('ml');
  });

  it('a settings-backend failure degrades to English rather than failing the job', async () => {
    const { processor, assemble } = preSummary('throw');

    await expect(processor.process(job({}))).rejects.toBe(STOP);

    expect(assembledLanguage(assemble)).toBe('en');
  });
});

describe('ConsultationJobServiceModule — the settings facade is actually wired', () => {
  it('resolves EffectiveSettingsService, so a platform admin`s write reaches the processor', () => {
    // `@Optional()` makes a forgotten import SILENT: every job would still write English.
    expect(resolvableTokens(ConsultationJobServiceModule).has(EffectiveSettingsService)).toBe(true);
  });
});
