/**
 * TASK-1020 — the live lane carries the same-day prequel and the client's lab results.
 *
 * Three surfaces, one source:
 *
 *  1. `realtimeRunContext` — the scope every realtime `core.agent` renders from AND every prompt
 *     fragment's `when` is evaluated against. It publishes `same_day_prequel` (boolean — the flag an
 *     `arcaai-same-day-return` fragment conditions on), `same_day_prequel_summary`, and
 *     `formatted_test_results`.
 *  2. `buildLivePromptParts` — the per-turn prompt carries a `SAME-DAY EARLIER VISIT(S)`
 *     block (and a `TEST RESULTS:` block) exactly the way `PREVIOUS CASE NOTES SUMMARY:` is appended.
 *  3. the live HANDOFF — what the durable interpreter builds its `trigger.context` from, so a
 *     fragment condition reads the same flag on the durable finalize.
 *
 * The carry context is resolved ONCE per session, at start, off the SAME consultation row read
 * `ensureSubstrateResolved` already makes — the substrate read stays one `findById` per session.
 */
import { describe, expect, it, vi } from 'vitest';
import { ContextItemType } from '@arcaai/domains';
import { renderTemplate } from '@arcaai/workflow-contract';

import { LiveDocumentationService } from '../live-documentation.service';
import { dataBlock, liveUserOf, type LiveParts } from './live-compose-expectations';

const TENANT = 'tenant-1020';
const CID = 'consultation-afternoon';
const PARENT = 'consultation-morning';
const PATIENT = 'patient-1020';
const DAY = new Date('2026-09-29T00:00:00.000Z');

interface Wiring {
  /** The consultation row. */
  row?: Record<string, unknown> | null;
  /** The parent row (`null` ⇒ the parent read throws, as a deleted row does). */
  parent?: Record<string, unknown> | null;
  parentNotes?: Partial<Record<ContextItemType, Array<{ content: string; createdAt: Date }>>>;
  investigations?: unknown;
  /** The tenant's `consultation.appointmentDay.timeZone`, served by a stub EffectiveSettingsService. */
  timeZone?: string;
}

function buildService(wiring: Wiring = {}) {
  const row =
    wiring.row === null
      ? null
      : {
          id: CID,
          tenantId: TENANT,
          patientId: PATIENT,
          appointmentDate: DAY,
          doctorId: 'doctor-1',
          departmentId: 'dept-1',
          parentConsultationId: PARENT,
          status: 'RECORDING',
          metadata: null,
          createdAt: new Date('2026-09-29T09:30:00.000Z'),
          ...wiring.row,
        };
  const parent =
    wiring.parent === null
      ? null
      : {
          id: PARENT,
          tenantId: TENANT,
          patientId: PATIENT,
          appointmentDate: DAY,
          parentConsultationId: null,
          status: 'SIGNED',
          createdAt: new Date('2026-09-29T04:15:00.000Z'),
          ...wiring.parent,
        };

  const consultationRepository = {
    findById: vi.fn(async (id: string) => {
      if (id === CID && row) return row;
      if (id === PARENT && parent) return parent;
      throw new Error('DataNotFound');
    }),
  };
  const contextItemRepository = {
    findByType: vi.fn(async (consultationId: string, type: ContextItemType) => (consultationId === PARENT ? (wiring.parentNotes?.[type] ?? []) : [])),
    findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) =>
      kindKey === 'investigations' && wiring.investigations !== undefined
        ? { id: 'ci-inv', kindKey, content: JSON.stringify(wiring.investigations), createdAt: new Date() }
        : null,
    ),
    decryptContentFromEntity: vi.fn(),
  };

  const stored = new Map<string, string>();
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    set: vi.fn(),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(async () => []),
    expire: vi.fn(),
  };
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[5] = contextItemRepository;
  if (wiring.timeZone !== undefined) {
    args[9] = {
      resolveEffective: vi.fn(async (key: string) => ({ value: key === 'consultation.appointmentDay.timeZone' ? wiring.timeZone : undefined })),
    };
  }
  args[15] = consultationRepository;
  args[28] = { findById: vi.fn(async () => ({ id: 'dept-1', name: 'Haematology' })) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, consultationRepository, contextItemRepository, stored };
}

type Internals = {
  ensureSubstrateResolved(session: Record<string, unknown>): Promise<boolean>;
  realtimeRunContext(session: Record<string, unknown>): Promise<{ trigger: { context: Record<string, unknown> } }>;
  buildLivePromptParts(
    priorNote: string,
    delta: string,
    notes: string,
    elided?: boolean,
    stablePrefix?: string,
    documentTitle?: string,
    operatingFrame?: string,
    turnContract?: string,
    clientVitals?: string,
    clientPreviousVisits?: string,
    carry?: { sameDayPrequel?: string; testResults?: string },
  ): LiveParts;
};

