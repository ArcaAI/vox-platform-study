import { describe, expect, it, vi } from 'vitest';

import { ContextItemType } from '@arcaai/domains';
import {
  NoteCompositionRequestError,
  NoteInputComposerService,
  NoteInputExceedsContextError,
  NoteModelUnavailableError,
  composeFromSnapshot,
  type NoteCompositionSettings,
  type NoteSourceSnapshot,
} from '../note-input-composer.service';
import { NOTE_PLAN_REDIS_PREFIX, NOTE_PLAN_TTL_SECONDS, notePlanV1Schema, type NotePlanV1 } from '../note-plan.types';
import { estimateCounts, type TokenCountResult } from '../text-token-count.client';
import type { FactLedgerV1 } from '../../fact-ledger/fact-ledger.schema';

const SETTINGS: NoteCompositionSettings = {
  singlePassRatio: 0.6,
  safetyTokens: 512,
  outputTokensPerSection: 384,
  outputOverheadTokens: 256,
  maxCallOutputTokens: 6144,
  maxSectionGroups: 10,
  repairPasses: 1,
};

const SOAP = [
  { key: 'subjective', title: 'Subjective' },
  { key: 'objective', title: 'Objective' },
  { key: 'assessment', title: 'Assessment' },
  { key: 'plan', title: 'Plan' },
];

const exact = async (texts: readonly string[]): Promise<TokenCountResult> => ({ ...estimateCounts(texts), mode: 'exact', id: 'lm-studio:gemma-4-e2b-it-qat' });

const SEG = (n: number) => `0199a000-0000-7000-8000-0000000000${String(50 + n).padStart(2, '0')}`;

function ledger(seq: number, facts: FactLedgerV1['facts'], attachmentSources: FactLedgerV1['attachmentSources'] = []): FactLedgerV1 {
  return {
    schema: 'hope.fact_ledger.v1',
    consultationId: 'c1',
    encounterSeq: seq,
    inputDigest: `sha256:${seq}`,
    sources: [],
    attachmentSources,
    agent: { slug: 'fact-ledger-extraction', version: 1 },
    model: 'gemma-4-e2b-it-qat',
    createdAt: '2026-10-05T00:00:00.000Z',
    facts,
    stats: { segmentCount: 0, attachmentCount: 0, factCount: facts.length, criticalCount: 0, droppedUncited: 0, droppedInvalid: 0, callCount: 1 },
  };
}

