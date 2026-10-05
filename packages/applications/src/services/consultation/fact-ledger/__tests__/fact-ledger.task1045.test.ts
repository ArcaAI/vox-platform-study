/**
 * Per-encounter fact ledger producer + encounter recap renderer.
 *
 * Edges are mocked (repository, agent resolver/invocation, transcript record, run record, queue);
 * the producer, the supersession rules and the recap renderer run for real.
 */
import { describe, it, expect, vi } from 'vitest';
import { AiActivityKind, AiActivityRunStatus } from '@arcaai/domains';
import {
  FACT_LEDGER_AGENT_SLUG as SEED_FACT_LEDGER_AGENT_SLUG,
  FACT_LEDGER_OUTPUT_SCHEMA,
} from '../../../../../../database/src/prisma/db_main/seed/25-agents';
import { FactLedgerService } from '../fact-ledger.service';
import { FACT_KINDS, FACT_LEDGER_AGENT_SLUG, FACT_LEDGER_SCHEMA, factLedgerV1Schema, isCriticalFact, type FactLedgerV1 } from '../fact-ledger.schema';
import { applySupersession } from '../fact-ledger-supersession';
import { ENCOUNTER_RECAP_RENDERER, renderEncounterRecap } from '../encounter-recap.renderer';
import { FactLedgerListener } from '../fact-ledger.listener';
import { FactLedgerQueue } from '../fact-ledger.processor';
import { ConsultationPipelineEvent } from '../../events';

const TENANT = 'tenant-1';
const CID = 'consult-1';

interface SegmentFixture {
  id: string;
  segmentSeq: number;
  encounterSeq: number;
  speaker: string | null;
  t0Ms: number;
  content: string;
  currentVersionNumber: number;
}

function seg(
  id: string,
  segmentSeq: number,
  encounterSeq: number,
  speaker: string | null,
  t0Ms: number,
  content: string,
  version = 1,
): SegmentFixture {
  return { id, segmentSeq, encounterSeq, speaker, t0Ms, content, currentVersionNumber: version };
}

function attachmentTranscript(id: string, encounterSeq: number, content: string, createdAt: string, version = 1) {
  return {
    id,
    type: 'TRANSCRIPT',
    encounterSeq,
    content,
    currentVersionNumber: version,
    metaData: { origin: 'attachment_audio', attachmentId: `att-of-${id}` },
    createdAt: new Date(createdAt),
  };
}

interface Harness {
  service: FactLedgerService;
  repo: { findSegments: ReturnType<typeof vi.fn>; findTranscripts: ReturnType<typeof vi.fn>; findEncounterArtifact: ReturnType<typeof vi.fn> };
  invokeText: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  segments: SegmentFixture[];
  transcripts?: unknown[];
  artifacts?: Record<string, unknown>;
  modelFacts?: unknown[] | ((message: string) => unknown[]);
}): Harness {
  const repo = {
    findSegments: vi.fn(async (_cid: string, filters: { encounterSeq?: number } = {}) =>
      opts.segments.filter((s) => filters.encounterSeq === undefined || s.encounterSeq === filters.encounterSeq),
    ),
    findTranscripts: vi.fn(async () => opts.transcripts ?? []),
    findEncounterArtifact: vi.fn(async (_cid: string, type: string, seq: number) => (opts.artifacts ?? {})[`${type}:${seq}`] ?? null),
  };
  const resolve = vi.fn(async () => ({
    slug: FACT_LEDGER_AGENT_SLUG,
    versionNumber: 3,
    agentVersionId: 'agent-v3',
    agentId: 'agent-v3',
    task: 'TEXT_GENERATION',
  }));
  const invokeText = vi.fn(async (_agent: unknown, _tenant: string, input: { message: string }) => {
    const facts = typeof opts.modelFacts === 'function' ? opts.modelFacts(input.message) : (opts.modelFacts ?? []);
    return {
      text: JSON.stringify({ facts }),
      model: 'gemma-4-e2b-it-qat',
      provider: 'lmstudio',
      usage: { promptTokens: 120, completionTokens: 60 },
      promptFragments: null,
    };
  });
  const upsert = vi.fn(async (input: { type: string }) => ({
    contextItemId: input.type === 'FACT_LEDGER' ? 'ledger-item' : 'recap-item',
    versionNumber: 2,
  }));
  const record = vi.fn(async () => undefined);
  const service = new FactLedgerService(
    repo as never,
    { resolve } as never,
    { invokeText } as never,
    { upsertEncounterArtifact: upsert } as never,
    undefined,
    { record } as never,
  );
  return { service, repo, invokeText, resolve, upsert, record };
}

