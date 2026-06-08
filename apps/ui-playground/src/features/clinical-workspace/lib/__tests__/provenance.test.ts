/**
 * Unit tests for the provenance → review-data mapper (TASK-330 P3, WS5).
 */
import { describe, it, expect } from 'vitest';
import { coerceCitationsMap, coerceSensorScores, mapProvenanceToReviewData } from '../provenance';
import type { SummaryProvenanceResponse } from '../../types';

const provenance: SummaryProvenanceResponse = {
  contextItemId: 'note-1',
  modelName: 'soap-v1',
  status: 'PENDING_REVIEW',
  sensorScores: { entityFaithfulness: 0.8, coverage: 0.5, schemaValid: 1, citationPresence: 0.9, numericDose: 0.2 },
  citationsMap: {
    claims: [
      {
        id: 'c1',
        text: 'BP 140/90',
        section: 'O',
        status: 'verified',
        confidence: 0.92,
        evidence: [{ transcriptContextItemId: 't1', startOffset: 6, endOffset: 12, quote: '140/90' }],
        entityRefs: ['e1'],
        knowledgeChunkIds: [],
      },
    ],
  },
};

const transcripts = [{ contextItemId: 't1', label: 'Live transcription', text: 'BP is 140/90 today' }];

describe('mapProvenanceToReviewData', () => {
  it('maps claims with their transcript-span evidence (click-to-inspect data)', () => {
    const data = mapProvenanceToReviewData({ provenance, consultationId: 'consult-1', noteContextItemId: 'note-1', transcripts });

    expect(data.consultationId).toBe('consult-1');
    expect(data.noteContextItemId).toBe('note-1');
    expect(data.modelName).toBe('soap-v1');
    expect(data.status).toBe('PENDING_REVIEW');
    expect(data.transcripts).toBe(transcripts);

    const claim = data.citationsMap.claims[0]!;
    expect(claim).toMatchObject({ id: 'c1', section: 'O', status: 'verified' });
    const ev = claim.evidence[0]!;
    expect(ev).toMatchObject({ transcriptContextItemId: 't1', startOffset: 6, endOffset: 12 });
    // The evidence offsets resolve inside the referenced transcript text.
    expect(transcripts[0]!.text.slice(ev.startOffset, ev.endOffset)).toBe('140/90');
  });

  it('passes through sensor scores', () => {
    const data = mapProvenanceToReviewData({ provenance, consultationId: 'c', noteContextItemId: 'n', transcripts });
    expect(data.sensorScores).toEqual({ entityFaithfulness: 0.8, coverage: 0.5, schemaValid: 1, citationPresence: 0.9, numericDose: 0.2 });
  });
});

describe('coerceCitationsMap', () => {
  it('drops malformed claims and evidence rather than trusting them', () => {
    const map = coerceCitationsMap({
      claims: [
        { id: 'ok', text: 'fine', section: 'S', status: 'flagged', confidence: 0.1, evidence: [{ transcriptContextItemId: 't1', startOffset: 0, endOffset: 3 }] },
        { id: 'bad-evidence', text: 't', section: 'A', status: 'verified', evidence: [{ transcriptContextItemId: 't1', startOffset: 5, endOffset: 2 }] },
        { text: 'missing id' },
        null,
      ],
    });
    expect(map.claims).toHaveLength(2);
    expect(map.claims[0]!.evidence).toHaveLength(1);
    // inverted offsets dropped
    expect(map.claims[1]!.evidence).toHaveLength(0);
  });

  it('defaults an unknown section to A and unknown status to unverified', () => {
    const map = coerceCitationsMap({ claims: [{ id: 'x', text: 't', section: 'Z', status: 'weird', evidence: [] }] });
    expect(map.claims[0]).toMatchObject({ section: 'A', status: 'unverified' });
  });

  it('returns an empty claim list for a non-object payload', () => {
    expect(coerceCitationsMap(undefined).claims).toEqual([]);
    expect(coerceCitationsMap('nope').claims).toEqual([]);
  });
});

describe('coerceSensorScores', () => {
  it('returns undefined when scores are absent', () => {
    expect(coerceSensorScores(null)).toBeUndefined();
    expect(coerceSensorScores(undefined)).toBeUndefined();
  });

  it('coerces non-finite values to 0', () => {
    expect(coerceSensorScores({ entityFaithfulness: Number.NaN })).toEqual({
      entityFaithfulness: 0,
      coverage: 0,
      schemaValid: 0,
      citationPresence: 0,
      numericDose: 0,
    });
  });
});