function snapshot(overrides: Partial<NoteSourceSnapshot> = {}): NoteSourceSnapshot {
  return {
    consultationId: 'c1',
    tenantId: 't1',
    model: { slug: 'lms-gemma-4-e2b-it-qat', wireModelId: 'gemma-4-e2b-it-qat', provider: 'lm-studio', contextWindow: 32768 },
    headings: SOAP,
    encounters: [
      {
        seq: 1,
        visitType: 'new-visit',
        segments: [
          { id: SEG(1), versionNumber: 1, segmentSeq: 1, speaker: 'doctor', t0Ms: 4000, text: 'What brings you in today?' },
          { id: SEG(2), versionNumber: 1, segmentSeq: 2, speaker: 'patient', t0Ms: 9000, text: 'Chest tightness for two days.\nAnd I am allergic to penicillin.' },
          { id: SEG(3), versionNumber: 1, segmentSeq: 3, speaker: 'doctor', t0Ms: 72000, text: 'You take metformin 500 mg. I am sending you for an ECG and troponin.' },
        ],
        ledger: {
          itemId: 'ledger-1',
          versionNumber: 2,
          ledger: ledger(
            1,
            [
              { factId: 'E1-F1', key: 'allergy:penicillin', kind: 'allergy', statement: 'Allergic to penicillin.', critical: true, numbers: [], aliases: [], citations: [SEG(2)] },
              {
                factId: 'E1-F2',
                key: 'med:metformin',
                kind: 'medication',
                statement: 'Takes metformin 500 mg.',
                critical: true,
                numbers: [{ value: '500', unit: 'mg' }],
                aliases: [],
                citations: [SEG(3)],
              },
              { factId: 'E1-F3', key: 'complaint:chest_tightness', kind: 'complaint', statement: 'Chest tightness for two days.', critical: false, numbers: [], aliases: [], citations: [SEG(2), 'att-1'] },
            ],
            [{ itemId: 'att-1', versionNumber: 1, label: 'A1' }],
          ),
        },
      },
      {
        seq: 2,
        visitType: 're-visit',
        segments: [
          { id: SEG(4), versionNumber: 1, segmentSeq: 4, speaker: 'doctor', t0Ms: 602000, text: 'Your ECG and troponin are normal.' },
          { id: SEG(5), versionNumber: 2, segmentSeq: 5, speaker: 'doctor', t0Ms: 640000, text: 'Increase metformin to 1000 mg twice daily and review in four weeks.' },
        ],
        ledger: {
          itemId: 'ledger-2',
          versionNumber: 1,
          ledger: ledger(2, [
            {
              factId: 'E2-F1',
              key: 'med:metformin',
              kind: 'dose_change',
              statement: 'Metformin increased to 1000 mg twice daily.',
              critical: true,
              numbers: [{ value: '1000', unit: 'mg' }],
              aliases: [],
              citations: [SEG(5)],
              supersedes: ['E1-F2'],
            },
            {
              factId: 'E2-F2',
              key: 'follow_up:review',
              kind: 'follow_up',
              statement: 'Review in four weeks.',
              critical: true,
              numbers: [],
              aliases: ['four weeks'],
              citations: [SEG(5)],
            },
          ]),
        },
      },
    ],
    legacyTranscripts: [],
    preSummary: { itemId: 'pre-1', versionNumber: 1, text: 'Known type 2 diabetes on metformin.' },
    background: [{ key: 'prior_visit_summary', label: 'Prior visit summary (reference only)', text: 'Seen last month for fatigue.' }],
    results: [{ itemId: 'res-1', versionNumber: 1, text: 'Troponin 12 ng/L (normal).' }],
    attachmentTranscripts: [{ itemId: 'att-1', versionNumber: 1, encounterSeq: 1, text: 'Telephone follow-up: blood pressure 150/95 at home.' }],
    draft: null,
    ...overrides,
  };
}

async function compose(snap: NoteSourceSnapshot, extra: Partial<Parameters<typeof composeFromSnapshot>[1]> = {}): Promise<NotePlanV1> {
  return composeFromSnapshot(snap, {
    mode: 'final',
    system: 'You write the clinical case note in English from the sources below. Cite every statement with its source label.',
    settings: SETTINGS,
    counter: exact,
    planId: 'plan-1',
    ...extra,
  });
}

const keys = (plan: NotePlanV1) => plan.blocks.map((block) => block.key);