function storedLedger(upsert: ReturnType<typeof vi.fn>): { content: FactLedgerV1; metaData: Record<string, unknown> } {
  const call = upsert.mock.calls.find((c) => (c[0] as { type: string }).type === 'FACT_LEDGER');
  expect(call).toBeDefined();
  const input = call![0] as { content: string; metaData: Record<string, unknown> };
  return { content: JSON.parse(input.content) as FactLedgerV1, metaData: input.metaData };
}

const E1_SEGMENTS = [
  seg('seg-1', 12, 1, 'Doctor', 221_000, 'You are taking metformin 500 mg twice daily.', 3),
  seg('seg-2', 13, 1, 'Patient', 230_500, 'I am allergic to penicillin.'),
];

describe('fact ledger — contract parity with the seeded agent', () => {
  it('names the seeded slug and accepts every kind the agent may return', () => {
    expect(FACT_LEDGER_AGENT_SLUG).toBe(SEED_FACT_LEDGER_AGENT_SLUG);
    const seedKinds = (FACT_LEDGER_OUTPUT_SCHEMA as { properties: { facts: { items: { properties: { kind: { enum: string[] } } } } } }).properties
      .facts.items.properties.kind.enum;
    expect([...FACT_KINDS].sort()).toEqual([...seedKinds].sort());
  });
});

