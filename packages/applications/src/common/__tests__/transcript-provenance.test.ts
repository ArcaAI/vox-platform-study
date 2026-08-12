import { describe, it, expect } from 'vitest';

import { isSttAggregateTranscript, STT_AGGREGATE_SUBTYPE, TRANSCRIPT_SEGMENT_SUBTYPE } from '../transcript-provenance';

const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

describe('isSttAggregateTranscript', () => {
  it('recognises a row stamped with the aggregate marker', () => {
    expect(isSttAggregateTranscript({ metaData: { subType: STT_AGGREGATE_SUBTYPE }, createdBy: 'user-1' })).toBe(true);
  });

  it('rejects a per-utterance SDK row', () => {
    expect(isSttAggregateTranscript({ metaData: { subType: TRANSCRIPT_SEGMENT_SUBTYPE }, createdBy: 'user-1' })).toBe(false);
  });

  it('rejects an unmarked row authored by a real user (client write)', () => {
    expect(isSttAggregateTranscript({ metaData: null, createdBy: 'user-1' })).toBe(false);
  });

  it('accepts an unmarked, user-less row — a legacy aggregate written before the marker existed', () => {
    expect(isSttAggregateTranscript({ metaData: null, createdBy: null })).toBe(true);
    expect(isSttAggregateTranscript({})).toBe(true);
    expect(isSttAggregateTranscript({ createdBy: SYSTEM_USER_ID })).toBe(true);
  });

  it('rejects any other subType marker', () => {
    expect(isSttAggregateTranscript({ metaData: { subType: 'LAB_RESULT' } })).toBe(false);
  });
});
