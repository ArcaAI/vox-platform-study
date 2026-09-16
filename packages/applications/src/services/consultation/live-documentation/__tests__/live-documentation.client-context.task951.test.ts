/**
 * TASK-951 D-3 / D-7 (OD-4, OD-5) — the realtime lane renders what the CLIENT sent.
 *
 * ## What changed, and why it is not a default being overridden
 *
 * Three of the nine names `realtimeRunContext` publishes had no source in the v2 data model when
 * TASK-943 restored generation, so they took the absence values the workflow's own trigger-context
 * schema declares. Two of them now have a source: since TASK-951 a client states `vitals` and
 * `previous_case_notes` at `open`, they are validated against the tenant's context schema and
 * persisted as PRE context items, and this lane reads them.
 *
 *  - `formatted_vitals` prefers the MEASURED object over the session's NLP-extracted vitals. The
 *    tool output is a model's reading of speech; the client's object is the reading itself.
 *  - `formatted_previous_visits` is the client's own history — newest first, bounded by the same
 *    cap the carried prior-visit summary uses, and marked when it is cut.
 *  - the RECORDED visit type wins over the parent-link derivation at both of this file's
 *    `forConsultation` call sites, so the branch the realtime lane takes and the one the durable
 *    lane's `n_visit` compares are the same answer.
 *
 * Absence is unchanged in every direction: no kind, an unreadable kind, or one that states nothing
 * lands on `Not available` / `''` exactly as before — which is what the assertions below pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

// Lane C owns the marker's STORAGE; this lane owns only "the recorded value is passed through".
// Mocking the one reader keeps that boundary honest: a change to where the marker lives must not
// be able to break this file, and a regression that stops PASSING it must.
const readRecordedVisitType = vi.fn<(metadata: unknown) => string | null>(() => null);
vi.mock('../../consultation/open-markers', () => ({
  readRecordedVisitType: (metadata: unknown) => readRecordedVisitType(metadata),
}));

const TENANT = 'tenant-951';
const CID = 'consultation-951';

interface ContextItemFixture {
  id: string;
  kindKey: string | null;
  content?: string | null;
  encryptedContent?: Buffer | null;
  createdAt: Date;
}

interface Wiring {
  /** Context items the consultation carries. `undefined` ⇒ no repository is wired at all. */
  items?: ContextItemFixture[];
  /** Replaces the whole finder — for the "the read throws" case. */
  findLatestByKindKey?: () => Promise<unknown>;
  decrypt?: (entity: ContextItemFixture) => Promise<string | null>;
  departmentName?: string | null;
  consultation?: Record<string, unknown> | null;
}

/**
 * The two kinds are read by an indexed `findLatestByKindKey` per kind, not by pulling every
 * context item of the consultation and scanning in memory — on the summary path that second shape
 * meant reading a whole encounter's transcripts to answer a question the
 * `ContextItem_consultation_kindKey_idx` index answers directly. The fixture below serves that
 * finder from the same item list, applying the same NEWEST-wins rule the repository does.
 */
function newestOfKind(items: ContextItemFixture[], kindKey: string): ContextItemFixture | null {
  let latest: ContextItemFixture | null = null;
  for (const item of items) {
    if (item.kindKey !== kindKey) continue;
    if (!latest || item.createdAt >= latest.createdAt) latest = item;
  }
  return latest;
}

function buildService(wiring: Wiring = {}) {
  const findLatestByKindKey =
    wiring.findLatestByKindKey ?? vi.fn(async (_consultationId: string, kindKey: string) => newestOfKind(wiring.items ?? [], kindKey));
  const decryptContentFromEntity = vi.fn(async (entity: ContextItemFixture) => (wiring.decrypt ? wiring.decrypt(entity) : null));

  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = {
    get: vi.fn(async () => null),
    setex: vi.fn(),
    publish: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(async () => []),
    expire: vi.fn(),
  };
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  if (wiring.items !== undefined || wiring.findLatestByKindKey) args[5] = { findLatestByKindKey, decryptContentFromEntity };
  args[7] = { decrypt: vi.fn() };
  args[15] = { findById: vi.fn(async () => wiring.consultation ?? null) };
  args[28] = { findById: vi.fn(async () => ({ id: 'dept-1', name: wiring.departmentName ?? 'General Medicine' })) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, findLatestByKindKey, decryptContentFromEntity };
}