describe('composeFromSnapshot — inputs, order, labels', () => {
  it('emits the blocks in the fixed order with labelled transcript lines, and the plan parses against the wire schema', async () => {
    const plan = await compose(snapshot());

    expect(notePlanV1Schema.safeParse(plan).success).toBe(true);
    expect(keys(plan)).toEqual(['pre_summary', 'prior_visit_summary', 'encounter_1', 'results', 'attachment_audio', 'encounter_2']);
    expect(plan.blocks.map((block) => block.role)).toEqual([
      'pre_summary',
      'pre_summary',
      'encounter_transcript',
      'results',
      'attachment_transcript',
      'encounter_transcript',
    ]);

    const e1 = plan.blocks.find((block) => block.key === 'encounter_1')!;
    expect(e1.label).toBe('Encounter 1 transcript (new-visit)');
    expect(e1.content.split('\n')).toEqual([
      '[S1 E1 Doctor 00:04] What brings you in today?',
      '[S2 E1 Patient 00:09] Chest tightness for two days. And I am allergic to penicillin.',
      '[S3 E1 Doctor 01:12] You take metformin 500 mg. I am sending you for an ECG and troponin.',
    ]);
    expect(plan.blocks.find((block) => block.key === 'encounter_2')!.content).toContain('[S5 E2 Doctor 10:40] Increase metformin to 1000 mg');
    expect(plan.blocks.find((block) => block.key === 'results')!.content).toBe('[R1] Troponin 12 ng/L (normal).');
    expect(plan.blocks.find((block) => block.key === 'attachment_audio')).toMatchObject({
      role: 'attachment_transcript',
      label: 'Uploaded audio transcripts',
      content: '[A1] Telephone follow-up: blood pressure 150/95 at home.',
    });

    expect(plan.budget.strategy).toBe('single_pass');
    expect(plan.sources.encounters).toEqual([
      { seq: 1, visitType: 'new-visit', segmentCount: 3, rendered: 'verbatim' },
      { seq: 2, visitType: 're-visit', segmentCount: 2, rendered: 'verbatim' },
    ]);
    expect(plan.sources.results).toEqual([{ contextItemId: 'res-1', versionNumber: 1 }]);
    expect(plan.sources.attachmentTranscripts).toEqual([{ contextItemId: 'att-1', versionNumber: 1 }]);
    expect(plan.sources.preSummary).toEqual({ contextItemId: 'pre-1', versionNumber: 1 });
    expect(plan.calls).toEqual([
      expect.objectContaining({ callId: 'c1', sectionKeys: ['subjective', 'objective', 'assessment', 'plan'], directive: 'Write all sections: Subjective, Objective, Assessment, Plan.', maxTokens: 1792 }),
    ]);
    expect(plan.preserve).toBeNull();
    expect(plan.coverage.repairPasses).toBe(1);
    // every block's tokens are counted, never zero for content
    for (const block of plan.blocks) expect(block.tokens).toBeGreaterThan(0);
  });

  it('carries every active critical fact into coverage with anchors, numbers and resolvable citations; superseded facts are not checked', async () => {
    const plan = await compose(snapshot());

    expect(plan.coverage.criticalFacts).toEqual([
      { factId: 'E1-F1', encounterSeq: 1, key: 'allergy:penicillin', kind: 'allergy', anchors: ['penicillin'], numbers: [], citations: ['S2'] },
      { factId: 'E2-F1', encounterSeq: 2, key: 'med:metformin', kind: 'dose_change', anchors: ['metformin'], numbers: [{ value: '1000', unit: 'mg' }], citations: ['S5'] },
      { factId: 'E2-F2', encounterSeq: 2, key: 'follow_up:review', kind: 'follow_up', anchors: ['review', 'four weeks'], numbers: [], citations: ['S5'] },
    ]);
    expect(plan.coverage.sourceIds).toEqual({
      S1: { id: SEG(1), v: 1, kind: 'segment' },
      S2: { id: SEG(2), v: 1, kind: 'segment' },
      S3: { id: SEG(3), v: 1, kind: 'segment' },
      S4: { id: SEG(4), v: 1, kind: 'segment' },
      S5: { id: SEG(5), v: 2, kind: 'segment' },
      R1: { id: 'res-1', v: 1, kind: 'result' },
      A1: { id: 'att-1', v: 1, kind: 'attachment_transcript' },
    });
  });

  it('under pressure covers every encounter: earlier ones as ledger + cited segments (recorded), the last one verbatim — nothing truncated', async () => {
    const long = 'The patient describes the chest tightness in detail. '.repeat(120);
    const snap = snapshot();
    snap.encounters[0].segments.push(
      ...Array.from({ length: 12 }, (_, i) => ({ id: `filler-${i}`, versionNumber: 1, segmentSeq: 100 + i, speaker: 'patient', t0Ms: 80000 + i * 1000, text: long })),
    );
    snap.model = { ...snap.model, contextWindow: 16384 };

    const plan = await compose(snap);

    expect(plan.budget.strategy).toBe('ledger_prior');
    expect(keys(plan)).toEqual(['pre_summary', 'prior_visit_summary', 'encounter_1', 'ledger_1', 'results', 'encounter_2']);
    const e1 = plan.blocks.find((block) => block.key === 'encounter_1')!;
    expect(e1.label).toBe('Encounter 1 — cited segments');
    // only the segments the ledger cites, in transcript order, never a cut line
    expect(e1.content.split('\n').map((line) => line.slice(0, 4))).toEqual(['[S2 ', '[S3 ']);
    expect(e1.content).not.toContain('in detail');
    expect(plan.blocks.find((block) => block.key === 'ledger_1')).toMatchObject({
      role: 'encounter_ledger',
      label: 'Encounter 1 fact ledger',
      content: [
        'E1-F1 allergy: Allergic to penicillin. [S2]',
        'E1-F2 medication: Takes metformin 500 mg. [S3] (superseded by E2-F1)',
        'E1-F3 complaint: Chest tightness for two days. [S2, A1]',
      ].join('\n'),
    });
    // the uploaded audio the E1 ledger covers moved into the ledger; its label still resolves
    expect(keys(plan)).not.toContain('attachment_audio');
    expect(plan.coverage.sourceIds.A1).toEqual({ id: 'att-1', v: 1, kind: 'attachment_transcript' });
    // the last encounter is always verbatim
    expect(plan.blocks.find((block) => block.key === 'encounter_2')!.content.split('\n')).toHaveLength(2);

    expect(plan.sources.encounters[0]).toEqual({ seq: 1, visitType: 'new-visit', segmentCount: 15, ledgerItemId: 'ledger-1', ledgerVersion: 2, rendered: 'ledger_cited' });
    expect(plan.sources.encounters[1].rendered).toBe('verbatim');
    expect(plan.budget.reductions).toEqual([
      expect.objectContaining({ kind: 'prior_encounter_to_ledger', encounterSeq: 1 }),
    ]);
    const [reduction] = plan.budget.reductions;
    expect(reduction.tokensAfter).toBeLessThan(reduction.tokensBefore);
    // every segment of every encounter stays citable
    expect(Object.keys(plan.coverage.sourceIds)).toEqual(expect.arrayContaining(['S1', 'S100', 'S111', 'S4', 'S5']));
  });

  it('fails closed with NOTE_INPUT_EXCEEDS_CONTEXT when the last encounter alone cannot fit', async () => {
    const snap = snapshot();
    snap.encounters[1].segments.push({ id: 'huge', versionNumber: 1, segmentSeq: 6, speaker: 'doctor', t0Ms: 650000, text: 'x '.repeat(40000) });
    await expect(compose(snap)).rejects.toMatchObject({ name: NoteInputExceedsContextError.name, code: 'NOTE_INPUT_EXCEEDS_CONTEXT', contextWindow: 32768 });
  });

  it('records the estimate tokenizer mode when the counter fell back to it', async () => {
    const plan = await compose(snapshot(), { counter: async (texts) => estimateCounts(texts) });
    expect(plan.budget.tokenizer).toEqual({ mode: 'estimate', id: 'estimate:utf8-bytes/2' });
  });

  it('is deterministic, and every section-group call shares the identical block prefix', async () => {
    const headings = Array.from({ length: 30 }, (_, i) => ({ key: `s${i + 1}`, title: `Section ${i + 1}` }));
    const a = await compose(snapshot({ headings }));
    const b = await compose(snapshot({ headings }), { planId: 'plan-2' });

    expect(a.budget.strategy).toBe('section_groups');
    expect(a.calls.length).toBeGreaterThan(1);
    expect(a.calls.length).toBeLessThanOrEqual(10);
    // promptTokens differ only by each call's own directive: the block prefix is one and the same
    const prefixes = a.calls.map((call) => call.promptTokens - Math.ceil(Buffer.byteLength(call.directive, 'utf8') / 2));
    expect(new Set(prefixes).size).toBe(1);
    expect(a.blocks).toEqual(b.blocks);
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.calls.map((c) => c.directive)).toEqual(b.calls.map((c) => c.directive));
    expect(a.calls[0].directive).toMatch(/^Write only these sections: Section 1, /);
  });

  it('reads the legacy single transcript only when the consultation has no segment items', async () => {
    const plan = await compose(
      snapshot({
        encounters: [],
        legacyTranscripts: [{ itemId: 'tx-1', versionNumber: 1, text: 'Doctor: hello. Patient: chest pain.' }],
        attachmentTranscripts: [],
      }),
    );
    expect(keys(plan)).toEqual(['pre_summary', 'prior_visit_summary', 'encounter_1', 'results']);
    expect(plan.blocks.find((block) => block.key === 'encounter_1')!.content).toBe('Doctor: hello. Patient: chest pain.');
    expect(plan.sources.encounters).toEqual([{ seq: 1, visitType: 'unknown', segmentCount: 0, rendered: 'verbatim' }]);
  });
});

