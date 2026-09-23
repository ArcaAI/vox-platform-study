/**
 * TASK-1001 (owner decision 2026-09-23) — the PRE-SUMMARY and FINAL-SUMMARY paths write the note in
 * the platform-default OUTPUT language, never in the consultation's declared (source) language.
 *
 * ## The defect on this surface
 *
 * `SummaryService` feeds `PromptAssemblyService` a value it calls `conversationLanguage`. The name
 * is the trap: what the value DOES is choose the output. It renders as `{{conversation_language}}`
 * into bodies that say "write the content in the conversation language", and through
 * `buildPreSummaryVariables` it becomes the pre-summary's `{{language_name}}` ("Write ALL bullet
 * content in …"). It was fed per-request options first and the consultation's declared language
 * second — so a consultation ALaaS opens as `ml-en` (Malayalam-led code-switch) was told to write
 * in the conversation language.
 *
 * *"The summarization (both pre-summary and summary) is still in English, by admin configuration
 * OR by default."* This surface cannot SELECT a tenant policy fragment — assembly resolves the
 * agent's primary template, not its fragment list — so it states the platform default,
 * `consultation.summary.outputLanguage`.
 *
 * Driven through the real public methods; `assemble` records its input and then stops the call, so
 * nothing downstream of prompt assembly needs a fixture.
 */
import { describe, expect, it, vi } from 'vitest';

import { SummaryService } from '../summary.service';
import { SummaryServiceModule } from '../summary.service.module';
import { EffectiveSettingsService } from '../../../settings-registry/effective-settings.service';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';
import { resolvableTokens } from '../../../gate-edit-mining/__tests__/module-graph.helper';

const TENANT = 'tenant-1001';
const CID = 'consultation-1001';

/** Thrown by `assemble` once it has recorded its input. */
const STOP = new Error('stop after prompt assembly');

interface Wiring {
  /** What `Consultation.metadata` carries. */
  metadata?: Record<string, unknown> | null;
  /** The stored platform default; `undefined` ⇒ nothing stored (the facade answers `en`). `null` ⇒ no settings graph wired. */
  platformDefault?: unknown;
  /** Make the settings read fail outright. */
  settingsThrow?: boolean;
}

function build(wiring: Wiring = {}) {
  const assemble = vi.fn(async (_params: unknown) => {
    throw STOP;
  });
  const resolveEffective = vi.fn(async (key: string) => {
    if (wiring.settingsThrow) throw new Error('settings backend down');
    if (key !== CONSULTATION_OUTPUT_LANGUAGE_KEY) return { key, tier: 'global-kv', value: undefined, sourceScope: 'code-default' };
    return wiring.platformDefault === undefined
      ? { key, tier: 'global-kv', value: 'en', sourceScope: 'code-default' }
      : { key, tier: 'global-kv', value: wiring.platformDefault, sourceScope: 'system' };
  });

  // Positional, assembled BY INDEX (the convention of the neighbouring suites) so a constructor
  // change fails here rather than sliding a mock into the wrong slot. 37 = `effectiveSettings`.
  const args: unknown[] = new Array(38).fill(undefined);
  args[0] = {
    findCaseNotes: vi.fn().mockResolvedValue([{ id: 'note-1', content: 'Prior visit: anaemia, on iron.' }]),
    findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
    findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
    findById: vi.fn(),
  };
  args[1] = {
    findById: vi
      .fn()
      .mockResolvedValue({ id: CID, tenantId: TENANT, doctorId: 'doctor-1', departmentId: 'dept-1', metadata: wiring.metadata ?? null }),
  };
  args[2] = { create: vi.fn() };
  args[3] = { create: vi.fn() };
  args[4] = { axiosRef: { post: vi.fn() } };
  args[5] = { get: vi.fn(() => undefined) };
  args[6] = { emit: vi.fn() };
  args[7] = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
    set: vi.fn(),
    run: vi.fn((callback: () => unknown) => callback()),
  };
  args[8] = { create: vi.fn(), findById: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) };
  args[9] = { assemble };
  args[37] = wiring.platformDefault === null ? undefined : { resolveEffective };

  const service = new (SummaryService as unknown as new (...a: unknown[]) => SummaryService)(...args);
  return { service, assemble, resolveEffective };
}

type Assembled = { conversationLanguage?: string };
const assembledWith = (assemble: { mock: { calls: unknown[][] } }): Assembled => assemble.mock.calls.at(-1)![0] as Assembled;

const preSummary = async (service: SummaryService, options?: Record<string, unknown>) =>
  expect(service.generatePreSummary(CID, { ...(options ? { options } : {}) } as never)).rejects.toBe(STOP);

const finalSummary = async (service: SummaryService, options?: Record<string, unknown>) =>
  expect(service.generateSummary(CID, { transcription: 'today the patient reported …', ...(options ? { options } : {}) } as never)).rejects.toBe(
    STOP,
  );

describe.each([
  ['PRE-SUMMARY', preSummary],
  ['FINAL SUMMARY', finalSummary],
])('%s — the note is written in the platform-default output language', (_label, run) => {
  it.each([
    ['`ml-en` (the code-switch mode that caused the report)', { summaryLanguage: 'ml-en' }],
    ['`ml`', { summaryLanguage: 'ml' }],
    ['nothing', {}],
  ])('a consultation declaring %s ⇒ English', async (_declared, metadata) => {
    const { service, assemble } = build({ metadata });

    await run(service);

    expect(assembledWith(assemble).conversationLanguage).toBe('en');
  });

  it('a per-request language option is NOT admin configuration and does not choose the output', async () => {
    const { service, assemble } = build({ metadata: { summaryLanguage: 'ml-en' } });

    await run(service, { language: 'ml-en', conversationLanguage: 'ml', locale: 'ml-IN' });

    expect(assembledWith(assemble).conversationLanguage).toBe('en');
  });

  it('follows the platform default when a platform admin changes it', async () => {
    const { service, assemble, resolveEffective } = build({ metadata: { summaryLanguage: 'en' }, platformDefault: 'ml' });

    await run(service);

    expect(resolveEffective).toHaveBeenCalledWith(CONSULTATION_OUTPUT_LANGUAGE_KEY, { tenantId: TENANT });
    expect(assembledWith(assemble).conversationLanguage).toBe('ml');
  });

  it('a stored value that is not ONE language falls back to English', async () => {
    const { service, assemble } = build({ platformDefault: 'ml-en' });

    await run(service);

    expect(assembledWith(assemble).conversationLanguage).toBe('en');
  });

  it('an unwired settings graph writes English — never the consultation`s declared language', async () => {
    const { service, assemble } = build({ metadata: { summaryLanguage: 'ml' }, platformDefault: null });

    await run(service);

    expect(assembledWith(assemble).conversationLanguage).toBe('en');
  });

  it('a settings-backend failure degrades to English rather than failing the clinician`s summary', async () => {
    const { service, assemble } = build({ metadata: { summaryLanguage: 'ml-en' }, settingsThrow: true });

    await run(service);

    expect(assembledWith(assemble).conversationLanguage).toBe('en');
  });
});

describe('SummaryServiceModule — the settings facade is actually wired', () => {
  it('resolves EffectiveSettingsService, so a platform admin`s write reaches these two paths', () => {
    // `@Optional()` means a forgotten import is SILENT: every note would still come out English
    // (the code default), and the setting would be dead on this surface with nothing failing.
    expect(resolvableTokens(SummaryServiceModule).has(EffectiveSettingsService)).toBe(true);
  });
});