describe('fact ledger — citation mapping and drop', () => {
  const modelFacts = [
    {
      key: 'med:metformin',
      kind: 'medication',
      statement: 'Metformin 500 mg twice daily.',
      citations: ['S12'],
      critical: false,
      numbers: [{ value: '500', unit: 'mg' }],
    },
    { key: 'allergy:penicillin', kind: 'allergy', statement: 'Allergic to penicillin.', citations: ['[S13 E1 Patient 03:50]'] },
    { key: 'result:hba1c', kind: 'result', statement: 'HbA1c 9.1%, elevated.', citations: ['A1'], numbers: [{ value: '9.1', unit: '%' }] },
    { key: 'complaint:headache', kind: 'complaint', statement: 'Headache.', citations: ['S99'] },
    { key: 'other:nothing', kind: 'other', statement: 'Unsupported.', citations: [] },
  ];

  it('renders labelled lines, maps cited labels to item ids at their current version, and drops uncited facts', async () => {
    const h = harness({
      segments: E1_SEGMENTS,
      transcripts: [attachmentTranscript('att-tx-1', 1, 'Lab report: HbA1c 9.1 percent.', '2026-10-05T10:00:00Z')],
      modelFacts,
    });

    const result = await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });
    expect(result.status).toBe('built');

    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, agentSlug: FACT_LEDGER_AGENT_SLUG }));
    expect(h.invokeText).toHaveBeenCalledTimes(1);
    const [, tenantArg, input, mode] = h.invokeText.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(mode).toBe('blocking');
    const message = (input as { message: string }).message;
    expect(message).toContain('[S12 E1 Doctor 03:41] You are taking metformin 500 mg twice daily.');
    expect(message).toContain('[S13 E1 Patient 03:50] I am allergic to penicillin.');
    expect(message).toContain('[A1] Lab report: HbA1c 9.1 percent.');

    const { content: ledger, metaData } = storedLedger(h.upsert);
    expect(factLedgerV1Schema.safeParse(ledger).success).toBe(true);
    expect(ledger.schema).toBe(FACT_LEDGER_SCHEMA);
    expect(ledger.encounterSeq).toBe(1);
    expect(ledger.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledger.sources).toEqual([
      { segmentId: 'seg-1', versionNumber: 3, label: 'S12' },
      { segmentId: 'seg-2', versionNumber: 1, label: 'S13' },
    ]);
    expect(ledger.attachmentSources).toEqual([{ itemId: 'att-tx-1', versionNumber: 1, label: 'A1' }]);
    expect(ledger.facts.map((f) => [f.key, f.citations])).toEqual([
      ['med:metformin', ['seg-1']],
      ['allergy:penicillin', ['seg-2']],
      ['result:hba1c', ['att-tx-1']],
    ]);
    expect(ledger.facts.map((f) => f.factId)).toEqual(['E1-F1', 'E1-F2', 'E1-F3']);
    expect(ledger.stats.droppedUncited).toBe(2);
    expect(ledger.stats.factCount).toBe(3);

    // Plaintext metaData carries ids and numbers only.
    expect(metaData).toEqual(
      expect.objectContaining({
        schema: FACT_LEDGER_SCHEMA,
        encounterSeq: 1,
        inputDigest: ledger.inputDigest,
        factCount: 3,
        criticalCount: 3,
        droppedUncited: 2,
        agentSlug: FACT_LEDGER_AGENT_SLUG,
        agentVersion: 3,
      }),
    );
    const plain = JSON.stringify(metaData).toLowerCase();
    for (const phi of ['metformin', 'penicillin', 'hba1c', 'allergic']) expect(plain).not.toContain(phi);

    // The recap follows the ledger it was rendered from.
    const recapCall = h.upsert.mock.calls.find((c) => (c[0] as { type: string }).type === 'ENCOUNTER_RECAP');
    expect(recapCall![0]).toEqual(
      expect.objectContaining({
        consultationId: CID,
        encounterSeq: 1,
        source: 'SYSTEM',
        metaData: { ledgerItemId: 'ledger-item', ledgerVersion: 2, renderer: ENCOUNTER_RECAP_RENDERER },
      }),
    );
    expect((recapCall![0] as { content: string }).content).toContain('Metformin 500 mg twice daily. [S12]');

    // One FACT_LEDGER run record, ids and numbers only.
    expect(h.record).toHaveBeenCalledTimes(1);
    const run = h.record.mock.calls[0][0] as Record<string, unknown>;
    expect(run).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        consultationId: CID,
        encounterSeq: 1,
        activityKind: AiActivityKind.FACT_LEDGER,
        status: AiActivityRunStatus.OK,
        agentSlug: FACT_LEDGER_AGENT_SLUG,
        agentVersion: 3,
        model: 'gemma-4-e2b-it-qat',
        tokensIn: 120,
        tokensOut: 60,
        contextItemId: 'ledger-item',
        outputVersionNumber: 2,
        callIndex: 0,
        callCount: 1,
      }),
    );
    expect(metaData.activityRunKey).toBe(run.runKey);
    expect(String(run.runKey)).toMatch(/^fact-ledger:consult-1:/);
    expect(JSON.stringify(run, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).toLowerCase()).not.toContain('metformin');
  });

  it('records an ERROR run and rethrows when the model output is not JSON', async () => {
    const h = harness({ segments: E1_SEGMENTS });
    h.invokeText.mockResolvedValueOnce({ text: 'not json', model: 'm', provider: 'p', usage: null, promptFragments: null });
    await expect(h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 })).rejects.toThrow();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ status: AiActivityRunStatus.ERROR, errorCode: 'FACT_LEDGER_OUTPUT_INVALID' }));
  });
});