describe('composeFromSnapshot — the earlier draft and section regenerate', () => {
  const draft = {
    itemId: 'draft-1',
    versionNumber: 4,
    latestText: '## Subjective\nChest tightness.\n## Objective\nNormal ECG.\n## Assessment\nNon-cardiac chest pain.\n## Plan\nMetformin 1000 mg twice daily; repeat HbA1c.',
    aiText: '## Subjective\nChest tightness.\n## Objective\nNormal ECG.\n## Assessment\nNon-cardiac chest pain.\n## Plan\nMetformin 1000 mg twice daily.',
  };

  it('splits the latest note against its AI version: edited headings are the clinician’s, unchanged ones the AI draft', async () => {
    const plan = await compose(snapshot({ draft }));
    expect(keys(plan).slice(-2)).toEqual(['draft_clinician', 'draft_ai']);
    expect(plan.blocks.find((block) => block.key === 'draft_clinician')).toMatchObject({
      label: 'Clinician-edited sections (keep their meaning)',
      content: 'Plan: Metformin 1000 mg twice daily; repeat HbA1c.',
    });
    expect(plan.blocks.find((block) => block.key === 'draft_ai')).toMatchObject({
      label: 'Previous AI draft',
      content: 'Subjective: Chest tightness.\n\nObjective: Normal ECG.\n\nAssessment: Non-cardiac chest pain.',
    });
    expect(plan.sources.draft).toEqual({ contextItemId: 'draft-1', versionNumber: 4, clinicianSections: ['plan'], aiSections: ['subjective', 'objective', 'assessment'] });
  });

  it('treats every section as the clinician’s when no AI baseline exists', async () => {
    const plan = await compose(snapshot({ draft: { ...draft, aiText: null } }));
    expect(plan.sources.draft!.clinicianSections).toEqual(['subjective', 'objective', 'assessment', 'plan']);
    expect(keys(plan)).not.toContain('draft_ai');
  });

  it('section_regen writes one call for the named sections and preserves the rest of the latest version', async () => {
    const plan = await compose(snapshot({ draft }), { mode: 'section_regen', sectionKeys: ['plan'] });
    expect(plan.mode).toBe('section_regen');
    expect(plan.calls).toEqual([
      expect.objectContaining({ callId: 'r1', sectionKeys: ['plan'], directive: 'Rewrite only this section: Plan.', maxTokens: 1024 }),
    ]);
    expect(plan.preserve).toEqual({ contextItemId: 'draft-1', versionNumber: 4, sectionKeys: ['subjective', 'objective', 'assessment'] });
    expect(notePlanV1Schema.safeParse(plan).success).toBe(true);
  });

  it('refuses a section regenerate with no note to regenerate, or a section the template does not declare', async () => {
    await expect(compose(snapshot(), { mode: 'section_regen', sectionKeys: ['plan'] })).rejects.toMatchObject({
      name: NoteCompositionRequestError.name,
      code: 'NOTE_SECTION_REGEN_NO_DRAFT',
    });
    await expect(compose(snapshot({ draft }), { mode: 'section_regen', sectionKeys: ['nope'] })).rejects.toMatchObject({ code: 'NOTE_SECTION_UNKNOWN' });
    await expect(compose(snapshot({ draft }), { mode: 'section_regen', sectionKeys: [] })).rejects.toMatchObject({ code: 'NOTE_SECTION_UNKNOWN' });
  });
});

