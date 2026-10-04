/**
 * TASK-1036 §9.3 lane B3b — the `consultation.*` read model is assembled ONE section at a time,
 * from the existing sources, in the read schema's shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextItemType } from '@arcaai/domains';
import { ConsultationReadModelAssembler, itemKindOf, patientOf, vitalsListOf } from '../consultation-read-model.assembler';

const at = (iso: string) => new Date(iso);
const item = (overrides: Record<string, unknown>) => ({ id: 'i', type: ContextItemType.CASE_NOTE, kindKey: null, metaData: null, mediaId: null, createdAt: at('2026-10-01T10:00:00Z'), content: 'x', encryptedContent: null, ...overrides });

const contextItems = {
  findTranscripts: vi.fn(),
  findByConsultation: vi.fn(),
  findPreSummaries: vi.fn(),
  findByType: vi.fn(),
  findLatestByKindKey: vi.fn(),
};
const departments = { findByIdOrNull: vi.fn() };
const media = { findByIdOrNull: vi.fn() };
const segments = { findByContextItem: vi.fn() };
const dna = { findLatestForDoctor: vi.fn(), decryptFieldsFromEntity: vi.fn() };
const secrets = {};
const resolver = { resolveDoctorDnaPreference: vi.fn() };

const consultation = {
  id: 'c-1',
  tenantId: 't-1',
  doctorId: 'doc-1',
  departmentId: 'dep-1',
  parentConsultationId: 'c-0',
  spokenLanguageMode: 'ml-en',
  metadata: { patient: { age: 54, gender: 'female' } },
};

function makeAssembler() {
  return new ConsultationReadModelAssembler(
    contextItems as never,
    departments as never,
    media as never,
    segments as never,
    dna as never,
    secrets as never,
    resolver as never,
    undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  contextItems.findTranscripts.mockResolvedValue([
    item({ id: 'agg', type: ContextItemType.TRANSCRIPT, metaData: { subType: 'STT_AGGREGATE' }, content: 'Hello doctor. I have a cough.' }),
    item({ id: 'seg', type: ContextItemType.TRANSCRIPT, metaData: { subType: 'TRANSCRIPT_SEGMENT' }, content: 'Hello doctor.' }),
  ]);
  segments.findByContextItem.mockResolvedValue([
    { idx: 0, charStart: 0, charEnd: 13, t0Ms: 0, t1Ms: 1500, speaker: 'patient' },
    { idx: 1, charStart: 14, charEnd: 29, t0Ms: 1500, t1Ms: 3200, speaker: 'patient' },
  ]);
  contextItems.findByConsultation.mockResolvedValue([
    item({ id: 'n1', type: ContextItemType.CASE_NOTE, content: 'Fever 3 days' }),
    item({ id: 'n2', type: ContextItemType.CASE_NOTE, content: 'copy', metaData: { origin: 'open.context' } }),
    item({ id: 'a1', type: ContextItemType.ATTACHMENT, mediaId: 'm1', metaData: { extractedText: 'CBC normal' }, content: 'Lab result: cbc.pdf' }),
    item({ id: 'v1', type: ContextItemType.STRUCTURED, kindKey: 'vitals', content: '{}' }),
    item({ id: 'x1', type: ContextItemType.RAW_SUMMARY, content: 'draft' }),
  ]);
  media.findByIdOrNull.mockResolvedValue({ id: 'm1', mimeType: 'application/pdf', name: 'cbc.pdf', size: 1024 });
  departments.findByIdOrNull.mockResolvedValue({ id: 'dep-1', code: 'GM', name: 'General Medicine' });
  dna.findLatestForDoctor.mockResolvedValue({ id: 'r1' });
  dna.decryptFieldsFromEntity.mockResolvedValue({ styleText: '  Concise.  ', redactionRules: { rules: [{ type: 'rewrite', match: 'literal', pattern: 'pt', replacement: 'patient' }] } });
  resolver.resolveDoctorDnaPreference.mockResolvedValue({ enabled: null, version: 0 });
  contextItems.findPreSummaries.mockResolvedValue([
    item({ id: 'p1', type: ContextItemType.PRE_SUMMARY, content: 'old pre', createdAt: at('2026-10-01T09:00:00Z') }),
    item({ id: 'p2', type: ContextItemType.PRE_SUMMARY, content: 'new pre', createdAt: at('2026-10-01T09:30:00Z') }),
    item({ id: 'p3', type: ContextItemType.PRE_SUMMARY, content: 'live', metaData: { subType: 'LIVE_SOAP_SNAPSHOT' }, createdAt: at('2026-10-01T11:00:00Z') }),
  ]);
  contextItems.findByType.mockImplementation(async (_id: string, type: ContextItemType) =>
    type === ContextItemType.RAW_SUMMARY ? [{ content: 'The running note', createdAt: at('2026-10-01T10:00:00Z') }] : [],
  );
  contextItems.findLatestByKindKey.mockImplementation(async (_id: string, kindKey: string) =>
    kindKey === 'vitals'
      ? item({ content: JSON.stringify({ bloodPressure: '128/82', heartRate: 72, recordedAt: '2026-10-01T09:00:00Z' }) })
      : kindKey === 'investigations'
        ? item({ content: JSON.stringify({ results: [{ name: 'Hb', value: 11.2, unit: 'g/dL', flag: 'L', collectedAt: '2026-09-30' }] }) })
        : kindKey === 'previous_case_notes'
          ? item({ content: JSON.stringify({ notes: [{ date: '2026-09-01', department: 'GM', text: 'Seen for cough' }] }) })
          : null,
  );
});

describe('ConsultationReadModelAssembler', () => {
  it('reads only the sections asked for', async () => {
    const model = await makeAssembler().assemble(consultation as never, 't-1', new Set(['department']));
    expect(model).toEqual({ department: { id: 'dep-1', code: 'GM', name: 'General Medicine' } });
    expect(contextItems.findTranscripts).not.toHaveBeenCalled();
    expect(dna.findLatestForDoctor).not.toHaveBeenCalled();
  });

  it('scalars: id, visitType from the parent link, the SPOKEN language, patient from metadata', async () => {
    const model = await makeAssembler().assemble(consultation as never, 't-1', new Set(['id', 'visitType', 'language', 'patient', 'outputLanguage']));
    expect(model).toMatchObject({
      id: 'c-1',
      visitType: 'revisit',
      language: 'ml-en',
      patient: { age: 54, gender: 'female', dob: null },
      outputLanguage: { code: 'en', name: 'English' },
    });
  });

  it('transcript: the aggregate only, segments sliced from the stored offsets', async () => {
    const model = await makeAssembler().assemble(consultation as never, 't-1', new Set(['transcript']));
    expect(model.transcript).toEqual({
      text: 'Hello doctor. I have a cough.',
      segments: [
        { text: 'Hello doctor.', speaker: 'patient', start: 0, end: 1.5 },
        { text: 'I have a cough.', speaker: 'patient', start: 1.5, end: 3.2 },
      ],
    });
    expect(segments.findByContextItem).toHaveBeenCalledTimes(1);
    expect(segments.findByContextItem).toHaveBeenCalledWith('t-1', 'agg');
  });

  it('items: kinds mapped, open-time case-note copies dropped, attachments by reference', async () => {
    const model = await makeAssembler().assemble(consultation as never, 't-1', new Set(['items']));
    expect(model.items).toEqual([
      { id: 'n1', kind: 'CASE_NOTE', text: 'Fever 3 days', createdAt: '2026-10-01T10:00:00.000Z' },
      {
        id: 'a1',
        kind: 'ATTACHMENT',
        text: 'CBC normal',
        createdAt: '2026-10-01T10:00:00.000Z',
        attachment: { mediaId: 'm1', mime: 'application/pdf', name: 'cbc.pdf', size: 1024 },
      },
      { id: 'v1', kind: 'VITALS', text: '{}', createdAt: '2026-10-01T10:00:00.000Z' },
    ]);
  });

  it('notes: newest non-live pre-summary, and the authoritative note', async () => {
    const model = await makeAssembler().assemble(consultation as never, 't-1', new Set(['notes']));
    expect(model.notes).toEqual({ preSummary: 'new pre', summary: 'The running note' });
  });

  it('clinician.dna honours the doctor`s opt-out', async () => {
    expect((await makeAssembler().assemble(consultation as never, 't-1', new Set(['clinician']))).clinician).toEqual({
      dna: { style: 'Concise.', rules: expect.stringContaining('patient') },
    });
    resolver.resolveDoctorDnaPreference.mockResolvedValue({ enabled: false, version: 1 });
    expect((await makeAssembler().assemble(consultation as never, 't-1', new Set(['clinician']))).clinician).toEqual({ dna: { style: null, rules: null } });
  });

  it('vitals, testResults and previousVisits in the read schema`s list shapes', async () => {
    const model = await makeAssembler().assemble(consultation as never, 't-1', new Set(['vitals', 'testResults', 'previousVisits']));
    expect(model.vitals).toEqual([
      { name: 'Blood pressure', value: '128/82', unit: 'mmHg', measuredAt: '2026-10-01T09:00:00Z' },
      { name: 'Heart rate', value: '72', unit: 'bpm', measuredAt: '2026-10-01T09:00:00Z' },
    ]);
    expect(model.testResults).toEqual([{ name: 'Hb', value: '11.2', unit: 'g/dL', flag: 'L', takenAt: '2026-09-30' }]);
    expect(model.previousVisits).toEqual([{ consultationId: null, date: '2026-09-01', department: 'GM', summary: 'Seen for cough' }]);
  });
});

describe('pure helpers', () => {
  it('itemKindOf ignores non-item rows', () => {
    expect(itemKindOf({ type: ContextItemType.TRANSCRIPT, kindKey: null, metaData: null } as never)).toBeNull();
    expect(itemKindOf({ type: ContextItemType.STRUCTURED, kindKey: 'encounter', metaData: null } as never)).toBeNull();
    expect(itemKindOf({ type: ContextItemType.STRUCTURED, kindKey: 'previous_case_notes', metaData: null } as never)).toBe('PRIOR_VISIT');
  });

  it('patientOf never invents a value', () => {
    expect(patientOf(null)).toEqual({ age: null, gender: null, dob: null });
    expect(patientOf({ patient: { age: '54' } })).toEqual({ age: null, gender: null, dob: null });
  });

  it('vitalsListOf skips absent readings', () => {
    expect(vitalsListOf(undefined)).toEqual([]);
    expect(vitalsListOf({ temperature: 37.2 })).toEqual([{ name: 'Temperature', value: '37.2', unit: '°C', measuredAt: null }]);
  });
});
