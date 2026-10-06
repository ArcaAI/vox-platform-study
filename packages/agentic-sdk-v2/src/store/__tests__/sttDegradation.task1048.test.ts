/**
 * TASK-1048 — the store keeps the streaming session's ASR warnings and the runtime
 * degradations, de-duplicated by reason, reset whenever a new session starts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { agenticStoreSingleton as useAgenticStore } from '../agenticStore';

const warning = {
  code: 'DIARIZATION_MODEL_MISSING',
  stage: 'diarization',
  severity: 'WARNING',
  message: 'Speaker diarization is off for this session.',
  agentSlug: 'sarvam-diarization',
} as const;

describe('store — ASR session warnings & degradations (TASK-1048)', () => {
  beforeEach(() => {
    useAgenticStore.getState().clearTenantSessionData();
  });

  it('starts empty', () => {
    const s = useAgenticStore.getState();
    expect(s.sttSessionWarnings).toEqual([]);
    expect(s.sttDegradations).toEqual([]);
  });

  it('setSttSessionWarnings stores the warnings and clears prior degradations (new session)', () => {
    const s = useAgenticStore.getState();
    s.addSttDegradation({ reason: 'vad_unavailable', at: 1 });
    s.setSttSessionWarnings([warning]);
    expect(useAgenticStore.getState().sttSessionWarnings).toEqual([warning]);
    expect(useAgenticStore.getState().sttDegradations).toEqual([]);
  });

  it('addSttDegradation de-duplicates by reason, keeping the first', () => {
    const s = useAgenticStore.getState();
    s.addSttDegradation({ reason: 'diarization_unavailable', at: 1, detail: 'a' });
    s.addSttDegradation({ reason: 'diarization_unavailable', at: 2, detail: 'b' });
    s.addSttDegradation({ reason: 'lexicon_unavailable', at: 3 });
    expect(useAgenticStore.getState().sttDegradations).toEqual([
      { reason: 'diarization_unavailable', at: 1, detail: 'a' },
      { reason: 'lexicon_unavailable', at: 3 },
    ]);
  });

  it('a tenant switch wipes both', () => {
    const s = useAgenticStore.getState();
    s.setSttSessionWarnings([warning]);
    s.addSttDegradation({ reason: 'vad_unavailable', at: 1 });
    s.clearTenantSessionData();
    expect(useAgenticStore.getState().sttSessionWarnings).toEqual([]);
    expect(useAgenticStore.getState().sttDegradations).toEqual([]);
  });
});
