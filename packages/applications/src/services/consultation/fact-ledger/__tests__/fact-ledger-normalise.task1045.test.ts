/**
 * TASK-1045 e2e findings E2E-28 / E2E-29a — the extractor's key / kind / numbers drift is repaired
 * when the ledger is persisted, and the recap files a stored drifted ledger under the right heading.
 *
 * The facts below are the ones the live gemma-4-e2b extractor wrote for consultation `01a10d8d-…`
 * encounter 1 (synthetic patient): `medication:metformin` as kind `history`, `vital:blood_pressure`
 * as `history`, `order:ecg` as `plan`, a bare `complaint` and a bare `allergy` key, every
 * `numbers` empty. The recap then put metformin and the BP under "Reason" and the orders under
 * "Still open", and coverage never checked metformin (a `history` fact is not critical).
 */
import { describe, it, expect, vi } from 'vitest';
import { FactLedgerService } from '../fact-ledger.service';
import { FACT_LEDGER_AGENT_SLUG, FACT_LEDGER_SCHEMA, type FactKind, type FactLedgerV1 } from '../fact-ledger.schema';
import { normaliseFactKey, normaliseFactKind, numbersFromStatement } from '../fact-ledger-normalise';
import { renderEncounterRecap } from '../encounter-recap.renderer';

const LIVE_E1: Array<{ key: string; kind: FactKind; statement: string }> = [
  { key: 'medication:metformin', kind: 'history', statement: 'Patient takes Metformin five hundred milligrams twice daily for diabetes.' },
  { key: 'vital:blood_pressure', kind: 'history', statement: 'Blood pressure today is 150/95, which is high.' },
  { key: 'order:ecg', kind: 'plan', statement: 'ECG was ordered.' },
  { key: 'order:troponin blood test', kind: 'plan', statement: 'Troponin blood test was ordered.' },
  { key: 'complaint', kind: 'history', statement: 'Patient has had chest tightness for two days, mostly when climbing the stairs.' },
  { key: 'allergy', kind: 'allergy', statement: 'Patient is allergic to penicillin, which causes a rash.' },
];