// ------------------------------------------------------------------------------------------------
// The service: what it reads, what it never reads, the cache
// ------------------------------------------------------------------------------------------------

interface Item {
  id: string;
  type: ContextItemType;
  content: string | null;
  currentVersionNumber: number;
  encounterSeq?: number | null;
  segmentSeq?: number | null;
  speaker?: string | null;
  t0Ms?: number | null;
  metaData?: Record<string, unknown> | null;
  createdAt: Date;
}

const CANARY = 'RECAP-CANARY-7c1e';

function service(opts: { items: Item[]; contextLength?: number | null; redis?: Map<string, { value: string; ttl: number }> }) {
  const items = opts.items;
  const contextItemRepository = {
    findSegments: vi.fn(async (_cid: string, filters?: { encounterSeq?: number }) =>
      items
        .filter((i) => i.type === ContextItemType.TRANSCRIPT_SEGMENT && (filters?.encounterSeq === undefined || i.encounterSeq === filters.encounterSeq))
        .sort((a, b) => (a.segmentSeq ?? 0) - (b.segmentSeq ?? 0)),
    ),
    findTranscripts: vi.fn(async () => items.filter((i) => i.type === ContextItemType.TRANSCRIPT)),
    findEncounterArtifact: vi.fn(async (_cid: string, type: ContextItemType, seq: number) => items.find((i) => i.type === type && i.encounterSeq === seq) ?? null),
    findAttachments: vi.fn(async () => items.filter((i) => i.type === ContextItemType.ATTACHMENT)),
    findPreSummaries: vi.fn(async () => items.filter((i) => i.type === ContextItemType.PRE_SUMMARY)),
    findByType: vi.fn(async (_cid: string, type: ContextItemType) => items.filter((i) => i.type === type)),
    findByConsultation: vi.fn(async () => items),
    decryptContentFromEntity: vi.fn(),
  };
  const aiModelRepository = {
    findBySlug: vi.fn(async (_tenant: string, slug: string) =>
      slug === 'lms-gemma-4-e2b-it-qat'
        ? {
            slug,
            wireModelId: 'gemma-4-e2b-it-qat',
            provider: 'lm-studio',
            metaData: opts.contextLength === null ? {} : { contextLength: opts.contextLength ?? 32768 },
          }
        : null,
    ),
    findPlatformDefaultsFor: vi.fn(async () => []),
    findByTaskTypeSharedRead: vi.fn(async () => []),
  };
  const redis = opts.redis ?? new Map<string, { value: string; ttl: number }>();
  const redisCache = {
    get: vi.fn(async (key: string) => redis.get(key)?.value ?? null),
    setex: vi.fn(async (key: string, ttl: number, value: string) => void redis.set(key, { value, ttl })),
  };
  const counter = { count: vi.fn(async (texts: readonly string[]) => exact(texts)) };
  const documentTemplates = { resolveForGeneration: vi.fn(async () => ({ compiled: { checklist: SOAP.map((s) => ({ ...s, form: 'PROSE', required: false })) } })) };
  const svc = new NoteInputComposerService(
    contextItemRepository as never,
    aiModelRepository as never,
    counter as never,
    undefined,
    undefined,
    undefined,
    redisCache as never,
    documentTemplates as never,
  );
  return { svc, contextItemRepository, redis, counter };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 9, minute));