describe('fact ledger — critical is set by code', () => {
  it('ignores the model flag and decides from the kind (results only when abnormal)', async () => {
    const h = harness({
      segments: E1_SEGMENTS,
      modelFacts: [
        { key: 'med:metformin', kind: 'medication', statement: 'Metformin 500 mg.', citations: ['S12'], critical: false },
        { key: 'complaint:cough', kind: 'complaint', statement: 'Cough.', citations: ['S12'], critical: true },
        { key: 'result:k', kind: 'result', statement: 'Potassium 4.2, normal.', citations: ['S13'], critical: true },
        { key: 'result:hb', kind: 'result', statement: 'Haemoglobin low at 8.', citations: ['S13'] },
        { key: 'followup:2w', kind: 'follow_up', statement: 'Review in two weeks.', citations: ['S13'] },
      ],
    });
    await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });
    const { content } = storedLedger(h.upsert);
    const critical = Object.fromEntries(content.facts.map((f) => [f.key, f.critical]));
    expect(critical).toEqual({ 'med:metformin': true, 'complaint:cough': false, 'result:k': false, 'result:hb': true, 'followup:2w': true });
  });

  it('marks the critical kinds and nothing else', () => {
    for (const kind of ['medication', 'dose_change', 'allergy', 'diagnosis', 'plan', 'order', 'follow_up', 'red_flag'] as const) {
      expect(isCriticalFact(kind, 'anything')).toBe(true);
    }
    for (const kind of ['complaint', 'history', 'vital', 'exam', 'negation', 'other'] as const) {
      expect(isCriticalFact(kind, 'elevated')).toBe(false);
    }
    expect(isCriticalFact('result', 'Creatinine raised at 2.1')).toBe(true);
    expect(isCriticalFact('result', 'Creatinine 0.9')).toBe(false);
  });
});

