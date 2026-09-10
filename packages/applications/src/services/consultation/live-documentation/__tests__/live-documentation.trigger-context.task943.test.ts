/**
 * TASK-943 — the realtime lane supplies its agent's DECLARED trigger context.
 *
 * ## The defect this pins
 *
 * `realtimeRunContext` supplied exactly one variable, `visit_type`. The seeded
 * `general-medicine-summarization` agent binds NINE names to `trigger.context.*`, and `core.agent`
 * fails CLOSED on the first it cannot resolve — correctly, because a clinical prompt carrying a
 * literal `{{safe_age}}` is worse than no note. So the realtime case note never generated at all:
 * measured on a real 120 s recording, 8 flush generations produced 8 degrades and 0 sections.
 *
 * ## What these tests assert, and what they deliberately do not
 *
 * That every declared name is PRESENT, and that an absent value takes the default the workflow's own
 * trigger-context schema declares for it (`Unknown` / `Not available` / empty) rather than a newly
 * invented one. They do NOT assert clinical richness: six of the nine have no source in the v2 data
 * model at all ("`patientId` is an external reference with no local demographic store"), and
 * inventing values for them would be a worse bug than the one being fixed.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

/** The nine names `generalMedicinePromptVariables()` binds to `trigger.context.*`. */
const DECLARED = [
  'visit_type',
  'current_department',
  'language',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'chief_complaint',
  'formatted_vitals',
  'formatted_previous_visits',
] as const;

type SessionShape = {
  consultationId: string;
  tenantId: string;
  visitType?: string;
  summaryLanguage?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  lastPayload?: { vitals?: Record<string, unknown> };
};

/**
 * The service with only what this method touches. `realtimeRunContext` is private and reached by a
 * narrow cast, the convention the neighbouring tests already use (`live-handoff.task932`,
 * `agent-freeze`) — the alternative is driving a whole flush to observe one pure projection.
 */
function buildService(departmentName?: string) {
  const findById = vi.fn(async () => (departmentName ? ({ name: departmentName } as never) : null));
  const service = new LiveDocumentationService(
    { axiosRef: { post: vi.fn() }, post: vi.fn() } as never,
    { get: vi.fn() } as never,
    { get: vi.fn(), setex: vi.fn(), publish: vi.fn(), del: vi.fn(), eval: vi.fn(), sadd: vi.fn(), srem: vi.fn(), smembers: vi.fn(), expire: vi.fn() } as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
  );
  (service as unknown as { departmentRepository?: { findById: typeof findById } }).departmentRepository = { findById };
  return { service, findById };
}

const contextOf = async (service: LiveDocumentationService, session: SessionShape) => {
  const run = await (
    service as unknown as { realtimeRunContext(s: SessionShape): Promise<{ trigger: { context: Record<string, unknown> } }> }
  ).realtimeRunContext(session);
  return run.trigger.context;
};

const session = (over: Partial<SessionShape> = {}): SessionShape => ({
  consultationId: 'consultation-943',
  tenantId: 'tenant-943',
  visitType: 'New visit',
  summaryLanguage: 'en',
  departmentId: 'dept-1',
  ...over,
});

describe('TASK-943 — realtimeRunContext supplies every declared trigger variable', () => {
  it('THE DEFECT: all nine names are present, so `core.agent` has nothing left to fail closed on', async () => {
    const { service } = buildService('General Medicine');

    const context = await contextOf(service, session());

    for (const name of DECLARED) {
      expect(context, `trigger.context.${name} is missing — the summary node degrades on it`).toHaveProperty(name);
      expect(typeof context[name], `trigger.context.${name} must be a string for the prompt renderer`).toBe('string');
    }
  });

  it('carries the values the session already froze off the consultation row', async () => {
    const { service } = buildService('General Medicine');

    const context = await contextOf(service, session({ visitType: 'Revisit', summaryLanguage: 'ml' }));

    expect(context.visit_type).toBe('Revisit');
    expect(context.current_department).toBe('General Medicine');
    expect(context.language).toBe('ml');
  });

  it('uses the DECLARED defaults for the fields v2 has no store for — never an invented one', async () => {
    const { service } = buildService('General Medicine');

    const context = await contextOf(service, session());

    // `29-arcaai-agents-and-workflows.generated.ts` declares each of these absence values.
    expect(context.safe_age).toBe('Unknown');
    expect(context.safe_dob).toBe('Unknown');
    expect(context.safe_gender).toBe('Unknown');
    expect(context.chief_complaint).toBe('');
    expect(context.formatted_previous_visits).toBe('');
    expect(context.formatted_vitals).toBe('Not available');
  });

  it('falls back to the builder default when the department cannot be resolved', async () => {
    const { service } = buildService(undefined); // repository returns null

    const context = await contextOf(service, session());

    expect(context.current_department).toBe('General');
  });

  it('reads the department at most ONCE per session, and caches the name on it', async () => {
    const { service, findById } = buildService('Cardiology');
    const live = session();

    await contextOf(service, live);
    await contextOf(service, live);
    await contextOf(service, live);

    expect(findById).toHaveBeenCalledTimes(1);
    expect(live.departmentName).toBe('Cardiology');
  });

  it('does not read a department at all when the consultation has none', async () => {
    const { service, findById } = buildService('Cardiology');

    const context = await contextOf(service, session({ departmentId: null }));

    expect(findById).not.toHaveBeenCalled();
    expect(context.current_department).toBe('General');
  });

  it('D-2 — reports the session’s OWN vitals when it has them, rather than claiming `Not available`', async () => {
    const { service } = buildService('General Medicine');

    const context = await contextOf(
      service,
      session({ lastPayload: { vitals: { systolic: 128, diastolic: 82, heartRate: 76, spo2: 97, temperatureC: 37.4 } } }),
    );

    // Telling the model "Not available" while the session HOLDS vitals is a falsehood, not a default.
    expect(context.formatted_vitals).toContain('128/82');
    expect(context.formatted_vitals).toContain('76');
    expect(context.formatted_vitals).not.toBe('Not available');
  });

  it('ignores a vitals object with no readings rather than emitting an empty list', async () => {
    const { service } = buildService('General Medicine');

    const context = await contextOf(service, session({ lastPayload: { vitals: {} } }));

    expect(context.formatted_vitals).toBe('Not available');
  });

  it('never throws when the department read fails — a note must still be produced', async () => {
    const { service } = buildService('General Medicine');
    (service as unknown as { departmentRepository: { findById: ReturnType<typeof vi.fn> } }).departmentRepository.findById = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const context = await contextOf(service, session());

    expect(context.current_department).toBe('General');
  });

  it('keeps the expression envelope the lane expects', async () => {
    const { service } = buildService('General Medicine');

    const run = await (
      service as unknown as { realtimeRunContext(s: SessionShape): Promise<Record<string, unknown>> }
    ).realtimeRunContext(session());

    expect(run).toHaveProperty('trigger');
    expect(run).toHaveProperty('vars');
    expect(run).toHaveProperty('nodes');
  });
});
