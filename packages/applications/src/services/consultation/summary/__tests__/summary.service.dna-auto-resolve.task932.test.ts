/**
 * TASK-932 D-10 — finalize applies the clinician's OWN writing style, with no caller naming it.
 *
 * ## The defect
 *
 * TASK-891 OD-5 removed the "Writing style" dropdown from the scribe footer — correctly: "the
 * workflow combines agents including summarization (partial and finalize) and DNA writing style
 * redaction … I dont think we need any dropdown". What it left behind is that
 * `GenerateSummaryRequest.dnaStyleId` is now permanently `undefined` from the console, and
 * `resolveEffectiveDnaStyleId` returned early on exactly that. So `prompt-assembly` never got an
 * id, `dna_style_text` was never injected, and every finalized note came back in the model's own
 * voice — while the clinician had been told to author a DNA report FIRST and could see it on
 * their own settings page. The report was read by nothing.
 *
 * ## What this suite pins
 *
 * 1. no explicit id + a doctor with a report ⇒ that report's id reaches assembly (and the
 *    persisted `dnaWritingStyleId`, so the note carries its own provenance);
 * 2. an EXPLICIT id still wins — the new tier is a fallback, not an override;
 * 3. the effective gate still decides: tenant-off or doctor-off ⇒ no style, auto-resolved or not.
 *    This is the half that matters clinically, because the doctor's opt-out lives behind it;
 * 4. a doctor with no report finalizes with no style, and nothing throws;
 * 5. WITHOUT a ConfigResolver nothing is auto-resolved at all — applying a style whose on/off
 *    switch cannot be read would be a new decision made in the dark.
 */
import { describe, expect, it, vi } from 'vitest';

import { SummaryService } from '../summary.service';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';

const clsService = () => ({
  get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
  set: vi.fn(),
  run: vi.fn((callback: () => unknown) => callback()),
});

const contextItemRepository = () => ({
  findById: vi.fn(),
  findCaseNotes: vi.fn(),
  findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
  findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
  create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
  update: vi.fn(),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

interface Wiring {
  /** `undefined` ⇒ the doctor has no report. */
  reportId?: string;
  /** The effective on/off answer, or `null` to omit the ConfigResolver entirely. */
  effective: boolean | null;
}

function build(wiring: Wiring) {
  const contextItems = contextItemRepository();
  const promptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'assembled', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'agent', promptId: 'tpl' }),
  };
  const dnaReportRepository = {
    findLatestForDoctor: vi.fn().mockResolvedValue(wiring.reportId ? { id: wiring.reportId } : null),
  };
  const configResolver =
    wiring.effective === null ? undefined : { resolveEffectiveDnaStyleEnabled: vi.fn().mockResolvedValue({ effective: wiring.effective }) };

  // 31 positional parameters; only the ones this suite exercises are real. Named by index so a
  // constructor change fails HERE rather than shifting a mock into the wrong slot silently.
  const args: unknown[] = new Array(31).fill(undefined);
  args[0] = contextItems;
  args[1] = { findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: TENANT, doctorId: DOCTOR, departmentId: 'dept-1' }), update: vi.fn() };
  args[2] = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) };
  args[3] = { create: vi.fn() };
  args[4] = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm' } }) } };
  args[5] = { get: vi.fn(() => undefined) };
  args[6] = { emit: vi.fn() };
  args[7] = clsService();
  args[8] = { create: vi.fn(), findById: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]), encryptFieldsIntoEntity: vi.fn() };
  args[9] = promptAssemblyService;
  args[15] = configResolver;
  args[30] = dnaReportRepository;

  const service = new (SummaryService as unknown as new (...a: unknown[]) => SummaryService)(...args);
  return { service, promptAssemblyService, dnaReportRepository, configResolver, contextItems };
}

const generate = (service: SummaryService, dnaStyleId?: string) =>
  service.generateSummary('c-1', { transcription: 'today the patient reported …', ...(dnaStyleId ? { dnaStyleId } : {}) } as never);

const assembledWith = (promptAssemblyService: { assemble: { mock: { calls: unknown[][] } } }) =>
  promptAssemblyService.assemble.mock.calls.at(-1)![0] as { dnaStyleId?: string };

describe('TASK-932 D-10 — the finalize path resolves the clinician`s own DNA style', () => {
  it('with no explicit id, the consultation doctor`s latest report is what reaches prompt assembly', async () => {
    const { service, promptAssemblyService, dnaReportRepository, contextItems } = build({ reportId: 'dna-doctor-1', effective: true });

    await generate(service);

    expect(dnaReportRepository.findLatestForDoctor).toHaveBeenCalledWith(DOCTOR);
    expect(assembledWith(promptAssemblyService).dnaStyleId).toBe('dna-doctor-1');
    // …and the note records WHICH style produced it. `CreateRawSummary` takes the id as its
    // fourth argument, so a note finalized under a style is self-describing.
    const created = contextItems.create.mock.calls.at(-1)![0] as { dnaWritingStyleId?: string };
    expect(created.dnaWritingStyleId).toBe('dna-doctor-1');
  });

  it('an EXPLICIT id still wins — the doctor`s report is a FALLBACK, never an override', async () => {
    const { service, promptAssemblyService, dnaReportRepository } = build({ reportId: 'dna-doctor-1', effective: true });

    await generate(service, 'dna-explicit');

    expect(assembledWith(promptAssemblyService).dnaStyleId).toBe('dna-explicit');
    expect(dnaReportRepository.findLatestForDoctor).not.toHaveBeenCalled();
  });

  it('the effective gate still decides: off ⇒ no style, even though a report exists', async () => {
    const { service, promptAssemblyService, configResolver } = build({ reportId: 'dna-doctor-1', effective: false });

    await generate(service);

    expect(configResolver!.resolveEffectiveDnaStyleEnabled).toHaveBeenCalledWith({ tenantId: TENANT, departmentId: 'dept-1', doctorId: DOCTOR });
    expect(assembledWith(promptAssemblyService).dnaStyleId).toBeUndefined();
  });

  it('a doctor with no report finalizes with no style, and the gate is not even consulted', async () => {
    const { service, promptAssemblyService, configResolver } = build({ effective: true });

    await generate(service);

    expect(assembledWith(promptAssemblyService).dnaStyleId).toBeUndefined();
    expect(configResolver!.resolveEffectiveDnaStyleEnabled).not.toHaveBeenCalled();
  });

  it('without a ConfigResolver nothing is auto-resolved — an explicit id passes through, as it always did', async () => {
    const { service, promptAssemblyService, dnaReportRepository } = build({ reportId: 'dna-doctor-1', effective: null });

    await generate(service);
    expect(assembledWith(promptAssemblyService).dnaStyleId).toBeUndefined();
    expect(dnaReportRepository.findLatestForDoctor).not.toHaveBeenCalled();

    await generate(service, 'dna-explicit');
    expect(assembledWith(promptAssemblyService).dnaStyleId).toBe('dna-explicit');
  });
});
