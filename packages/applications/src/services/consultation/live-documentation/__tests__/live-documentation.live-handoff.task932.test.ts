/**
 * TASK-932 R-16a — the LIVE HANDOFF: what `stop()` hands the durable interpreter, and what the
 * interpreter reads back.
 *
 * ## The defect
 *
 * A consultation-bound interpreter run SKIPS every `realtime` node so exactly one runtime
 * executes it (`_has_live_owner`, `apps/harness/.../interpreter/workflow.py`). A skipped node
 * stores no output, so the durable consumer of one — `n_finalize`, the seeded
 * `casenote-finalization` agent — resolved `bound_inputs: {}` and degraded
 * "core.agent: nothing bound on `in`/`context` to generate from" on every consultation.
 * Measured on the dev stack 2026-09-09: 29 consultations in `DRAINING`, none with a
 * `RAW_SUMMARY` or a `SummaryMeta`.
 *
 * ## What this suite pins
 *
 *  1. every flush's successful node outputs ACCUMULATE on the session, per node, last-write-wins
 *     — a flush in which one node degraded must not erase what it produced earlier;
 *  2. `stop()` writes the handoff BEFORE tearing the session down, and writes one even when the
 *     lane produced nothing (empty and "not yet" are different states the interpreter waits on);
 *  3. the read answers `ended: false` while the consultation can still record, and `ended: true`
 *     with an honest empty once it cannot — so a run neither finalizes at OPEN nor parks forever;
 *  4. the answer is FILTERED to the node ids the caller asked about;
 *  5. `context` carries the clinician's EFFECTIVE DNA writing style, gated by the tenant AND
 *     doctor toggle, and is absent — never a placeholder — when the gate is off.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import type { RealtimeRunResult } from '../realtime/realtime-executor';

const TENANT = 'tenant-handoff';
const CID = 'consultation-handoff-001';
const DOCTOR = 'doctor-handoff-1';

type Wiring = {
  status?: string;
  /** `null` ⇒ the repository is not wired at all. */
  report?: { id: string; styleText: string | null; redactionRules?: unknown } | null;
  dnaEffective?: boolean;
  /** `null` ⇒ the resolver is not wired (legacy composition). */
  configResolver?: null;
  /** What a previous `stop()` left in Redis, if anything. */
  stored?: unknown;
  setexThrows?: boolean;
};