const internals = (service: LiveDocumentationService) => service as unknown as Internals;

/** A session driven through the SAME start-path read production uses. */
async function startedContext(service: LiveDocumentationService) {
  const session: Record<string, unknown> = { consultationId: CID, tenantId: TENANT };
  await internals(service).ensureSubstrateResolved(session);
  return (await internals(service).realtimeRunContext(session)).trigger.context;
}

const MORNING = { [ContextItemType.SIGNED_NOTE]: [{ content: 'MORNING-SIGNED plan: CBC, LFT', createdAt: new Date() }] };
const PREQUEL = '### Earlier visit today (04:15 UTC, status SIGNED)\nMORNING-SIGNED plan: CBC, LFT';

describe('TASK-1020 — realtimeRunContext exposes the prequel to agents and fragment conditions', () => {
  it('publishes trigger.context.same_day_prequel = true with the rendered summary when a same-day ancestor exists', async () => {
    const { service } = buildService({ parentNotes: MORNING });

    const context = await startedContext(service);

    expect(context.same_day_prequel).toBe(true);
    expect(context.same_day_prequel_summary).toBe(PREQUEL);
  });

  it('states the earlier visit`s time in the TENANT`s day zone (live-replay D3: an IST clinic read UTC)', async () => {
    const { service } = buildService({ parentNotes: MORNING, timeZone: 'Asia/Kolkata' });

    const context = await startedContext(service);

    expect(context.same_day_prequel_summary).toBe('### Earlier visit today (09:45 IST, status SIGNED)\nMORNING-SIGNED plan: CBC, LFT');
  });

  it('publishes same_day_prequel = false (a boolean, never absent) for a first visit', async () => {
    const { service } = buildService({ row: { parentConsultationId: null } });

    const context = await startedContext(service);

    expect(context.same_day_prequel).toBe(false);
    expect(context.same_day_prequel_summary).toBe('');
  });

  it('publishes false for a parent from another day', async () => {
    const { service } = buildService({ parent: { appointmentDate: new Date('2026-09-01T00:00:00.000Z') }, parentNotes: MORNING });

    const context = await startedContext(service);

    expect(context.same_day_prequel).toBe(false);
  });

  it('publishes false on a session that never went through start (nothing resolved, nothing invented)', async () => {
    const { service } = buildService({ parentNotes: MORNING });

    const run = await internals(service).realtimeRunContext({ consultationId: CID, tenantId: TENANT });

    expect(run.trigger.context.same_day_prequel).toBe(false);
    expect(run.trigger.context.same_day_prequel_summary).toBe('');
  });

  it('publishes formatted_test_results from the investigations kind', async () => {
    const { service } = buildService({
      row: { parentConsultationId: null },
      investigations: { results: [{ name: 'Hb', value: '10.2', unit: 'g/dL' }] },
    });

    const context = await startedContext(service);

    expect(context.formatted_test_results).toBe('- Hb: 10.2 g/dL');
  });

  it('keeps the substrate read at ONE findById for the session row — the carry rides that read', async () => {
    const { service, consultationRepository } = buildService({ row: { parentConsultationId: null } });

    const session: Record<string, unknown> = { consultationId: CID, tenantId: TENANT };
    await internals(service).ensureSubstrateResolved(session);
    await internals(service).realtimeRunContext(session);
    await internals(service).realtimeRunContext(session);

    expect(consultationRepository.findById).toHaveBeenCalledTimes(1);
  });
});

describe('TASK-1020 — the per-turn prompt appends the prequel the way it appends prior case notes', () => {
  const prompt = (service: LiveDocumentationService, carry?: { sameDayPrequel?: string; testResults?: string }) =>
    liveUserOf(internals(service).buildLivePromptParts(
      '',
      'Patient back with results.',
      '',
      false,
      'SYSTEM PREFIX',
      'Consultation Note',
      '',
      '',
      undefined,
      'PRIOR',
      carry,
    ));

  it('appends the `SAME-DAY EARLIER VISIT(S)` data section after the prior case notes', async () => {
    const { service } = buildService();

    const text = prompt(service, { sameDayPrequel: PREQUEL });

    expect(text).toContain(dataBlock('same_day_prequel_summary', 'SAME-DAY EARLIER VISIT(S)', PREQUEL));
    expect(text.indexOf('--- PREVIOUS CASE NOTES SUMMARY ---')).toBeLessThan(text.indexOf('--- SAME-DAY EARLIER VISIT(S) ---'));
  });

  it('appends the `TEST RESULTS` data section when the client sent investigations', async () => {
    const { service } = buildService();

    expect(prompt(service, { testResults: '- Hb: 10.2 g/dL' })).toContain(dataBlock('test_results', 'TEST RESULTS', '- Hb: 10.2 g/dL'));
  });

  it('is byte-identical to the pre-ticket prompt when there is no prequel and no results', async () => {
    const { service } = buildService();

    const before = liveUserOf(
      internals(service).buildLivePromptParts(
      '',
      'Patient back with results.',
      '',
      false,
      'SYSTEM PREFIX',
      'Consultation Note',
      '',
      '',
      undefined,
      'PRIOR',
      ),
    );

    expect(prompt(service, { sameDayPrequel: '', testResults: '  ' })).toBe(before);
    expect(prompt(service)).toBe(before);
  });
});