describe('fact ledger — supersession', () => {
  const e1Ledger: FactLedgerV1 = {
    schema: FACT_LEDGER_SCHEMA,
    consultationId: CID,
    encounterSeq: 1,
    inputDigest: 'sha256:' + 'a'.repeat(64),
    sources: [{ segmentId: 'seg-1', versionNumber: 1, label: 'S1' }],
    attachmentSources: [],
    agent: { slug: FACT_LEDGER_AGENT_SLUG, version: 3 },
    model: 'm',
    createdAt: '2026-10-05T09:00:00.000Z',
    facts: [
      {
        factId: 'E1-F1',
        key: 'med:metformin',
        kind: 'medication',
        statement: 'Metformin 500 mg.',
        critical: true,
        numbers: [],
        aliases: [],
        citations: ['seg-1'],
      },
      {
        factId: 'E1-F2',
        key: 'allergy:penicillin',
        kind: 'allergy',
        statement: 'Penicillin allergy.',
        critical: true,
        numbers: [],
        aliases: [],
        citations: ['seg-1'],
      },
      {
        factId: 'E1-F3',
        key: 'vital:bp',
        kind: 'vital',
        statement: 'BP 150/90.',
        critical: false,
        numbers: [],
        aliases: [],
        citations: ['seg-1'],
        supersededBy: 'E1-F4',
      },
      {
        factId: 'E1-F4',
        key: 'vital:bp',
        kind: 'vital',
        statement: 'BP 140/90.',
        critical: false,
        numbers: [],
        aliases: [],
        citations: ['seg-1'],
        supersedes: ['E1-F3'],
      },
    ],
    stats: { segmentCount: 1, attachmentCount: 0, factCount: 4, criticalCount: 2, droppedUncited: 0, droppedInvalid: 0, callCount: 1 },
  };

  it('supersedes within the encounter by key and against the latest active fact of earlier encounters, never rewriting them', async () => {
    const h = harness({
      segments: [
        ...E1_SEGMENTS,
        seg('seg-20', 20, 2, 'Doctor', 10_000, 'BP today 130 over 85.'),
        seg('seg-21', 21, 2, 'Doctor', 20_000, 'Repeat BP 128 over 80.'),
        seg('seg-22', 22, 2, 'Doctor', 30_000, 'Increase metformin to 1000 mg.'),
      ],
      artifacts: {
        'FACT_LEDGER:1': {
          id: 'e1-ledger',
          content: JSON.stringify(e1Ledger),
          currentVersionNumber: 1,
          metaData: { inputDigest: e1Ledger.inputDigest },
        },
      },
      modelFacts: [
        { key: 'med:metformin', kind: 'dose_change', statement: 'Metformin increased to 1000 mg.', citations: ['S22'] },
        { key: 'vital:bp', kind: 'vital', statement: 'BP 128/80.', citations: ['S21'] },
        { key: 'vital:bp', kind: 'vital', statement: 'BP 130/85.', citations: ['S20'] },
      ],
    });

    await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 2 });
    for (const call of h.upsert.mock.calls) expect((call[0] as { encounterSeq: number }).encounterSeq).toBe(2);

    const { content } = storedLedger(h.upsert);
    const byKeyStatement = Object.fromEntries(content.facts.map((f) => [f.statement, f]));
    const first = byKeyStatement['BP 130/85.'];
    const later = byKeyStatement['BP 128/80.'];
    const metformin = byKeyStatement['Metformin increased to 1000 mg.'];
    // Ordered by transcript position, so the S20 reading is the earlier one.
    expect(first.factId).toBe('E2-F1');
    expect(later.factId).toBe('E2-F2');
    expect(first.supersededBy).toBe('E2-F2');
    expect(later.supersedes).toEqual(['E2-F1', 'E1-F4']);
    expect(later.supersededBy ?? null).toBeNull();
    expect(metformin.supersedes).toEqual(['E1-F1']);
  });

  it('is a pure function of its inputs', () => {
    const facts = [
      { factId: 'E2-F1', key: 'med:x', kind: 'medication' as const, statement: 'a', critical: true, numbers: [], aliases: [], citations: ['s'] },
      { factId: 'E2-F2', key: 'MED:X ', kind: 'medication' as const, statement: 'b', critical: true, numbers: [], aliases: [], citations: ['s'] },
    ];
    const frozen = JSON.parse(JSON.stringify(facts));
    const out = applySupersession(facts, [e1Ledger]);
    expect(facts).toEqual(frozen);
    expect(out[0].supersededBy).toBe('E2-F2');
    expect(out[1].supersedes).toEqual(['E2-F1']);
  });
});

describe('fact ledger — input digest cache', () => {
  it('skips the model when the stored ledger was built from the same segment versions', async () => {
    const probe = harness({ segments: E1_SEGMENTS });
    const digest = await probe.service.computeEncounterDigest(CID, 1);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const h = harness({
      segments: E1_SEGMENTS,
      artifacts: { 'FACT_LEDGER:1': { id: 'ledger-item', content: '{}', currentVersionNumber: 1, metaData: { inputDigest: digest } } },
      modelFacts: [{ key: 'k', kind: 'other', statement: 's', citations: ['S12'] }],
    });
    const result = await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });
    expect(result).toEqual({ status: 'skipped', reason: 'unchanged', inputDigest: digest });
    expect(h.invokeText).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('changes when a segment gains a version or an attachment transcript arrives', async () => {
    const base = await harness({ segments: E1_SEGMENTS }).service.computeEncounterDigest(CID, 1);
    const edited = await harness({ segments: [{ ...E1_SEGMENTS[0], currentVersionNumber: 4 }, E1_SEGMENTS[1]] }).service.computeEncounterDigest(
      CID,
      1,
    );
    const withAudio = await harness({
      segments: E1_SEGMENTS,
      transcripts: [attachmentTranscript('att-tx-1', 1, 'x', '2026-10-05T10:00:00Z')],
    }).service.computeEncounterDigest(CID, 1);
    const reordered = await harness({ segments: [E1_SEGMENTS[1], E1_SEGMENTS[0]] }).service.computeEncounterDigest(CID, 1);
    expect(edited).not.toBe(base);
    expect(withAudio).not.toBe(base);
    expect(reordered).toBe(base);
  });

  it('skips an encounter with nothing to ledger', async () => {
    const h = harness({ segments: [] });
    const result = await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });
    expect(result).toEqual({ status: 'skipped', reason: 'empty', inputDigest: null });
    expect(h.invokeText).not.toHaveBeenCalled();
  });
});