type SessionShape = {
  consultationId: string;
  tenantId: string;
  visitType?: string;
  summaryLanguage?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  lastPayload?: { vitals?: Record<string, unknown> };
};

const session = (over: Partial<SessionShape> = {}): SessionShape => ({
  consultationId: CID,
  tenantId: TENANT,
  visitType: 'new-visit',
  summaryLanguage: 'en',
  departmentId: 'dept-1',
  ...over,
});

/** `realtimeRunContext` is private; the narrow cast is the convention every neighbouring test uses. */
const contextOf = async (service: LiveDocumentationService, live: SessionShape) => {
  const run = await (
    service as unknown as { realtimeRunContext(s: SessionShape): Promise<{ trigger: { context: Record<string, string> } }> }
  ).realtimeRunContext(live);
  return run.trigger.context;
};

const item = (kindKey: string, payload: unknown, over: Partial<ContextItemFixture> = {}): ContextItemFixture => ({
  id: `ci-${kindKey}-${Math.random().toString(36).slice(2, 8)}`,
  kindKey,
  content: JSON.stringify(payload),
  createdAt: new Date('2026-09-11T08:00:00.000Z'),
  ...over,
});

/** The full normalised vitals object of OD-4 (owner amendment) — every field populated. */
const FULL_VITALS = {
  bloodPressure: '128/82',
  heartRate: 72,
  respiratoryRate: 16,
  temperature: 37.1,
  oxygenSaturation: 98,
  weightKg: 70,
  heightCm: 172,
  bmi: 23.7,
  bloodGlucose: 110,
  painScore: 3,
};

beforeEach(() => {
  readRecordedVisitType.mockReset();
  readRecordedVisitType.mockReturnValue(null);
});

describe('TASK-951 D-7 — formatted_vitals prefers the client’s measured object', () => {
  it('renders every field of the normalised object on one line, in the declared order', async () => {
    const { service } = buildService({ items: [item('vitals', FULL_VITALS)] });

    const context = await contextOf(service, session());

    expect(context.formatted_vitals).toBe(
      'BP 128/82 mmHg · HR 72 bpm · RR 16 /min · Temp 37.1 °C · SpO2 98 % · Wt 70 kg · Ht 172 cm · BMI 23.7 · Glucose 110 mg/dL · Pain 3/10',
    );
    // `safe_vitals` is the v1 spelling of the same fact and must not disagree with it.
    expect(context.safe_vitals).toBe(context.formatted_vitals);
  });

  it('omits the fields the client did not measure rather than reporting a zero', async () => {
    const { service } = buildService({ items: [item('vitals', { bloodPressure: '110/70', oxygenSaturation: 99 })] });

    const context = await contextOf(service, session());

    expect(context.formatted_vitals).toBe('BP 110/70 mmHg · SpO2 99 %');
    // An unmeasured reading is absent, never `HR 0 bpm` — a zero is a clinical claim.
    expect(context.formatted_vitals).not.toContain('HR');
    expect(context.formatted_vitals).not.toContain('Pain');
  });

  it('carries `recordedAt` on the same line, and `notes` on a second one', async () => {
    const { service } = buildService({
      items: [item('vitals', { ...FULL_VITALS, recordedAt: '2026-09-11T08:40:00Z', notes: 'Taken at triage, patient seated.' })],
    });

    const context = await contextOf(service, session());

    const [readings, notes] = context.formatted_vitals.split('\n');
    // A set taken at triage two hours earlier is a different clinical statement from one taken
    // during the consultation — dropping the time would make the model read it as "now".
    expect(readings).toContain('Pain 3/10 · recorded 2026-09-11T08:40:00Z');
    expect(notes).toBe('Taken at triage, patient seated.');
  });

  it('THE PREFERENCE: the measured object wins over the session’s NLP-extracted vitals', async () => {
    const { service } = buildService({ items: [item('vitals', { bloodPressure: '128/82', heartRate: 72 })] });

    const context = await contextOf(service, session({ lastPayload: { vitals: { systolic: 150, diastolic: 95, heartRate: 101 } } }));

    expect(context.formatted_vitals).toBe('BP 128/82 mmHg · HR 72 bpm');
    // The tool's reading of speech must not be the one the note carries when a measurement exists.
    expect(context.formatted_vitals).not.toContain('150');
    expect(context.formatted_vitals).not.toContain('101');
  });

  it('falls back to the session’s extracted vitals when the client sent none', async () => {
    const { service } = buildService({ items: [] });

    const context = await contextOf(service, session({ lastPayload: { vitals: { systolic: 128, diastolic: 82, heartRate: 76 } } }));

    expect(context.formatted_vitals).toContain('128/82');
    expect(context.formatted_vitals).toContain('76');
  });

  it('falls back to the DECLARED absence value when neither source states anything', async () => {
    const { service } = buildService({ items: [] });

    expect((await contextOf(service, session())).formatted_vitals).toBe('Not available');
  });

  it('treats a client object with no readings as absent — a bare `recordedAt` states nothing', async () => {
    const { service } = buildService({ items: [item('vitals', { recordedAt: '2026-09-11T08:40:00Z', notes: 'nil' })] });

    // Emitting `recorded 08:40` alone would tell the model a vitals set exists when none was sent.
    expect((await contextOf(service, session())).formatted_vitals).toBe('Not available');
  });

  it('reads the NEWEST vitals row when a re-open left more than one behind', async () => {
    const { service } = buildService({
      items: [
        item('vitals', { heartRate: 60 }, { createdAt: new Date('2026-09-11T07:00:00.000Z') }),
        item('vitals', { heartRate: 88 }, { createdAt: new Date('2026-09-11T09:30:00.000Z') }),
      ],
    });

    expect((await contextOf(service, session())).formatted_vitals).toBe('HR 88 bpm');
  });
});