function buildService(wiring: Wiring = {}) {
  const stored = new Map<string, string>();
  if (wiring.stored !== undefined) stored.set(`live-doc:handoff:${CID}`, JSON.stringify(wiring.stored));

  const cache = {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      if (wiring.setexThrows) throw new Error('redis down');
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

  const dnaReportRepository =
    wiring.report === null
      ? undefined
      : {
          findLatestForDoctor: vi.fn(async () => wiring.report ?? { id: 'dna-report-1', styleText: 'Terse. Abbreviates freely.' }),
          // ONE decrypt, both fields — the same call the legacy harness path makes.
          decryptFieldsFromEntity: vi.fn(async (entity: { styleText: string | null; redactionRules?: unknown }) => ({
            styleText: entity.styleText,
            redactionRules: entity.redactionRules ?? null,
          })),
        };

  const args: unknown[] = new Array(28).fill(undefined);
  args[0] = { axiosRef: { post: vi.fn() }, post: vi.fn() };
  args[1] = { get: vi.fn(() => undefined) };
  args[2] = cache;
  args[3] = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  // A wired secrets backend: the report's ciphertext is only decrypted when one exists.
  args[7] = { decrypt: vi.fn() };
  args[15] = {
    findById: vi.fn(async () => ({
      id: CID,
      tenantId: TENANT,
      doctorId: DOCTOR,
      departmentId: 'dept-1',
      status: wiring.status ?? 'RECORDING',
      metadata: null,
    })),
  };
  args[26] = dnaReportRepository;
  args[27] =
    wiring.configResolver === null ? undefined : { resolveEffectiveDnaStyleEnabled: vi.fn(async () => ({ effective: wiring.dnaEffective ?? true })) };

  const service = new (LiveDocumentationService as unknown as new (...a: unknown[]) => LiveDocumentationService)(...args);
  return { service, cache, stored, dnaReportRepository };
}

type SessionShape = { consultationId: string; tenantId: string; liveNodeOutputs?: Record<string, Record<string, unknown>> };

/** Reach the private session map the way the sibling suites do. */
function sessions(service: LiveDocumentationService): Map<string, SessionShape> {
  return (service as unknown as { sessions: Map<string, SessionShape> }).sessions;
}

function seedSession(service: LiveDocumentationService, liveNodeOutputs?: Record<string, Record<string, unknown>>): SessionShape {
  const session: SessionShape = { consultationId: CID, tenantId: TENANT, ...(liveNodeOutputs ? { liveNodeOutputs } : {}) };
  sessions(service).set(CID, session as never);
  return session;
}

function runResult(outputs: Record<string, Record<string, unknown>>): RealtimeRunResult {
  return { outcomes: [], outputs: new Map(Object.entries(outputs)), events: [], failed: false };
}

function capture(service: LiveDocumentationService, session: SessionShape, outputs: Record<string, Record<string, unknown>>): void {
  (service as unknown as { captureLiveNodeOutputs(s: SessionShape, r: RealtimeRunResult): void }).captureLiveNodeOutputs(session, runResult(outputs));
}

async function persist(service: LiveDocumentationService, session: SessionShape): Promise<void> {
  await (service as unknown as { persistLiveHandoff(s: SessionShape): Promise<void> }).persistLiveHandoff(session);
}

describe('TASK-932 R-16a — accumulating the live lane’s outputs', () => {
  it('keeps the LAST successful output per node across flushes', () => {
    const { service } = buildService();
    const session = seedSession(service);

    capture(service, session, { n_summary: { text: 'S: cough' }, n_ner: { entities: [{ text: 'cough' }] } });
    capture(service, session, { n_summary: { text: 'S: cough x3d\nA: URTI' } });

    expect(session.liveNodeOutputs).toEqual({
      n_summary: { text: 'S: cough x3d\nA: URTI' },
      // The flush in which NER contributed nothing did NOT erase what it produced before. The
      // finalizer wants the best the live lane reached, not the tail of it.
      n_ner: { entities: [{ text: 'cough' }] },
    });
  });

  it('records nothing for a flush whose lane produced nothing', () => {
    const { service } = buildService();
    const session = seedSession(service);

    capture(service, session, {});

    expect(session.liveNodeOutputs).toBeUndefined();
  });
});

describe('TASK-932 R-16a — handing off at stop', () => {
  it('writes the accumulated outputs under the consultation’s own key, with a bounded TTL', async () => {
    const { service, cache, stored } = buildService();
    const session = seedSession(service, { n_summary: { text: 'the running note' } });

    await persist(service, session);

    expect(cache.setex).toHaveBeenCalledWith(`live-doc:handoff:${CID}`, 7200, expect.any(String));
    expect(JSON.parse(stored.get(`live-doc:handoff:${CID}`)!)).toMatchObject({
      tenantId: TENANT,
      outputs: { n_summary: { text: 'the running note' } },
    });
  });

  it('writes a record even when the lane produced nothing — empty is not the same as "not yet"', async () => {
    const { service, stored } = buildService();
    const session = seedSession(service);

    await persist(service, session);

    expect(JSON.parse(stored.get(`live-doc:handoff:${CID}`)!).outputs).toEqual({});
  });

  it('never throws when the write fails — the clinician’s stop always completes', async () => {
    const { service } = buildService({ setexThrows: true });
    const session = seedSession(service, { n_summary: { text: 'x' } });

    await expect(persist(service, session)).resolves.toBeUndefined();
  });
});

describe('TASK-932 R-16a — reading the handoff', () => {
  it('answers `ended: false` while the consultation can still record', async () => {
    const { service } = buildService({ status: 'RECORDING' });

    await expect(service.readLiveHandoff(CID, ['n_summary'])).resolves.toEqual({ ended: false, outputs: {}, context: {} });
  });

  it('answers `ended: false` at OPEN — a run dispatched at consultation open must not finalize there', async () => {
    // This IS cause 2 of the defect: the interpreter run starts at consultation OPEN and its
    // stage walk has no wait, so without this answer the finalizer ran before a word was spoken.
    const { service } = buildService({ status: 'OPEN' });

    await expect(service.readLiveHandoff(CID)).resolves.toMatchObject({ ended: false });
  });

  it('answers `ended: true` with the recorded outputs, filtered to the node ids asked about', async () => {
    const { service } = buildService({
      status: 'DRAINING',
      stored: {
        endedAt: '2026-09-09T10:00:00.000Z',
        tenantId: TENANT,
        outputs: { n_summary: { text: 'the running note' }, n_ner: { entities: [] }, n_asr: { transcript: 't' } },
      },
    });

    const answer = await service.readLiveHandoff(CID, ['n_summary', 'n_ner']);

    expect(answer.ended).toBe(true);
    expect(answer.endedAt).toBe('2026-09-09T10:00:00.000Z');
    expect(Object.keys(answer.outputs).sort()).toEqual(['n_ner', 'n_summary']);
    expect(answer.outputs.n_summary).toEqual({ text: 'the running note' });
  });

  it('answers `ended: true` with an honest empty once capture is over and no record exists', async () => {
    // A stop routed to an instance owning no session, or an evicted key. The finalizer then
    // degrades with its own named reason rather than waiting out its two-hour bound.
    const { service } = buildService({ status: 'DRAINING' });

    await expect(service.readLiveHandoff(CID, ['n_summary'])).resolves.toMatchObject({ ended: true, outputs: {} });
  });

  it('answers `ended: true` for a consultation whose lifecycle has moved past capture', async () => {
    const { service } = buildService({ status: 'SIGNED' });

    await expect(service.readLiveHandoff(CID)).resolves.toMatchObject({ ended: true });
  });
});

describe('TASK-932 R-16a — the DNA writing style on the handoff', () => {
  const RECORD = { endedAt: '2026-09-09T10:00:00.000Z', tenantId: TENANT, outputs: { n_summary: { text: 'note' } } };

  it('carries the clinician’s effective style text and the report id that shaped it', async () => {
    const { service, dnaReportRepository } = buildService({ status: 'DRAINING', stored: RECORD });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.context).toEqual({ dna_style_text: 'Terse. Abbreviates freely.', dna_style_id: 'dna-report-1' });
    expect(dnaReportRepository!.findLatestForDoctor).toHaveBeenCalledWith(DOCTOR);
  });

  it('carries NOTHING when the tenant/doctor gate is off — a style nobody enabled must not shape a note', async () => {
    const { service, dnaReportRepository } = buildService({ status: 'DRAINING', stored: RECORD, dnaEffective: false });

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({});
    expect(dnaReportRepository!.findLatestForDoctor).not.toHaveBeenCalled();
  });

  it('carries NOTHING when the doctor has no report, and still hands the note over', async () => {
    const { service } = buildService({ status: 'DRAINING', stored: RECORD, report: { id: 'r', styleText: '   ' } });

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({});
    expect(answer.outputs.n_summary).toEqual({ text: 'note' });
  });

  it('carries NOTHING when the repository is unwired, rather than failing the handoff', async () => {
    const { service } = buildService({ status: 'DRAINING', stored: RECORD, report: null });

    await expect(service.readLiveHandoff(CID)).resolves.toMatchObject({ ended: true, context: {} });
  });
});

