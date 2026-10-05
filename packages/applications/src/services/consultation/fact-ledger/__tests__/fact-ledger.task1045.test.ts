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
import {
  FACT_KINDS,
  FACT_LEDGER_AGENT_SLUG,
  FACT_LEDGER_SCHEMA,
  factLedgerV1Schema,
  isCriticalFact,
  type FactLedgerV1,
  type LedgerFact,
} from '../fact-ledger.schema';
import { applySupersession } from '../fact-ledger-supersession';
import {
  ENCOUNTER_RECAP_RENDERER,
  ENCOUNTER_RECAP_SCHEMA,
  renderEncounterRecap,
  renderRecapText,
  type EncounterRecapV2,
} from '../encounter-recap.renderer';
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
  encounterEndedAt?: string;
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
    undefined,
    opts.encounterEndedAt ? ({ findBySeq: vi.fn(async () => ({ seq: 1, endedAt: new Date(opts.encounterEndedAt!) })) } as never) : undefined,
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
      { segmentId: 'seg-1', versionNumber: 3, label: 'S12', t0Ms: 221_000 },
      { segmentId: 'seg-2', versionNumber: 1, label: 'S13', t0Ms: 230_500 },
    ]);
    expect(ledger.attachmentSources).toEqual([{ itemId: 'att-tx-1', versionNumber: 1, label: 'A1', arrivedAfterEncounterEnd: false }]);
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
        metaData: { schema: ENCOUNTER_RECAP_SCHEMA, ledgerItemId: 'ledger-item', ledgerVersion: 2, renderer: 'recap.v2' },
      }),
    );
    expect(ENCOUNTER_RECAP_RENDERER).toBe('recap.v2');
    const recapBody = JSON.parse((recapCall![0] as { content: string }).content) as EncounterRecapV2;
    expect(recapBody.schema).toBe('hope.encounter_recap.v2');
    expect(recapBody.sections.find((s) => s.key === 'medicines')!.lines).toEqual([
      {
        text: 'Metformin 500 mg twice daily.',
        citations: [{ itemId: 'seg-1', versionNumber: 3, label: 'S12', kind: 'segment', t0Ms: 221_000 }],
      },
      {
        text: 'Allergic to penicillin.',
        citations: [{ itemId: 'seg-2', versionNumber: 1, label: 'S13', kind: 'segment', t0Ms: 230_500 }],
      },
    ]);
    // Uploaded during the encounter (no end recorded) ⇒ an ordinary finding, not "Since then".
    expect(recapBody.sections.find((s) => s.key === 'findings')!.lines).toEqual([
      { text: 'HbA1c 9.1%, elevated.', citations: [{ itemId: 'att-tx-1', versionNumber: 1, label: 'A1', kind: 'attachment' }] },
    ]);
    expect(recapBody.sections.find((s) => s.key === 'since_then')!.lines).toEqual([]);

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

