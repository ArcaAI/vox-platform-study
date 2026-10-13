/**
 * The clinic's typed vitals and the readings spoken in the encounter: today's transcript wins.
 *
 * Live failure (cluster, ArcaAI, encounter 1): the client sent the EMR's last vitals set at open
 * (`BP 110/60 · HR 74 … recorded 2025-06-20`), the note plan carried it as `[R1] Measured vitals: …`,
 * and the note's Physical Examination copied it — although the doctor said "Your blood pressure
 * today is 152/94 and your pulse is 88" in the same encounter. Nothing in the plan said which of the
 * two was today's. The R line now names the readings the LATEST encounter's transcript states, with
 * the line that states them, so both are carried with their provenance and the spoken one is marked
 * as the one for this encounter. An earlier encounter of the same consultation is the same visit:
 * a vital the latest encounter does not state is taken from the most recent one that does.
 */
import { describe, expect, it, vi } from 'vitest';

import { ContextItemType } from '@arcaai/domains';
import { NoteInputComposerService, composeFromSnapshot, type NoteCompositionSettings, type NoteSourceSnapshot } from '../note-input-composer.service';
import { estimateCounts, type TokenCountResult } from '../text-token-count.client';

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
];
const exact = async (texts: readonly string[]): Promise<TokenCountResult> => ({ ...estimateCounts(texts), mode: 'exact', id: 'lm-studio:gemma' });

const CLINIC_VITALS = 'Measured vitals: BP 110/60 mmHg · HR 74 bpm · RR 18 /min · Temp 97.8 °F · SpO2 98 % · recorded 2025-06-20';

function snapshot(segments: Array<{ seq: number; text: string; encounterSeq?: number }>, clinicVitals = true): NoteSourceSnapshot {
  const encounters = [...new Set(segments.map((s) => s.encounterSeq ?? 1))].map((seq) => ({
    seq,
    visitType: seq === 1 ? 'new-visit' : 're-visit',
    segments: segments
      .filter((s) => (s.encounterSeq ?? 1) === seq)
      .map((s) => ({ id: `seg-${s.seq}`, versionNumber: 1, segmentSeq: s.seq, speaker: 'doctor', t0Ms: s.seq * 1000, text: s.text })),
    ledger: null,
  }));
  return {
    consultationId: 'c1',
    tenantId: 't1',
    model: { slug: 'gemma', wireModelId: 'gemma', provider: 'lm-studio', contextWindow: 32768 },
    headings: SOAP,
    encounters,
    legacyTranscripts: [],
    preSummary: null,
    background: [],
    results: [
      { itemId: 'cn-1', versionNumber: 1, text: 'Case note: BP 140/90 last week.' },
      { itemId: 'vitals-item', versionNumber: 1, text: CLINIC_VITALS, ...(clinicVitals ? { clinicVitals: true } : {}) },
    ],
    attachmentTranscripts: [],
    draft: null,
  };
}

async function resultsBlock(snap: NoteSourceSnapshot): Promise<string> {
  const plan = await composeFromSnapshot(snap, { mode: 'final', system: 'SYSTEM', settings: SETTINGS, counter: exact, planId: 'plan-1' });
  return plan.blocks.find((block) => block.role === 'results')?.content ?? '';
}