describe('fact normalisation — the pure rules', () => {
  it('takes the kind the key prefix names, keeping a more specific dose_change or negation', () => {
    expect(LIVE_E1.map((f) => normaliseFactKind(f.key, f.kind))).toEqual(['medication', 'vital', 'order', 'order', 'complaint', 'allergy']);
    expect(normaliseFactKind('medication:metformin', 'dose_change')).toBe('dose_change');
    expect(normaliseFactKind('allergy:penicillin', 'negation')).toBe('negation');
    expect(normaliseFactKind('med:metformin', 'history')).toBe('medication');
    expect(normaliseFactKind('follow_up:review', 'plan')).toBe('follow_up');
    // An unknown prefix keeps the model's kind.
    expect(normaliseFactKind('chest:tightness', 'complaint')).toBe('complaint');
  });

  it('writes keys as kind:term in lower snake case, taking a missing term from the statement', () => {
    const keys = LIVE_E1.map((f) => normaliseFactKey(f.key, normaliseFactKind(f.key, f.kind), f.statement));
    expect(keys).toEqual([
      'medication:metformin',
      'vital:blood_pressure',
      'order:ecg',
      'order:troponin_blood_test',
      'complaint:chest_tightness',
      'allergy:penicillin',
    ]);
    expect(normaliseFactKey('allergy', 'allergy', 'Allergic to penicillin; reaction: rash.')).toBe('allergy:penicillin');
    expect(normaliseFactKey('complaint:complaint', 'complaint', 'Cough for a week.')).toBe('complaint:cough');
    expect(normaliseFactKey('Med:Insulin Glargine', 'medication', 'x')).toBe('med:insulin_glargine');
    // A bare key that is not a kind word is the term.
    expect(normaliseFactKey('metformin', 'medication', 'x')).toBe('medication:metformin');
  });

  it('reads the numbers of a dose, a reading, a result and a follow-up interval off the statement', () => {
    expect(numbersFromStatement('medication', LIVE_E1[0].statement)).toEqual([{ value: '500', unit: 'mg' }]);
    expect(numbersFromStatement('dose_change', 'Increasing Metformin to one thousand milligrams twice daily.')).toEqual([
      { value: '1000', unit: 'mg' },
    ]);
    expect(numbersFromStatement('medication', 'Starting amlodipine 5mg once daily for the blood pressure.')).toEqual([{ value: '5', unit: 'mg' }]);
    expect(numbersFromStatement('vital', LIVE_E1[1].statement)).toEqual([{ value: '150/95' }]);
    expect(numbersFromStatement('result', 'The troponin is 12, which is normal.')).toEqual([{ value: '12' }]);
    expect(numbersFromStatement('follow_up', 'Review in four weeks.')).toEqual([{ value: '4' }]);
    // A bare number in a medication statement is not a dose; other kinds take none.
    expect(numbersFromStatement('medication', 'Two inhalers at home.')).toEqual([]);
    expect(numbersFromStatement('order', 'Repeat in 2 weeks.')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------

function harness(modelFacts: unknown[]) {
  const segments = [
    {
      id: 'seg-1',
      segmentSeq: 1,
      encounterSeq: 1,
      speaker: 'Doctor',
      t0Ms: 0,
      content: 'Any medicines? Metformin 500 milligrams twice a day.',
      currentVersionNumber: 1,
    },
    {
      id: 'seg-2',
      segmentSeq: 2,
      encounterSeq: 1,
      speaker: 'Patient',
      t0Ms: 3000,
      content: 'I am allergic to penicillin. It gives me a rash.',
      currentVersionNumber: 1,
    },
    {
      id: 'seg-3',
      segmentSeq: 3,
      encounterSeq: 1,
      speaker: 'Doctor',
      t0Ms: 6000,
      content: 'Your BP is 150 over 95. Sending you for an ECG and a troponin blood test.',
      currentVersionNumber: 1,
    },
  ];
  const repo = {
    findSegments: vi.fn(async () => segments),
    findTranscripts: vi.fn(async () => []),
    findEncounterArtifact: vi.fn(async () => null),
  };
  const upsert = vi.fn(async (input: { type: string }) => ({ contextItemId: `${input.type}-item`, versionNumber: 1 }));
  const service = new FactLedgerService(
    repo as never,
    {
      resolve: vi.fn(async () => ({ slug: FACT_LEDGER_AGENT_SLUG, versionNumber: 1, agentVersionId: 'a', agentId: 'a', task: 'TEXT_GENERATION' })),
    } as never,
    {
      invokeText: vi.fn(async () => ({
        text: JSON.stringify({ facts: modelFacts }),
        model: 'gemma-4-e2b-it-qat',
        provider: 'lmstudio',
        usage: { promptTokens: 1, completionTokens: 1 },
        promptFragments: null,
      })),
    } as never,
    { upsertEncounterArtifact: upsert } as never,
    undefined,
    { record: vi.fn(async () => undefined) } as never,
  );
  return { service, upsert };
}

describe('fact ledger — the live drift is repaired when the ledger is persisted', () => {
  it('stores reconciled kinds, kind:term keys, code-decided criticality and statement numbers', async () => {
    const cites = ['S1', 'S1', 'S3', 'S3', 'S2', 'S2'];
    const h = harness(LIVE_E1.map((fact, i) => ({ ...fact, citations: [cites[i]], numbers: [] })));

    await h.service.buildForEncounter({ tenantId: 'tenant-1', consultationId: 'consult-1', encounterSeq: 1 });

    const call = h.upsert.mock.calls.find((c) => (c[0] as { type: string }).type === 'FACT_LEDGER')!;
    const ledger = JSON.parse((call[0] as { content: string }).content) as FactLedgerV1;
    const byKey = Object.fromEntries(ledger.facts.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual(
      [
        'allergy:penicillin',
        'complaint:chest_tightness',
        'medication:metformin',
        'order:ecg',
        'order:troponin_blood_test',
        'vital:blood_pressure',
      ].sort(),
    );
    expect(byKey['medication:metformin']).toMatchObject({ kind: 'medication', critical: true, numbers: [{ value: '500', unit: 'mg' }] });
    expect(byKey['vital:blood_pressure']).toMatchObject({ kind: 'vital', critical: false, numbers: [{ value: '150/95' }] });
    expect(byKey['order:ecg']).toMatchObject({ kind: 'order', critical: true });
    expect(byKey['allergy:penicillin']).toMatchObject({ kind: 'allergy', critical: true, numbers: [] });
    expect(byKey['complaint:chest_tightness'].kind).toBe('complaint');
  });

  it('keeps numbers the model did state', async () => {
    const h = harness([
      {
        key: 'medication:metformin',
        kind: 'medication',
        statement: 'Metformin 500 mg twice daily.',
        citations: ['S1'],
        numbers: [{ value: '500', unit: 'mg' }],
      },
    ]);
    await h.service.buildForEncounter({ tenantId: 'tenant-1', consultationId: 'consult-1', encounterSeq: 1 });
    const call = h.upsert.mock.calls.find((c) => (c[0] as { type: string }).type === 'FACT_LEDGER')!;
    const ledger = JSON.parse((call[0] as { content: string }).content) as FactLedgerV1;
    expect(ledger.facts[0].numbers).toEqual([{ value: '500', unit: 'mg' }]);
  });
});

describe('encounter recap — a stored drifted ledger renders under the D-30/D-31 headings (E2E-29a)', () => {
  it('files the live encounter-1 facts by the kind their key names', () => {
    const ledger: FactLedgerV1 = {
      schema: FACT_LEDGER_SCHEMA,
      consultationId: 'consult-1',
      encounterSeq: 1,
      inputDigest: 'sha256:x',
      sources: [1, 2, 3].map((n) => ({ segmentId: `seg-${n}`, versionNumber: 1, label: `S${n}`, t0Ms: n * 1000 })),
      attachmentSources: [],
      agent: { slug: FACT_LEDGER_AGENT_SLUG, version: 1 },
      model: 'gemma-4-e2b-it-qat',
      createdAt: '2026-10-05T19:34:01.837Z',
      // Stored BEFORE the persist-time repair: the drifted kinds as the live ledger has them.
      facts: LIVE_E1.map((fact, i) => ({
        factId: `E1-F${i + 1}`,
        key: fact.key,
        kind: fact.kind,
        statement: fact.statement,
        critical: false,
        numbers: [],
        aliases: [],
        citations: [`seg-${(i % 3) + 1}`],
      })),
      stats: { segmentCount: 3, attachmentCount: 0, factCount: 6, criticalCount: 0, droppedUncited: 0, droppedInvalid: 0, callCount: 1 },
    };

    const recap = renderEncounterRecap(ledger);
    const lines = Object.fromEntries(recap.sections.map((s) => [s.key, s.lines.map((l) => l.text)]));

    expect(lines.reason).toEqual([LIVE_E1[4].statement]);
    expect(lines.findings).toEqual([LIVE_E1[1].statement]);
    // D-30 keeps allergies with the medicines.
    expect(lines.medicines).toEqual([LIVE_E1[0].statement, LIVE_E1[5].statement]);
    expect(lines.sent_for).toEqual([LIVE_E1[2].statement, LIVE_E1[3].statement]);
    expect(lines.still_open).toEqual([]);
  });
});
