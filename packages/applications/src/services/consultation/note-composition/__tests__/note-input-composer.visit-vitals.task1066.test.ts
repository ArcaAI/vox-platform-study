/**
 * The readings that supersede the clinic's vitals set are the VISIT's: each vital from the most
 * recent encounter of the consultation whose transcript states it.
 *
 * Live failure (cluster, ArcaAI, encounter 2 of consultation 01a13368…): the doctor said "Your
 * blood pressure today is 152/94 and your pulse is 88" in encounter 1 (S17); encounter 2 (a results
 * review minutes later) stated no vital, so the encounter-2 note prompt carried the clinic's
 * 2025-06-20 set with no supersession at all, and the note stated only that set.
 */
import { describe, expect, it } from 'vitest';

import { composeFromSnapshot, type NoteCompositionSettings, type NoteSourceSnapshot } from '../note-input-composer.service';
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
const exact = async (texts: readonly string[]): Promise<TokenCountResult> => ({ ...estimateCounts(texts), mode: 'exact', id: 'lm-studio:gemma' });

/** The clinic line as the live run rendered it. */
const CLINIC_VITALS =
  'Measured vitals: BP 110/60 mmHg · HR 74 bpm · RR 18 /min · Temp 97.8 °F · SpO2 98 % · Wt 77.5 kg · Ht 163 cm · Pain 0/10 · recorded 2025-06-20';

function snapshot(segments: Array<{ seq: number; encounterSeq: number; text: string }>): NoteSourceSnapshot {
  const encounters = [...new Set(segments.map((s) => s.encounterSeq))].map((seq) => ({
    seq,
    visitType: seq === 1 ? 'new-visit' : 'revisit',
    segments: segments
      .filter((s) => s.encounterSeq === seq)
      .map((s) => ({ id: `seg-${s.seq}`, versionNumber: 1, segmentSeq: s.seq, speaker: 'Unknown', t0Ms: s.seq * 1000, text: s.text })),
    ledger: null,
  }));
  return {
    consultationId: 'c1',
    tenantId: 't1',
    model: { slug: 'gemma', wireModelId: 'gemma', provider: 'lm-studio', contextWindow: 32768 },
    headings: [{ key: 'clinical_examination_updates', title: 'Clinical Examination Updates' }],
    encounters,
    legacyTranscripts: [],
    preSummary: null,
    background: [],
    results: [{ itemId: 'vitals-item', versionNumber: 1, text: CLINIC_VITALS, clinicVitals: true }],
    attachmentTranscripts: [],
    draft: null,
  };
}

async function vitalsLine(snap: NoteSourceSnapshot): Promise<string> {
  const plan = await composeFromSnapshot(snap, { mode: 'final', system: 'SYSTEM', settings: SETTINGS, counter: exact, planId: 'plan-1' });
  const results = plan.blocks.find((block) => block.role === 'results')?.content ?? '';
  return results.split('\n').find((line) => line.startsWith('[R1]')) ?? '';
}

/** The live encounter 1 (S16–S18) and encounter 2 (S31–S36) lines. */
const ENCOUNTER_1 = [
  { seq: 16, encounterSeq: 1, text: 'My father had a heart attack at 60. I stopped smoking five years ago' },
  { seq: 17, encounterSeq: 1, text: 'Your blood pressure today is 152/94 and your pulse is 88' },
  { seq: 18, encounterSeq: 1, text: 'I am going to order an ECG, a troponin test' },
];
const ENCOUNTER_2 = [
  { seq: 31, encounterSeq: 2, text: 'Welcome back' },
  { seq: 32, encounterSeq: 2, text: 'Your ECG is normal and the troponin is negative' },
  { seq: 35, encounterSeq: 2, text: 'Your HbA1c is 8.2, so I am increasing Metformin to 1000mg/d/ -twice daily' },
  { seq: 36, encounterSeq: 2, text: 'Continue Amlodipine 10mg. review in 4 weeks' },
];

describe('the clinic vitals line is superseded by the visit’s spoken readings', () => {
  it('encounter 2 states none: encounter 1’s reading supersedes, named as encounter 1’s', async () => {
    const line = await vitalsLine(snapshot([...ENCOUNTER_1, ...ENCOUNTER_2]));

    expect(line).toContain(CLINIC_VITALS);
    expect(line).toContain("encounter 1's transcript states BP 152/94 mmHg [S17 E1], HR 88 bpm [S17 E1]");
    expect(line).toMatch(/supersede/i);
    expect(line).not.toContain("this encounter's transcript");
  });

  it('each vital from the most recent encounter that states it', async () => {
    const line = await vitalsLine(snapshot([...ENCOUNTER_1, ...ENCOUNTER_2, { seq: 37, encounterSeq: 2, text: 'Your BP now is 138/86' }]));

    expect(line).toContain("this encounter's transcript states BP 138/86 mmHg [S37 E2]");
    expect(line).toContain("encounter 1's transcript states HR 88 bpm [S17 E1]");
    expect(line).not.toContain('152/94');
  });

  it('a reading of the latest encounter is still "this encounter’s"', async () => {
    const line = await vitalsLine(snapshot(ENCOUNTER_1));

    expect(line).toContain("this encounter's transcript states BP 152/94 mmHg [S17 E1], HR 88 bpm [S17 E1], which supersede it");
    expect(line).not.toContain("encounter 1's transcript");
  });

  it('no encounter states a reading: the clinic line is unchanged', async () => {
    const line = await vitalsLine(snapshot(ENCOUNTER_2));

    expect(line).toBe(`[R1] ${CLINIC_VITALS}`);
  });
});