function seg(n: number, seq: number, text: string, encounterSeq = 1): Item {
  return { id: SEG(n), type: ContextItemType.TRANSCRIPT_SEGMENT, content: text, currentVersionNumber: 1, encounterSeq, segmentSeq: seq, speaker: 'doctor', t0Ms: seq * 1000, createdAt: at(seq) };
}

describe('NoteInputComposerService', () => {
  const baseItems = (): Item[] => [
    seg(1, 1, 'Start amlodipine 5 mg once daily.'),
    {
      id: 'recap-1',
      type: ContextItemType.ENCOUNTER_RECAP,
      content: JSON.stringify({ schema: 'hope.encounter_recap.v2', sections: [{ key: 'reason', lines: [{ text: CANARY }] }] }),
      currentVersionNumber: 1,
      encounterSeq: 1,
      createdAt: at(5),
    },
    {
      id: 'live-1',
      type: ContextItemType.PRE_SUMMARY,
      content: `Running SOAP ${CANARY}`,
      currentVersionNumber: 3,
      metaData: { subType: 'LIVE_SOAP_SNAPSHOT' },
      createdAt: at(6),
    },
    { id: 'pre-1', type: ContextItemType.PRE_SUMMARY, content: 'Hypertension since 2019.', currentVersionNumber: 1, metaData: null, createdAt: at(0) },
    {
      id: 'aud-1',
      type: ContextItemType.TRANSCRIPT,
      content: 'Phone call: BP 150/95 at home.',
      currentVersionNumber: 1,
      encounterSeq: 1,
      metaData: { origin: 'attachment_audio' },
      createdAt: at(7),
    },
    { id: 'doc-1', type: ContextItemType.ATTACHMENT, content: 'Lab/exam result: ecg.pdf', currentVersionNumber: 1, metaData: { extractedText: 'ECG sinus rhythm.' }, createdAt: at(8) },
  ];

  const request = { tenantId: 't1', consultationId: 'c1', mode: 'final' as const, model: 'lms-gemma-4-e2b-it-qat', system: async () => 'SYSTEM', waitForLedgers: false };

  it('never reads the recap or the live snapshot into a plan (canary)', async () => {
    const { svc } = service({ items: baseItems() });
    const plan = await svc.compose(request);
    expect(JSON.stringify(plan)).not.toContain(CANARY);
    expect(plan.sources.preSummary).toEqual({ contextItemId: 'pre-1', versionNumber: 1 });
    expect(plan.blocks.find((b) => b.key === 'attachment_audio')!.content).toBe('[A1] Phone call: BP 150/95 at home.');
    expect(plan.blocks.find((b) => b.key === 'results')!.content).toBe('[R1] ECG sinus rhythm.');
    // a legacy TRANSCRIPT that is an uploaded-audio transcript is never read as the consultation transcript
    expect(keys(plan).filter((k) => k.startsWith('encounter_'))).toEqual(['encounter_1']);
  });

  it('caches the plan under note-plan:{planId} for two hours and reads it back for the same consultation only', async () => {
    const { svc, redis } = service({ items: baseItems() });
    const plan = await svc.compose(request);
    expect(redis.get(`${NOTE_PLAN_REDIS_PREFIX}${plan.planId}`)).toMatchObject({ ttl: NOTE_PLAN_TTL_SECONDS });
    expect(await svc.loadPlan('t1', 'c1', plan.planId)).toEqual(plan);
    expect(await svc.loadPlan('t2', 'c1', plan.planId)).toBeNull();
    expect(await svc.loadPlan('t1', 'other', plan.planId)).toBeNull();
    expect(await svc.loadRecipe(plan.planId)).toEqual({ consultationId: 'c1', tenantId: 't1', mode: 'final', sectionKeys: [], model: 'lms-gemma-4-e2b-it-qat' });
  });

  it('fails closed when the model row declares no context window — never a default', async () => {
    const { svc } = service({ items: baseItems(), contextLength: null });
    await expect(svc.compose(request)).rejects.toMatchObject({ name: NoteModelUnavailableError.name, code: 'NOTE_MODEL_CONTEXT_UNDECLARED' });
  });

  it('counts every text through the injected counter with the model it plans for', async () => {
    const { svc, counter } = service({ items: baseItems() });
    await svc.compose(request);
    expect(counter.count).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ tenantId: 't1', provider: 'lm-studio', model: 'gemma-4-e2b-it-qat', allowEstimate: true }));
  });
});