/**
 * TASK-932 wave 4 L-3 — the doctor's REDACTION rules ride the same handoff.
 *
 * The interpreter's finalize (lane H, OD-6) applies deterministic redaction as a plain
 * activity-to-activity `apply_redaction` call when the handoff context carries the rules. They
 * come from the SAME decrypted DNA report the style text does, behind the SAME gate, so this adds
 * no lookup, no second decrypt and no new trust boundary — and, exactly like the style, the rules
 * are resolved HERE rather than stamped into a run payload at dispatch, so a caller can neither
 * supply nor spoof them.
 *
 * The rules are RULE OBJECTS (`{ id, type, match, pattern, replacement?, note? }`), not strings:
 * the harness's `RedactionRule` is `extra="forbid"` over exactly those fields, and a `string[]`
 * could not round-trip one.
 *
 * Fail posture mirrors `ConsultationEventHandler.resolveRedactionRulesForHarness` deliberately: a
 * malformed rule set yields NO rules rather than costing the note the style it would have carried,
 * and `apply_redaction` remains the fail-CLOSED-to-FLAG authority once rules are actually present.
 */
describe('TASK-932 L-3 — the DNA redaction rules on the handoff', () => {
  const RECORD = { endedAt: '2026-09-09T10:00:00.000Z', tenantId: TENANT, outputs: { n_summary: { text: 'note' } } };
  const RULES = {
    rules: [
      { id: 'r1', type: 'remove', match: 'literal', pattern: 'Ms. Ada Byron' },
      { id: 'r2', type: 'rewrite', match: 'regex', pattern: '\\bpt\\b', replacement: 'patient', note: 'expand' },
    ],
  };

  it('carries `dna_redaction_rules` alongside `dna_style_text`, from the same report and the same decrypt', async () => {
    const { service, dnaReportRepository } = buildService({
      status: 'DRAINING',
      stored: RECORD,
      report: { id: 'dna-report-1', styleText: 'Terse. Abbreviates freely.', redactionRules: RULES },
    });

    const answer = await service.readLiveHandoff(CID, ['n_summary']);

    expect(answer.context).toEqual({
      dna_style_text: 'Terse. Abbreviates freely.',
      dna_style_id: 'dna-report-1',
      dna_redaction_rules: [
        { id: 'r1', type: 'remove', match: 'literal', pattern: 'Ms. Ada Byron' },
        { id: 'r2', type: 'rewrite', match: 'regex', pattern: '\\bpt\\b', replacement: 'patient', note: 'expand' },
      ],
    });
    // One report, one decrypt — the rules are a second field of the answer, not a second lookup.
    expect(dnaReportRepository!.findLatestForDoctor).toHaveBeenCalledTimes(1);
    expect(dnaReportRepository!.decryptFieldsFromEntity).toHaveBeenCalledTimes(1);
  });

  it('omits the key entirely when the doctor authored no rules — absent, never an empty array', async () => {
    const { service } = buildService({ status: 'DRAINING', stored: RECORD });

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({ dna_style_text: 'Terse. Abbreviates freely.', dna_style_id: 'dna-report-1' });
    expect('dna_redaction_rules' in answer.context).toBe(false);
  });

  it('omits the key for an EMPTY rule set — nothing to apply is the same as nothing authored', async () => {
    const { service } = buildService({
      status: 'DRAINING',
      stored: RECORD,
      report: { id: 'dna-report-1', styleText: 'Terse.', redactionRules: { rules: [] } },
    });

    const answer = await service.readLiveHandoff(CID);

    expect('dna_redaction_rules' in answer.context).toBe(false);
  });

  it('carries NOTHING at all when the gate is off — rules nobody enabled must not touch a note', async () => {
    const { service, dnaReportRepository } = buildService({
      status: 'DRAINING',
      stored: RECORD,
      dnaEffective: false,
      report: { id: 'dna-report-1', styleText: 'Terse.', redactionRules: RULES },
    });

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({});
    expect(dnaReportRepository!.findLatestForDoctor).not.toHaveBeenCalled();
  });

  it('drops a MALFORMED rule set without costing the note its style', async () => {
    const { service } = buildService({
      status: 'DRAINING',
      stored: RECORD,
      report: { id: 'dna-report-1', styleText: 'Terse.', redactionRules: { rules: [{ id: 'r1', type: 'delete', match: 'literal', pattern: 'x' }] } },
    });

    const answer = await service.readLiveHandoff(CID);

    expect(answer.context).toEqual({ dna_style_text: 'Terse.', dna_style_id: 'dna-report-1' });
  });
});