describe('clinic vitals vs the readings spoken in the encounter', () => {
  it('marks the readings the latest encounter states as the ones for this encounter, citing their line', async () => {
    const content = await resultsBlock(
      snapshot([
        { seq: 1, text: 'Good morning, what brings you in?' },
        { seq: 2, text: 'Your blood pressure today is 152/94 and your pulse is 88. Temperature 98.6.' },
      ]),
    );
    const line = content.split('\n').find((l) => l.startsWith('[R2]')) ?? '';

    // The clinic reading is still there, with its date…
    expect(line).toContain('BP 110/60 mmHg');
    expect(line).toContain('recorded 2025-06-20');
    // …and today's readings, each with the transcript line that states it.
    expect(line).toContain('BP 152/94 mmHg [S2 E1]');
    expect(line).toContain('HR 88 bpm [S2 E1]');
    expect(line).toContain('Temp 98.6 °F [S2 E1]');
    expect(line).toMatch(/supersede/i);
    // A reading the encounter does not state stays the clinic's alone.
    expect(line).not.toMatch(/SpO2 \d+ % \[S/);
    // Only the clinic's vitals line is annotated.
    expect(content).toContain('[R1] Case note: BP 140/90 last week.');
  });

  it('an earlier encounter’s reading still supersedes the clinic set when the latest states none', async () => {
    const content = await resultsBlock(
      snapshot([
        { seq: 1, text: 'Your blood pressure is 150 over 95.', encounterSeq: 1 },
        { seq: 2, text: 'Your sugars are high.', encounterSeq: 2 },
      ]),
    );
    const line = content.split('\n').find((l) => l.startsWith('[R2]')) ?? '';
    expect(line).toContain(CLINIC_VITALS);
    expect(line).toContain("encounter 1's transcript states BP 150/95 mmHg [S1 E1]");
    expect(line).toMatch(/supersede/i);
  });

  it('leaves the line untouched when the encounter states no reading', async () => {
    const content = await resultsBlock(snapshot([{ seq: 1, text: 'Any allergies? Penicillin.' }]));
    expect(content).toContain(`[R2] ${CLINIC_VITALS}`);
  });

  it('never annotates a result that is not the clinic vitals', async () => {
    const content = await resultsBlock(snapshot([{ seq: 1, text: 'Your blood pressure today is 152/94.' }], false));
    expect(content).toContain(`[R2] ${CLINIC_VITALS}`);
  });
});

describe('NoteInputComposerService — the clinic vitals result is recognised by its item', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 9, minute));
  const segment = {
    id: 's1',
    type: ContextItemType.TRANSCRIPT_SEGMENT,
    content: 'Your blood pressure today is 152/94.',
    currentVersionNumber: 1,
    encounterSeq: 1,
    segmentSeq: 1,
    speaker: 'doctor',
    t0Ms: 1000,
    createdAt: at(1),
  };

  function service(vitalsItemId: string | null) {
    const contextItemRepository = {
      findSegments: vi.fn(async () => [segment]),
      findTranscripts: vi.fn(async () => []),
      findEncounterArtifact: vi.fn(async () => null),
      findAttachments: vi.fn(async () => []),
      findPreSummaries: vi.fn(async () => []),
      findByType: vi.fn(async () => []),
      findByConsultation: vi.fn(async () => [segment]),
      findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) => (kindKey === 'vitals' && vitalsItemId ? { id: vitalsItemId } : null)),
      decryptContentFromEntity: vi.fn(),
    };
    const aiModelRepository = {
      findBySlug: vi.fn(async (_t: string, slug: string) => ({
        slug,
        wireModelId: 'gemma',
        provider: 'lm-studio',
        metaData: { contextLength: 32768 },
      })),
      findPlatformDefaultsFor: vi.fn(async () => []),
      findByTaskTypeSharedRead: vi.fn(async () => []),
    };
    const documentTemplates = {
      resolveForGeneration: vi.fn(async () => ({ compiled: { checklist: SOAP.map((s) => ({ ...s, form: 'PROSE', required: false })) } })),
    };
    return new NoteInputComposerService(
      contextItemRepository as never,
      aiModelRepository as never,
      { count: vi.fn(async (texts: readonly string[]) => exact(texts)) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      documentTemplates as never,
      { getVersionsByChangeReason: vi.fn(async () => []) } as never,
    );
  }

  const compose = (svc: NoteInputComposerService, itemId: string) =>
    svc.compose({
      tenantId: 't1',
      consultationId: 'c1',
      mode: 'final',
      model: 'gemma',
      system: 'SYSTEM',
      waitForLedgers: false,
      cache: false,
      extras: { background: [], results: [{ itemId, versionNumber: 1, text: 'Measured vitals: BP 110/60 mmHg · recorded 2025-06-20' }] },
    });

  it('by the latest vitals item id', async () => {
    const { plan } = await compose(service('vitals-item'), 'vitals-item');
    expect(JSON.stringify(plan.blocks)).toContain('BP 152/94 mmHg [S1 E1]');
  });

  it('by the fallback id the harness uses when the item is unreadable', async () => {
    const { plan } = await compose(service(null), 'c1:vitals');
    expect(JSON.stringify(plan.blocks)).toContain('BP 152/94 mmHg [S1 E1]');
  });

  it('not by any other result', async () => {
    const { plan } = await compose(service('vitals-item'), 'case-note-1');
    expect(JSON.stringify(plan.blocks)).not.toMatch(/supersede/i);
  });
});