describe('TASK-951 OD-5 — formatted_previous_visits carries the client’s history', () => {
  const notes = [
    { date: '2026-03-02', department: 'Rheumatology', doctor: 'Dr Nair', title: 'Flare review', text: 'Morning stiffness reduced.' },
    { date: '2026-07-19', department: 'General Medicine', doctor: 'Dr Menon', title: 'Follow-up', text: 'BP controlled on amlodipine.' },
  ];

  it('THE DEFECT THIS ENDS: the history a client supplied reaches the prompt', async () => {
    const { service } = buildService({ items: [item('previous_case_notes', { notes })] });

    const context = await contextOf(service, session());

    expect(context.formatted_previous_visits).toContain('BP controlled on amlodipine.');
    expect(context.formatted_previous_visits).toContain('Morning stiffness reduced.');
  });

  it('orders the notes most recent first — a truncated history should lose the oldest visit', async () => {
    const { service } = buildService({ items: [item('previous_case_notes', { notes })] });

    const rendered = (await contextOf(service, session())).formatted_previous_visits;

    expect(rendered.indexOf('2026-07-19')).toBeLessThan(rendered.indexOf('2026-03-02'));
  });

  it('renders each note as its heading line then its body', async () => {
    const { service } = buildService({ items: [item('previous_case_notes', { notes: [notes[1]] })] });

    expect((await contextOf(service, session())).formatted_previous_visits).toBe(
      '2026-07-19 · General Medicine · Dr Menon · Follow-up\nBP controlled on amlodipine.',
    );
  });

  it('renders a note with no heading fields as its text alone', async () => {
    const { service } = buildService({ items: [item('previous_case_notes', { notes: [{ text: 'Referred from camp.' }] })] });

    expect((await contextOf(service, session())).formatted_previous_visits).toBe('Referred from camp.');
  });

  it('keeps an unparseable date in the order the client sent it, after the dated notes', async () => {
    const { service } = buildService({
      items: [
        item('previous_case_notes', {
          notes: [
            { date: 'last monsoon', text: 'undated A' },
            { date: '2026-01-05', text: 'dated' },
            { date: 'some time ago', text: 'undated B' },
          ],
        }),
      ],
    });

    const rendered = (await contextOf(service, session())).formatted_previous_visits;

    // A free-text date is not evidence of position: it must not be silently sorted as epoch 0.
    expect(rendered.indexOf('dated')).toBeLessThan(rendered.indexOf('undated A'));
    expect(rendered.indexOf('undated A')).toBeLessThan(rendered.indexOf('undated B'));
  });

  it('bounds the history at the prior-visit cap and MARKS the cut', async () => {
    const { service } = buildService({
      items: [item('previous_case_notes', { notes: [{ text: 'x'.repeat(20_000) }] })],
    });

    const rendered = (await contextOf(service, session())).formatted_previous_visits;

    expect(rendered.length).toBeLessThan(20_000);
    // A truncated history must never read as a complete one.
    expect(rendered).toContain('[prior visit summary truncated]');
  });

  it('stays the empty string when the client supplied no history — the declared default is unchanged', async () => {
    for (const items of [[], [item('previous_case_notes', { notes: [] })], [item('previous_case_notes', { notes: [{ text: '   ' }] })]]) {
      const { service } = buildService({ items });
      expect((await contextOf(service, session())).formatted_previous_visits).toBe('');
    }
  });
});