describe('encounter recap — pure template', () => {
  const ledger: FactLedgerV1 = {
    schema: FACT_LEDGER_SCHEMA,
    consultationId: CID,
    encounterSeq: 2,
    inputDigest: 'sha256:' + 'b'.repeat(64),
    sources: [
      { segmentId: 'seg-20', versionNumber: 1, label: 'S20' },
      { segmentId: 'seg-21', versionNumber: 2, label: 'S21' },
    ],
    attachmentSources: [{ itemId: 'att-tx-1', versionNumber: 1, label: 'A1' }],
    agent: { slug: FACT_LEDGER_AGENT_SLUG, version: 3 },
    model: 'm',
    createdAt: '2026-10-05T09:00:00.000Z',
    facts: [
      {
        factId: 'E2-F1',
        key: 'complaint:chest_pain',
        kind: 'complaint',
        statement: 'Chest pain for two days.',
        critical: false,
        numbers: [],
        aliases: [],
        citations: ['seg-20'],
      },
      {
        factId: 'E2-F2',
        key: 'vital:bp',
        kind: 'vital',
        statement: 'BP 130/85.',
        critical: false,
        numbers: [],
        aliases: [],
        citations: ['seg-20'],
        supersededBy: 'E2-F3',
      },
      {
        factId: 'E2-F3',
        key: 'vital:bp',
        kind: 'vital',
        statement: 'BP 128/80.',
        critical: false,
        numbers: [],
        aliases: [],
        citations: ['seg-21', 'seg-20'],
        supersedes: ['E2-F2'],
      },
      {
        factId: 'E2-F4',
        key: 'result:troponin',
        kind: 'result',
        statement: 'Troponin elevated.',
        critical: true,
        numbers: [],
        aliases: [],
        citations: ['att-tx-1'],
      },
      {
        factId: 'E2-F5',
        key: 'med:aspirin',
        kind: 'medication',
        statement: 'Aspirin 75 mg daily.',
        critical: true,
        numbers: [],
        aliases: [],
        citations: ['seg-21'],
      },
      {
        factId: 'E2-F6',
        key: 'order:ecg',
        kind: 'order',
        statement: 'ECG ordered.',
        critical: true,
        numbers: [],
        aliases: [],
        citations: ['seg-21'],
      },
      {
        factId: 'E2-F7',
        key: 'followup:cardio',
        kind: 'follow_up',
        statement: 'Cardiology review next week.',
        critical: true,
        numbers: [],
        aliases: [],
        citations: ['seg-21'],
      },
    ],
    stats: { segmentCount: 2, attachmentCount: 1, factCount: 7, criticalCount: 4, droppedUncited: 0, droppedInvalid: 0, callCount: 1 },
  };

  it('renders the active facts verbatim, cited, under the fixed headings', () => {
    const recap = renderEncounterRecap(ledger);
    expect(recap.text).toBe(
      [
        '## Complaint',
        '- Chest pain for two days. [S20]',
        '',
        '## Key findings',
        '- BP 128/80. [S20, S21]',
        '- Troponin elevated. [A1]',
        '',
        '## Medications',
        '- Aspirin 75 mg daily. [S21]',
        '',
        '## Plan/Orders',
        '- ECG ordered. [S21]',
        '',
        '## Pending',
        '- Cardiology review next week. [S21]',
      ].join('\n'),
    );
    expect(recap.sections.map((s) => s.key)).toEqual(['complaint', 'key_findings', 'medications', 'plan_orders', 'pending']);
    expect(recap.text).not.toContain('130/85');
  });

  it('is deterministic and never mutates the ledger', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(ledger)) as FactLedgerV1);
    const a = renderEncounterRecap(frozen);
    const b = renderEncounterRecap(frozen);
    expect(a).toEqual(b);
    expect(frozen).toEqual(ledger);
  });

  it('omits empty headings', () => {
    const recap = renderEncounterRecap({ ...ledger, facts: [ledger.facts[0]] });
    expect(recap.text).toBe('## Complaint\n- Chest pain for two days. [S20]');
  });
});