describe('TASK-1020 — the live handoff carries the flag to the durable finalize', () => {
  // The durable run reads the handoff AFTER the stop (DRAINING). A handoff read while the row is
  // still RECORDING answers "not yet" since TASK-1022 L-RESUME, so the row is drained here.
  const buildDrained = (wiring: Parameters<typeof buildService>[0] = {}) =>
    buildService({ ...wiring, row: { status: 'DRAINING', ...(wiring.row ?? {}) } });
  const handoffContext = async (service: LiveDocumentationService, stored: Map<string, string>) => {
    stored.set(`live-doc:handoff:${CID}`, JSON.stringify({ endedAt: '2026-09-29T10:00:00.000Z', tenantId: TENANT, outputs: {} }));
    return (await service.readLiveHandoff(CID)).context as Record<string, unknown>;
  };

  it('publishes same_day_prequel = true and the summary for a same-day return', async () => {
    const { service, stored } = buildDrained({ parentNotes: MORNING });

    const context = await handoffContext(service, stored);

    expect(context.same_day_prequel).toBe(true);
    expect(context.same_day_prequel_summary).toBe(PREQUEL);
    expect(context.visit_type).toBe('revisit');
  });

  it('publishes same_day_prequel = false for a follow-up whose parent is from another day', async () => {
    const { service, stored } = buildDrained({ parent: { appointmentDate: new Date('2026-08-01T00:00:00.000Z') }, parentNotes: MORNING });

    const context = await handoffContext(service, stored);

    expect(context.same_day_prequel).toBe(false);
    expect(context.same_day_prequel_summary).toBe('');
  });

  it('omits both keys for a FIRST visit (no chain at all) — a fragment `when` over them then excludes, as false would', async () => {
    const { service, stored, consultationRepository } = buildDrained({ row: { parentConsultationId: null } });

    const context = await handoffContext(service, stored);

    expect(context).not.toHaveProperty('same_day_prequel');
    expect(context).not.toHaveProperty('same_day_prequel_summary');
    expect(consultationRepository.findById).toHaveBeenCalledTimes(1);
  });

  it('publishes formatted_test_results from the investigations kind', async () => {
    const { service, stored } = buildDrained({ row: { parentConsultationId: null }, investigations: { results: [{ name: 'Hb', value: '9.8' }] } });

    const context = await handoffContext(service, stored);

    expect(context.formatted_test_results).toBe('- Hb: 9.8');
  });

  /**
   * Live-replay defect D2 — the durable `casenote-finalization` must see all THREE keys for a
   * same-day return, together, under `trigger.context.*`: the handoff context is what the durable
   * interpreter overlays onto its run context (`workflow.py#_publish_context`:
   * `{ ...trigger, ...live, context: { ...authored, ...live } }`), and the `same_day_return`
   * fragment reads exactly those three paths.
   */
  it('a same-day return with investigations carries the flag, the prequel AND the results, and they resolve under trigger.context', async () => {
    const { service, stored } = buildDrained({
      parentNotes: MORNING,
      investigations: { results: [{ name: 'Troponin', value: '0.01', unit: 'ng/mL' }] },
    });

    const context = await handoffContext(service, stored);

    expect(context).toMatchObject({ same_day_prequel: true, same_day_prequel_summary: PREQUEL, formatted_test_results: '- Troponin: 0.01 ng/mL' });
    const trigger = { ...context, context: { ...context } };
    const rendered = renderTemplate(
      '{{trigger.context.same_day_prequel}}|{{trigger.context.same_day_prequel_summary | default("")}}|{{trigger.context.formatted_test_results | default("")}}',
      { trigger, context: trigger },
    );
    expect(rendered).toBe(`true|${PREQUEL}|- Troponin: 0.01 ng/mL`);
  });
});