describe('encounter recap — structured v2, pure template', () => {
  const fact = (factId: string, kind: LedgerFact['kind'], statement: string, citations: string[], extra: Partial<LedgerFact> = {}): LedgerFact => ({
    factId,
    key: `${kind}:${factId}`,
    kind,
    statement,
    critical: false,
    numbers: [],
    aliases: [],
    citations,
    ...extra,
  });

  const ledger: FactLedgerV1 = {
    schema: FACT_LEDGER_SCHEMA,
    consultationId: CID,
    encounterSeq: 2,
    inputDigest: 'sha256:' + 'b'.repeat(64),
    sources: [
      { segmentId: 'seg-20', versionNumber: 1, label: 'S20', t0Ms: 10_000 },
      { segmentId: 'seg-21', versionNumber: 2, label: 'S21', t0Ms: 20_000 },
    ],
    attachmentSources: [
      { itemId: 'att-late', versionNumber: 1, label: 'A1', arrivedAfterEncounterEnd: true },
      { itemId: 'att-during', versionNumber: 3, label: 'A2', arrivedAfterEncounterEnd: false },
    ],
    agent: { slug: FACT_LEDGER_AGENT_SLUG, version: 3 },
    model: 'm',
    createdAt: '2026-10-05T09:00:00.000Z',
    facts: [
      fact('E2-F1', 'complaint', 'Chest pain for two days.', ['seg-20']),
      fact('E2-F2', 'vital', 'BP 130/85.', ['seg-20'], { key: 'vital:bp', supersededBy: 'E2-F3' }),
      fact('E2-F3', 'vital', 'BP 128/80.', ['seg-21', 'seg-20'], { key: 'vital:bp', supersedes: ['E2-F2'] }),
      // Earlier in transcript order than the result, yet rendered after it (D-31).
      fact('E2-F12', 'diagnosis', 'Stable angina.', ['seg-21']),
      fact('E2-F4', 'history', 'Known hypertensive.', ['seg-20']),
      fact('E2-F5', 'result', 'Potassium 4.2.', ['att-during', 'seg-21']),
      fact('E2-F6', 'medication', 'Aspirin 75 mg daily.', ['seg-21']),
      fact('E2-F7', 'allergy', 'Allergic to penicillin.', ['seg-20']),
      fact('E2-F8', 'order', 'ECG ordered.', ['seg-21']),
      fact('E2-F9', 'result', 'Troponin elevated.', ['att-late']),
      fact('E2-F10', 'follow_up', 'Cardiology review next week.', ['seg-21']),
      fact('E2-F11', 'red_flag', 'Return if pain at rest.', ['seg-21']),
      fact('E2-F13', 'negation', 'No fever.', ['seg-20']),
    ],
    stats: { segmentCount: 2, attachmentCount: 2, factCount: 12, criticalCount: 6, droppedUncited: 0, droppedInvalid: 0, callCount: 1 },
  };

  const s20 = { itemId: 'seg-20', versionNumber: 1, label: 'S20', kind: 'segment', t0Ms: 10_000 };
  const s21 = { itemId: 'seg-21', versionNumber: 2, label: 'S21', kind: 'segment', t0Ms: 20_000 };

  it('renders the six fixed sections in order, active facts verbatim with machine-mappable citations', () => {
    expect(renderEncounterRecap(ledger)).toEqual({
      schema: 'hope.encounter_recap.v2',
      sections: [
        {
          key: 'reason',
          label: 'Reason',
          lines: [
            { text: 'Chest pain for two days.', citations: [s20] },
            { text: 'Known hypertensive.', citations: [s20] },
          ],
        },
        {
          key: 'findings',
          label: 'Findings',
          lines: [
            { text: 'BP 128/80.', citations: [s20, s21] },
            { text: 'Potassium 4.2.', citations: [s21, { itemId: 'att-during', versionNumber: 3, label: 'A2', kind: 'attachment' }] },
            { text: 'Stable angina.', citations: [s21] },
          ],
        },
        {
          key: 'medicines',
          label: 'Medicines',
          lines: [
            { text: 'Aspirin 75 mg daily.', citations: [s21] },
            { text: 'Allergic to penicillin.', citations: [s20] },
          ],
        },
        { key: 'sent_for', label: 'Sent for', lines: [{ text: 'ECG ordered.', citations: [s21] }] },
        {
          key: 'since_then',
          label: 'Since then',
          lines: [{ text: 'Troponin elevated.', citations: [{ itemId: 'att-late', versionNumber: 1, label: 'A1', kind: 'attachment' }] }],
        },
        {
          key: 'still_open',
          label: 'Still open',
          lines: [
            { text: 'Cardiology review next week.', citations: [s21] },
            { text: 'Return if pain at rest.', citations: [s21] },
          ],
        },
      ],
    });
  });

  it('derives the console text from the structured recap', () => {
    expect(renderRecapText(renderEncounterRecap(ledger))).toBe(
      [
        '## Reason',
        '- Chest pain for two days. [S20]',
        '- Known hypertensive. [S20]',
        '',
        '## Findings',
        '- BP 128/80. [S20, S21]',
        '- Potassium 4.2. [S21, A2]',
        '- Stable angina. [S21]',
        '',
        '## Medicines',
        '- Aspirin 75 mg daily. [S21]',
        '- Allergic to penicillin. [S20]',
        '',
        '## Sent for',
        '- ECG ordered. [S21]',
        '',
        '## Since then',
        '- Troponin elevated. [A1]',
        '',
        '## Still open',
        '- Cardiology review next week. [S21]',
        '- Return if pain at rest. [S21]',
      ].join('\n'),
    );
  });

  it('keeps empty sections with no lines', () => {
    const recap = renderEncounterRecap({ ...ledger, facts: [ledger.facts[0]] });
    expect(recap.sections.map((section) => [section.key, section.lines.length])).toEqual([
      ['reason', 1],
      ['findings', 0],
      ['medicines', 0],
      ['sent_for', 0],
      ['since_then', 0],
      ['still_open', 0],
    ]);
    expect(renderRecapText(recap)).toBe(
      '## Reason\n- Chest pain for two days. [S20]\n\n## Findings\n- None\n\n## Medicines\n- None\n\n## Sent for\n- None\n\n## Since then\n- None\n\n## Still open\n- None',
    );
  });

  it('is deterministic and never mutates the ledger', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(ledger)) as FactLedgerV1);
    const a = renderEncounterRecap(frozen);
    const b = renderEncounterRecap(frozen);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(frozen).toEqual(ledger);
  });

  it('puts a fact cited only by a transcript uploaded after the encounter ended under "Since then"', async () => {
    const h = harness({
      segments: E1_SEGMENTS,
      transcripts: [attachmentTranscript('att-tx-1', 1, 'Lab report: HbA1c 9.1 percent.', '2026-10-05T10:00:00Z')],
      encounterEndedAt: '2026-10-05T09:30:00Z',
      modelFacts: [
        { key: 'result:hba1c', kind: 'result', statement: 'HbA1c 9.1%, elevated.', citations: ['A1'] },
        { key: 'result:hba1c_prior', kind: 'result', statement: 'Prior HbA1c 8.', citations: ['A1', 'S12'] },
      ],
    });
    await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });
    expect(storedLedger(h.upsert).content.attachmentSources).toEqual([
      { itemId: 'att-tx-1', versionNumber: 1, label: 'A1', arrivedAfterEncounterEnd: true },
    ]);
    const recapCall = h.upsert.mock.calls.find((c) => (c[0] as { type: string }).type === 'ENCOUNTER_RECAP');
    const recap = JSON.parse((recapCall![0] as { content: string }).content) as EncounterRecapV2;
    expect(recap.sections.find((s) => s.key === 'since_then')!.lines.map((l) => l.text)).toEqual(['HbA1c 9.1%, elevated.']);
    expect(recap.sections.find((s) => s.key === 'findings')!.lines.map((l) => l.text)).toEqual(['Prior HbA1c 8.']);
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

