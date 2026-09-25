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
 * TASK-1006 — the chain summary runs on the agent plane, so the resolved language reaches the agent
 * as its `language_name` variable (the name the seeded bodies state it under).
 *
 * Driven through the real `generateComprehensiveSummary`; `invokeText` records its input and stops.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ChainSummaryService } from '../chain-summary.service';
import { ChainSummaryServiceModule } from '../chain-summary.service.module';
import { EffectiveSettingsService } from '../../../settings-registry/effective-settings.service';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';
import { resolvableTokens } from '../../../gate-edit-mining/__tests__/module-graph.helper';

const TENANT = 'tenant-1';
// An HttpException, so the service passes it through unchanged (a bare Error would be mapped to the
// route's 400, as a TEXT transport failure is).
const STOP = new ServiceUnavailableException('stop after the agent invocation');

function build(platformDefault?: unknown) {
  const consultation = {
    id: 'c-1',
    tenantId: TENANT,
    doctorId: 'doc-1',
    departmentId: 'dept-1',
    patientId: 'pat-1',
    metadata: { summaryLanguage: 'ml-en' },
  };
  const invokeText = vi.fn(async (..._args: unknown[]) => {
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
    { emit: vi.fn() } as never,
    {
      get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
      set: vi.fn(),
      run: vi.fn((cb: () => unknown) => cb()),
    } as never,
    { resolve: vi.fn().mockResolvedValue({ slug: 'general-medicine-summarization', task: 'TEXT_GENERATION' }) } as never,
    { invokeText } as never,
    undefined, // 8  secretsService
    undefined, // 9  usageLedger
    undefined, // 10 unitOfWork
    undefined, // 11 noteGenerationService
    undefined, // 12 visitTypes
    undefined, // 13 computeDevice
    settings as never, // 14 effectiveSettings
  );

  return { service, invokeText, settings };
}

/** A request that asks for a language per call — which must NOT choose the output. */
const REQUEST = { includeNER: false, options: { conversationLanguage: 'ml', language: 'ml-en', locale: 'ml-IN' } } as never;

const invokedLanguage = (invokeText: { mock: { calls: unknown[][] } }) =>
  (invokeText.mock.calls.at(-1)![2] as { variables: { language_name: string } }).variables.language_name;

describe('ChainSummaryService — the platform-default output language', () => {
  it('writes English by default — never the per-request option, never the declared `ml-en`', async () => {
    const { service, invokeText } = build();

    await expect(service.generateComprehensiveSummary('c-1', REQUEST)).rejects.toBe(STOP);

    expect(invokedLanguage(invokeText)).toBe('English');
  });

  it('follows the platform default a platform admin sets, read for the consultation`s tenant', async () => {
    const { service, invokeText, settings } = build('ml');

    await expect(service.generateComprehensiveSummary('c-1', REQUEST)).rejects.toBe(STOP);

    expect(settings!.resolveEffective).toHaveBeenCalledWith(CONSULTATION_OUTPUT_LANGUAGE_KEY, { tenantId: TENANT });
    expect(invokedLanguage(invokeText)).toBe('Malayalam');
  });

  it('a settings-backend failure degrades to English rather than failing the summary', async () => {
    const { service, invokeText } = build('throw');

    await expect(service.generateComprehensiveSummary('c-1', REQUEST)).rejects.toBe(STOP);

    expect(invokedLanguage(invokeText)).toBe('English');
  });
});

describe('ChainSummaryServiceModule — the settings facade is actually wired', () => {
  it('resolves EffectiveSettingsService, so a platform admin`s write reaches the chain path', () => {
    expect(resolvableTokens(ChainSummaryServiceModule).has(EffectiveSettingsService)).toBe(true);
  });
});
