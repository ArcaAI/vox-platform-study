/**
 * The client's measured vitals and prior-visit history reach the DURABLE handoff and the LIVE
 * prompt, not only the realtime trigger context.
 *
 * ## Two surfaces that were reading nothing
 *
 * 1. **The handoff.** `handoffClinicalContext` builds the durable lane's `trigger.context` from
 *    the consultation ROW after `stop()` has torn the session down, and it published the visit
 *    type, department and language — but nothing clinical, because the only reader of the client
 *    kinds lived on the session. So a durable finalize ran with `formatted_previous_visits = ''`
 *    for a consultation whose client had sent two prior notes. `formatted_vitals` was excluded on
 *    the grounds that it was SESSION state (this recording's NLP-extracted readings) and would be
 *    stale or invented after the session; that reasoning does not hold for a MEASURED object
 *    persisted as a context item at `open`, which is readable for as long as the consultation is.
 *
 * 2. **The live prompt.** The department templates name `Recent Vitals` and
 *    `PREVIOUS CASE NOTES SUMMARY` as input tiers in their source-of-truth protocol (T3 and T4),
 *    and the prompt never carried either block, so both tiers described material that was not
 *    there. The blocks are APPENDED by assembly rather than written into the templates, so no
 *    seeded body is regenerated and a tenant's own template keeps working.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-982';
const CID = 'consultation-982';

const VITALS = { bloodPressure: '128/82', heartRate: 88, temperature: 36.8 };
const NOTES = {
  notes: [
    { date: '2026-01-14', title: 'Hypertension review', text: 'PRIOR-NOTE-ALPHA: controlled on amlodipine 5 mg.' },
    { date: '2026-03-02', title: 'Lipid panel follow-up', text: 'PRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.' },
  ],
};

interface Wiring {
  kinds?: Record<string, unknown>;
}

function buildService(wiring: Wiring = {}) {
  const findLatestByKindKey = vi.fn(async (_cid: string, kindKey: string) => {
    const payload = wiring.kinds?.[kindKey];
    return payload === undefined
      ? null
      : { id: `ci-${kindKey}`, kindKey, content: JSON.stringify(payload), createdAt: new Date('2026-09-16T08:00:00.000Z') };
  });

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
  args[5] = { findLatestByKindKey, decryptContentFromEntity: vi.fn(async () => null) };
  args[7] = { decrypt: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({
      id: CID,
      tenantId: TENANT,
      doctorId: 'doctor-1',
      departmentId: 'dept-1',
      parentConsultationId: null,
      status: 'DRAINING',
      metadata: null,
    })),
  };
  args[28] = { findById: vi.fn(async () => ({ id: 'dept-1', name: 'Breast & Endocrine' })) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, findLatestByKindKey };
}

/** The consultation row the durable handoff is built from — `stop()` has torn the session down. */
const CONSULTATION = {
  id: CID,
  tenantId: TENANT,
  doctorId: 'doctor-1',
  departmentId: 'dept-1',
  parentConsultationId: null,
  status: 'DRAINING',
  metadata: null,
};

/** `resolveHandoffContext` is private; the narrow cast is the convention every neighbouring test uses. */
const handoffContextOf = (service: LiveDocumentationService) =>
  (service as unknown as { resolveHandoffContext(c: unknown): Promise<Record<string, unknown>> }).resolveHandoffContext(CONSULTATION);

describe('the durable handoff carries what the client sent', () => {
  it('publishes the measured vitals as `formatted_vitals`', async () => {
    const { service } = buildService({ kinds: { vitals: VITALS } });

    const context = await handoffContextOf(service);

    expect(context.formatted_vitals).toBe('BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C');
    expect(context.safe_vitals).toBe('BP 128/82 mmHg · HR 88 bpm · Temp 36.8 °C');
  });

  it('publishes the prior-visit history as `formatted_previous_visits`', async () => {
    const { service } = buildService({ kinds: { previous_case_notes: NOTES } });

    const context = await handoffContextOf(service);

    expect(context.formatted_previous_visits).toContain('PRIOR-NOTE-ALPHA');
    expect(context.formatted_previous_visits).toContain('PRIOR-NOTE-BRAVO');
  });

  it("keeps v1's declared absence values when the client sent neither kind", async () => {
    const { service } = buildService();

    const context = await handoffContextOf(service);

    expect(context.formatted_vitals).toBe('Not available');
    expect(context.safe_vitals).toBe('Not available');
    expect(context.formatted_previous_visits).toBe('');
  });

  it('still publishes the clinical keys the durable `n_visit` condition compares', async () => {
    const { service } = buildService({ kinds: { vitals: VITALS } });

    const context = await handoffContextOf(service);

    expect(context.visit_type).toBe('new-visit');
    expect(context.current_department).toBe('Breast & Endocrine');
  });
});

describe('the live-lane prompt carries the two client data blocks', () => {
  const buildPrompt = (service: LiveDocumentationService, vitals?: string, previousVisits?: string) =>
    (
      service as unknown as {
        buildTextUserPrompt(
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
        ): string;
      }
    ).buildTextUserPrompt('', 'Patient reports chest tightness.', '', false, 'SYSTEM PREFIX', 'Consultation Note', '', '', vitals, previousVisits);

  it('appends the measured readings under the `Recent Vitals` tier the template names', async () => {
    const { service } = buildService();

    const prompt = buildPrompt(service, 'BP 128/82 mmHg · HR 88 bpm');

    expect(prompt).toContain('Recent Vitals:\nBP 128/82 mmHg · HR 88 bpm');
  });

  it('appends the history under the `PREVIOUS CASE NOTES SUMMARY` tier', async () => {
    const { service } = buildService();

    const prompt = buildPrompt(service, undefined, '2026-03-02 · Lipid panel follow-up\nPRIOR-NOTE-BRAVO: LDL 3.9 mmol/L.');

    expect(prompt).toContain('PREVIOUS CASE NOTES SUMMARY:\n2026-03-02 · Lipid panel follow-up');
  });

  it('appends neither block when the client sent nothing — the prompt is byte-identical to before', async () => {
    const { service } = buildService();

    const withClient = buildPrompt(service, undefined, undefined);
    const withoutArguments = (
      service as unknown as { buildTextUserPrompt(a: string, b: string, c: string, d: boolean, e: string, f: string, g: string, h: string): string }
    ).buildTextUserPrompt('', 'Patient reports chest tightness.', '', false, 'SYSTEM PREFIX', 'Consultation Note', '', '');

    expect(withClient).toBe(withoutArguments);
    expect(withClient).not.toContain('Recent Vitals:');
    expect(withClient).not.toContain('PREVIOUS CASE NOTES SUMMARY:');
  });

  it('keeps the stable prefix leading the prompt, so the engine cache still hits', async () => {
    const { service } = buildService();

    const prompt = buildPrompt(service, 'HR 88 bpm', 'A prior note.');

    expect(prompt.startsWith('SYSTEM PREFIX')).toBe(true);
  });
});