describe('fact ledger — the drift a small model shows live (gemma-4-e2b, temperature 0)', () => {
  async function build(modelFacts: unknown[], segments = E1_SEGMENTS, transcripts: unknown[] = []): Promise<FactLedgerV1> {
    const h = harness({ segments, transcripts, modelFacts });
    await h.service.buildForEncounter({ tenantId: TENANT, consultationId: CID, encounterSeq: 1 });
    return storedLedger(h.upsert).content;
  }

  it('resolves a citation written as the full rendered label, bracketed or not, to its leading label', async () => {
    const ledger = await build([
      { key: 'med:metformin', kind: 'medication', statement: 'Metformin 500 mg.', citations: ['[S12 E1 Doctor 03:41]'] },
      { key: 'allergy:penicillin', kind: 'allergy', statement: 'Allergic to penicillin.', citations: ['S13 E1 Patient 03:50'] },
      { key: 'complaint:none', kind: 'complaint', statement: 'Nothing.', citations: ['[S99 E1 Doctor 09:00]'] },
    ]);

    expect(ledger.facts.map((f) => [f.key, f.citations])).toEqual([
      ['med:metformin', ['seg-1']],
      ['allergy:penicillin', ['seg-2']],
    ]);
    expect(ledger.stats.droppedUncited).toBe(1);
  });

  it('takes only the leading label of a rendered one, never a later token that happens to look like a label', async () => {
    const ledger = await build(
      [{ key: 'complaint:cough', kind: 'complaint', statement: 'Cough.', citations: ['[S12 E1 A1 03:41]'] }],
      [seg('seg-1', 12, 1, 'A1', 221_000, 'I have a cough.')],
      [attachmentTranscript('att-tx-1', 1, 'Unrelated upload.', '2026-10-05T10:00:00Z')],
    );

    expect(ledger.facts.map((f) => f.citations)).toEqual([['seg-1']]);
  });

  it('still reads several bare labels in one citation string', async () => {
    const ledger = await build([{ key: 'complaint:x', kind: 'complaint', statement: 'X.', citations: ['S12, S13'] }]);

    expect(ledger.facts.map((f) => f.citations)).toEqual([['seg-1', 'seg-2']]);
  });

  it('accepts a singular `citation` string as the one citation', async () => {
    const ledger = await build([
      { key: 'allergy:penicillin', kind: 'allergy', statement: 'Allergic to penicillin.', citation: '[S13 E1 Patient 00:03]' },
    ]);

    expect(ledger.facts.map((f) => [f.key, f.citations])).toEqual([['allergy:penicillin', ['seg-2']]]);
    expect(ledger.stats.droppedInvalid).toBe(0);
  });

  it('parses numbers given as strings into value and unit, keeping a plain word as a value', async () => {
    const ledger = await build([
      {
        key: 'med:metformin',
        kind: 'medication',
        statement: 'Metformin 500 mg twice daily, 1.5 tablets.',
        citations: ['S12'],
        numbers: ['500 mg', 'twice', '1.5', { value: '2', unit: 'weeks' }, '120/80', '37.5°C', ''],
      },
    ]);

    expect(ledger.facts[0].numbers).toEqual([
      { value: '500', unit: 'mg' },
      { value: 'twice' },
      { value: '1.5' },
      { value: '2', unit: 'weeks' },
      // A reading that is not one number and one unit is kept whole, never split.
      { value: '120/80' },
      { value: '37.5', unit: '°C' },
    ]);
    expect(ledger.stats.droppedInvalid).toBe(0);
  });

  it('never invents a missing kind: the fact stays invalid', async () => {
    const ledger = await build([
      { key: 'med:metformin', statement: 'Metformin 500 mg.', citation: 'S12', numbers: ['500 mg'] },
      { key: 'allergy:penicillin', kind: 'allergy', statement: 'Allergic to penicillin.', citations: ['S13'] },
    ]);

    expect(ledger.facts.map((f) => f.key)).toEqual(['allergy:penicillin']);
    expect(ledger.stats.droppedInvalid).toBe(1);
  });

  it('does not merge a singular citation into an explicit citations array', async () => {
    const ledger = await build([{ key: 'complaint:x', kind: 'complaint', statement: 'X.', citations: ['S12'], citation: 'S13' }]);

    expect(ledger.facts.map((f) => f.citations)).toEqual([['seg-1']]);
  });
});
