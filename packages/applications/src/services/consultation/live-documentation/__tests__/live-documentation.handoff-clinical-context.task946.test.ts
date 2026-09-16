/**
 * TASK-946 OD-3 (live half) — the handoff carries the CLINICAL context, not only the DNA half.
 *
 * ## The defect
 *
 * The seeded `n_visit` condition compares `trigger.context.visit_type`, and the durable
 * interpreter builds its `trigger.context` from the live handoff's `context`. That context
 * carried `dna_style_text` / `dna_style_id` / `dna_redaction_rules` and NOTHING else — and `{}`
 * outright whenever DNA did not apply — so `n_visit` evaluated against an absent variable and
 * took `else` in all eleven published ArcaAI graphs. Every durable finalization ran the
 * new-visit branch, whatever the visit was.
 *
 * ## What this pins
 *
 *  1. the three keys Lane H reads (`visit_type`, `current_department`, `language`) are ALWAYS
 *     present once the consultation row is readable — DNA present or absent;
 *  2. `visit_type` is spelled with the SCHEMA ENUM the seeded CEL compares (`new-visit` /
 *     `revisit`), never a label and never a third spelling;
 *  3. the DNA half is layered on top EXACTLY as before — absent keys stay absent;
 *  4. PARITY with the realtime lane: every key `realtimeRunContext(session).trigger.context`
 *     publishes is also published on the handoff, minus the two prompt-only extras named below.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';

const TENANT = 'tenant-946-handoff';
const CID = 'consultation-946-handoff';
const DOCTOR = 'doctor-946';

/**
 * The one key `realtimeRunContext` publishes that the handoff deliberately does NOT.
 *
 * `chief_complaint` is the empty-string placeholder the workflow's own trigger-context schema
 * declares a default for — publishing `''` from here would claim the live lane knows the
 * complaint and it does not. It remains the durable trigger context's own business.
 *
 * `formatted_vitals` used to be on this list, on the grounds that it was SESSION state (this
 * recording's NLP-extracted readings) and the handoff is read after `stop()`, when the session is
 * gone — so any value would be stale or invented. That reasoning belonged to that SOURCE. The
 * handoff now publishes the vitals object the clinic MEASURED and the client sent at `open`,
 * which is a context-item row and is readable for exactly as long as the consultation is; with no
 * such row it publishes the same declared absence value the builder gives `safe_vitals`.
 */
const PROMPT_ONLY_EXTRAS = ['chief_complaint'];

interface Wiring {
  isFollowUp?: boolean;
  language?: string | null;
  departmentName?: string | null;
  /** `null` ⇒ the DNA repository is not wired at all, so no DNA keys can be produced. */
  dna?: null | { styleText: string | null };
}

function buildService(wiring: Wiring = {}) {
  const stored = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      stored.set(key, value);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };

  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  args[7] = { decrypt: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({
      id: CID,
      tenantId: TENANT,
      doctorId: DOCTOR,
      departmentId: wiring.departmentName === null ? null : 'dept-1',
      parentConsultationId: wiring.isFollowUp ? 'consultation-946-parent' : null,
      status: 'DRAINING',
      metadata: wiring.language === undefined ? null : { summaryLanguage: wiring.language },
    })),
  };
  args[26] =
    wiring.dna === null
      ? undefined
      : {
          findLatestForDoctor: vi.fn(async () => ({ id: 'dna-report-1', styleText: wiring.dna?.styleText ?? 'Terse.' })),
          decryptFieldsFromEntity: vi.fn(async (entity: { styleText: string | null }) => ({
            styleText: entity.styleText,
            redactionRules: null,
          })),
        };
  args[27] = {
    resolveEffectiveDnaStyleEnabled: vi.fn(async () => ({ effective: wiring.dna !== null })),
    resolveEffectiveDnaRedactionEnabled: vi.fn(async () => ({ effective: false })),
  };
  args[28] = { findById: vi.fn(async () => ({ id: 'dept-1', name: wiring.departmentName ?? 'Breast Oncology' })) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, stored };
}