describe('fact ledger listener — enqueue, dedupe, never throw', () => {
  const cls = { run: async (fn: () => Promise<unknown>) => fn(), set: vi.fn() };

  it('enqueues EncounterStopped under a colon-free job id keyed by (consultation, encounter, digest)', async () => {
    const h = harness({ segments: E1_SEGMENTS });
    const add = vi.fn(async () => undefined);
    const queue = new FactLedgerQueue({ add } as never);
    const listener = new FactLedgerListener(h.service, queue, cls as never);
    const payload = { consultationId: CID, tenantId: TENANT, encounterSeq: 1, timestamp: '2026-10-05T10:00:00Z' };

    await listener.onEncounterStopped(payload);
    await listener.onEncounterStopped(payload);

    expect(add).toHaveBeenCalledTimes(2);
    const digest = (await h.service.computeEncounterDigest(CID, 1))!.replace(/^sha256:/, '');
    const [name, data, options] = add.mock.calls[0] as unknown as [string, Record<string, unknown>, { jobId: string }];
    expect(name).toBe('ExtractFactLedger');
    expect(data).toEqual(expect.objectContaining({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 }));
    expect(options.jobId).toBe(`ledger__${CID}__1__${digest}`);
    expect(options.jobId).not.toContain(':');
    expect((add.mock.calls[1] as unknown as [string, unknown, { jobId: string }])[2].jobId).toBe(options.jobId);
  });

  it('re-enqueues only encounters whose stored ledger no longer matches after a rebuild', async () => {
    const segments = [...E1_SEGMENTS, seg('seg-20', 20, 2, 'Doctor', 10_000, 'x')];
    const h = harness({
      segments,
      artifacts: {
        'FACT_LEDGER:1': { id: 'l1', content: '{}', currentVersionNumber: 1, metaData: { inputDigest: 'sha256:stale' } },
      },
    });
    const add = vi.fn(async () => undefined);
    const listener = new FactLedgerListener(h.service, new FactLedgerQueue({ add } as never), cls as never);
    await listener.onFullTranscriptRebuilt({
      consultationId: CID,
      tenantId: TENANT,
      contextItemId: 'ft',
      versionNumber: 2,
      segmentCount: 3,
      timestamp: 't',
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect((add.mock.calls[0] as unknown as [string, { encounterSeq: number }])[1].encounterSeq).toBe(1);
  });

  it('swallows every failure', async () => {
    const add = vi.fn(async () => {
      throw new Error('redis down');
    });
    const h = harness({ segments: E1_SEGMENTS });
    const listener = new FactLedgerListener(h.service, new FactLedgerQueue({ add } as never), cls as never);
    await expect(listener.onEncounterStopped({ consultationId: CID, tenantId: TENANT, encounterSeq: 1, timestamp: 't' })).resolves.toBeUndefined();
    h.repo.findSegments.mockRejectedValueOnce(new Error('db down'));
    await expect(
      listener.onContextAdded({ consultationId: CID, tenantId: TENANT, contextItemId: 'x', contextType: 'TRANSCRIPT', timestamp: 't' }),
    ).resolves.toBeUndefined();
  });

  it('subscribes to the pinned event names', () => {
    expect(ConsultationPipelineEvent.EncounterStopped).toBe('consultation.encounter.stopped');
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