describe('TASK-951 D-7 — how the two kinds are read', () => {
  it('filters on `kindKey` alone, so an item of another kind is never mistaken for one of these', async () => {
    const { service } = buildService({
      items: [item('encounter', { doctor_id: 'staff-1' }), item('work_note', { text: 'noise' }), item('vitals', { heartRate: 64 })],
    });

    expect((await contextOf(service, session())).formatted_vitals).toBe('HR 64 bpm');
  });

  it('DECRYPTS the body: the plaintext column was dropped, so a read that skips it gets nothing', async () => {
    const { service, decryptContentFromEntity } = buildService({
      items: [item('vitals', null, { content: null, encryptedContent: Buffer.from('ciphertext') })],
      decrypt: async () => JSON.stringify({ heartRate: 58, temperature: 36.6 }),
    });

    const context = await contextOf(service, session());

    expect(decryptContentFromEntity).toHaveBeenCalledTimes(1);
    expect(context.formatted_vitals).toBe('HR 58 bpm · Temp 36.6 °C');
  });

  it('reads and decrypts at most ONCE per session — a flush every few seconds must not re-read', async () => {
    const { service, findLatestByKindKey } = buildService({ items: [item('vitals', { heartRate: 64 })] });
    const live = session();

    await Promise.all([contextOf(service, live), contextOf(service, live)]);
    await contextOf(service, live);

    // Two calls — one per kind — for the FIRST resolution, and nothing after it.
    expect(findLatestByKindKey).toHaveBeenCalledTimes(2);
  });

  it('degrades to the declared defaults when the read throws — a note must still be produced', async () => {
    const { service } = buildService({
      findLatestByKindKey: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });

    const context = await contextOf(service, session());

    expect(context.formatted_vitals).toBe('Not available');
    expect(context.formatted_previous_visits).toBe('');
  });

  it('degrades to the declared defaults when a body will not decrypt', async () => {
    const { service } = buildService({
      items: [item('vitals', null, { content: null, encryptedContent: Buffer.from('ciphertext') })],
      decrypt: async () => {
        throw new Error('transit key unavailable');
      },
    });

    expect((await contextOf(service, session())).formatted_vitals).toBe('Not available');
  });

  it('ignores a body that is not the JSON object the kind declares', async () => {
    const { service } = buildService({
      items: [item('vitals', null, { content: 'not json at all' }), item('previous_case_notes', null, { content: '["an array"]' })],
    });

    const context = await contextOf(service, session());

    expect(context.formatted_vitals).toBe('Not available');
    expect(context.formatted_previous_visits).toBe('');
  });

  it('changes nothing at all when no context-item repository is wired', async () => {
    const { service } = buildService();

    const context = await contextOf(service, session({ lastPayload: { vitals: { systolic: 120, diastolic: 80 } } }));

    expect(context.formatted_vitals).toContain('120/80');
    expect(context.formatted_previous_visits).toBe('');
  });

  it('keeps the expression envelope and every declared name the lane fails closed on', async () => {
    const { service } = buildService({ items: [item('vitals', FULL_VITALS)] });

    const run = await (service as unknown as { realtimeRunContext(s: SessionShape): Promise<Record<string, unknown>> }).realtimeRunContext(session());

    expect(Object.keys(run).sort()).toEqual(['nodes', 'trigger', 'vars']);
    const context = (run as { trigger: { context: Record<string, unknown> } }).trigger.context;
    for (const name of [
      'visit_type',
      'current_department',
      'language',
      'safe_age',
      'safe_dob',
      'safe_gender',
      'chief_complaint',
      'formatted_vitals',
      'formatted_previous_visits',
    ]) {
      expect(context, `trigger.context.${name} is missing — the summary node degrades on it`).toHaveProperty(name);
      expect(typeof context[name]).toBe('string');
    }
  });
});