/** A handoff record already written, so `readLiveHandoff` answers `ended: true`. */
function seedHandoff(stored: Map<string, string>): void {
  stored.set(`live-doc:handoff:${CID}`, JSON.stringify({ endedAt: '2026-09-10T10:00:00.000Z', tenantId: TENANT, outputs: {} }));
}

describe('TASK-946 OD-3 — the live handoff carries the clinical context', () => {
  it('publishes visit_type / current_department / language beside the DNA half', async () => {
    const { service, stored } = buildService({ isFollowUp: true, language: 'ml' });
    seedHandoff(stored);

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toMatchObject({
      visit_type: 'revisit',
      current_department: 'Breast Oncology',
      language: 'ml',
      dna_style_text: 'Terse.',
      dna_style_id: 'dna-report-1',
    });
  });

  it('publishes them even when DNA does not apply at all — the old `{}` early return', async () => {
    const { service, stored } = buildService({ isFollowUp: false, dna: null });
    seedHandoff(stored);

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toMatchObject({ visit_type: 'new-visit', current_department: 'Breast Oncology' });
    expect(answer.context).not.toHaveProperty('dna_style_text');
    expect(answer.context).not.toHaveProperty('dna_style_id');
  });

  it('spells visit_type with the SCHEMA ENUM the seeded CEL compares', async () => {
    for (const [isFollowUp, expected] of [
      [false, 'new-visit'],
      [true, 'revisit'],
    ] as const) {
      const { service, stored } = buildService({ isFollowUp });
      seedHandoff(stored);
      const answer = await service.readLiveHandoff(CID);
      expect(answer.context.visit_type).toBe(expected);
    }
  });

  it('falls back to the builder`s declared defaults rather than inventing values', async () => {
    // No department on the row, no declared language: `current_department` takes
    // `buildPreSummaryVariables`' documented `General`, and `language` is the empty string
    // (undeclared is NOT English — the department body decides).
    const { service, stored } = buildService({ departmentName: null });
    seedHandoff(stored);

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toMatchObject({ current_department: 'General', language: '' });
  });

  it('still answers `{}` when the consultation row cannot be read at all', async () => {
    const { service, stored } = buildService();
    seedHandoff(stored);
    // No consultation repository ⇒ nothing is known about this consultation, and inventing a
    // visit type for an unknown row would be worse than the interpreter's own `else`.
    (service as unknown as { consultationRepository?: unknown }).consultationRepository = undefined;

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({});
  });
});

describe('TASK-946 OD-3 — parity with the realtime lane`s trigger context', () => {
  it('the handoff context carries every key the realtime run context publishes, minus the prompt-only extras', async () => {
    const { service, stored } = buildService({ isFollowUp: true, language: 'ml' });
    seedHandoff(stored);

    // The SAME session shape `realtimeRunContext` reads: the three values are frozen off the
    // consultation row by `ensureSubstrateResolved`, which is the row the handoff reads too.
    const session = { consultationId: CID, tenantId: TENANT, visitType: 'revisit', summaryLanguage: 'ml', departmentId: 'dept-1' };
    const runContext = await (
      service as unknown as { realtimeRunContext(s: unknown): Promise<{ trigger: { context: Record<string, unknown> } }> }
    ).realtimeRunContext(session);

    const handoff = await service.readLiveHandoff(CID);
    const missing = Object.keys(runContext.trigger.context)
      .filter((key) => !PROMPT_ONLY_EXTRAS.includes(key))
      .filter((key) => !(key in handoff.context));

    expect(missing, 'the durable lane would resolve these against nothing').toEqual([]);
    // …and the two extras are deliberately absent, not accidentally so.
    for (const extra of PROMPT_ONLY_EXTRAS) expect(handoff.context).not.toHaveProperty(extra);
  });
});