describe('TASK-951 D-3 — the RECORDED visit type wins at both of this file’s call sites', () => {
  const consultationRow = (over: Record<string, unknown> = {}) => ({
    id: CID,
    tenantId: TENANT,
    doctorId: 'doctor-1',
    departmentId: 'dept-1',
    parentConsultationId: null,
    status: 'OPEN',
    metadata: {},
    ...over,
  });

  /** `ensureSubstrateResolved` freezes the session's visit type off the consultation row. */
  const freezeSession = async (service: LiveDocumentationService, live: SessionShape) => {
    await (service as unknown as { ensureSubstrateResolved(s: SessionShape): Promise<boolean> }).ensureSubstrateResolved(live);
    return live.visitType;
  };

  /** `handoffClinicalContext` derives the same fact for the durable lane's `n_visit`. */
  const handoffVisitType = async (service: LiveDocumentationService, row: Record<string, unknown>) => {
    const context = await (service as unknown as { handoffClinicalContext(c: unknown): Promise<Record<string, unknown>> }).handoffClinicalContext(
      row,
    );
    return context.visit_type;
  };

  it('session freeze: a recorded `revisit` wins even with no parent consultation', async () => {
    readRecordedVisitType.mockReturnValue('revisit');
    const { service } = buildService({ consultation: consultationRow({ parentConsultationId: null }) });

    const live = session({ visitType: undefined });
    expect(await freezeSession(service, live)).toBe('revisit');
  });

  it('session freeze: a recorded `new-visit` wins even when the consultation HAS a parent', async () => {
    readRecordedVisitType.mockReturnValue('new-visit');
    const { service } = buildService({ consultation: consultationRow({ parentConsultationId: 'consultation-parent' }) });

    const live = session({ visitType: undefined });
    // A first visit at this department for a patient with a prior encounter elsewhere is still a
    // new visit — the caller knows something the parent link does not.
    expect(await freezeSession(service, live)).toBe('new-visit');
  });

  it('session freeze: nothing recorded ⇒ the parent link decides, exactly as before', async () => {
    readRecordedVisitType.mockReturnValue(null);
    const { service } = buildService({ consultation: consultationRow({ parentConsultationId: 'consultation-parent' }) });

    const live = session({ visitType: undefined });
    expect(await freezeSession(service, live)).toBe('revisit');
  });

  it('handoff: a recorded `revisit` wins with no parent', async () => {
    readRecordedVisitType.mockReturnValue('revisit');
    const { service } = buildService();

    expect(await handoffVisitType(service, consultationRow({ parentConsultationId: null }))).toBe('revisit');
  });

  it('handoff: a recorded `new-visit` wins with a parent', async () => {
    readRecordedVisitType.mockReturnValue('new-visit');
    const { service } = buildService();

    expect(await handoffVisitType(service, consultationRow({ parentConsultationId: 'consultation-parent' }))).toBe('new-visit');
  });

  it('handoff: nothing recorded ⇒ the parent link decides, exactly as before', async () => {
    readRecordedVisitType.mockReturnValue(null);
    const { service } = buildService();

    expect(await handoffVisitType(service, consultationRow({ parentConsultationId: null }))).toBe('new-visit');
    expect(await handoffVisitType(service, consultationRow({ parentConsultationId: 'consultation-parent' }))).toBe('revisit');
  });

  it('the two lanes read the SAME two inputs, so they cannot disagree about the visit', async () => {
    readRecordedVisitType.mockReturnValue('revisit');
    const row = consultationRow({ parentConsultationId: null });
    const { service } = buildService({ consultation: row });

    const live = session({ visitType: undefined });
    await freezeSession(service, live);

    expect(live.visitType).toBe(await handoffVisitType(service, row));
  });
});
