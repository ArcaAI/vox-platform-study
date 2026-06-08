/**
 * Unit tests for the cockpit flow state machine (TASK-330 P3, WS4).
 */
import { describe, it, expect } from 'vitest';
import { clinicalFlowReducer, initialFlowState, canReview, type FlowState } from '../flow';
import type { RecordingStateResponse } from '../../types';

const recordingState = (over: Partial<RecordingStateResponse> = {}): RecordingStateResponse => ({
  consultationId: 'c1',
  status: 'RECORDING',
  recording: true,
  sessionId: 'sess-1',
  sseUrl: 'http://api/consultations/c1/live-summary/stream',
  updatedAt: 't',
  ...over,
});

describe('clinicalFlowReducer — happy-path cockpit flow', () => {
  it('walks launch → ready → recording → stopped', () => {
    let state = initialFlowState;
    expect(state.stage).toBe('launch');

    state = clinicalFlowReducer(state, { type: 'CONSULTATION_OPENED', consultationId: 'c1' });
    expect(state).toMatchObject({ stage: 'ready', consultationId: 'c1', recording: false });

    state = clinicalFlowReducer(state, { type: 'RECORDING_STARTED', state: recordingState() });
    expect(state).toMatchObject({ stage: 'recording', recording: true, sessionId: 'sess-1' });
    expect(state.sseUrl).toContain('/live-summary/stream');

    state = clinicalFlowReducer(state, { type: 'RECORDING_STOPPED', state: recordingState({ status: 'STOPPED', recording: false }) });
    expect(state).toMatchObject({ stage: 'stopped', recording: false });
    // ids carried through so review can load.
    expect(state.consultationId).toBe('c1');
    expect(canReview(state)).toBe(true);
  });
});

describe('clinicalFlowReducer — guards', () => {
  it('ignores RECORDING_STARTED before a consultation is open', () => {
    const next = clinicalFlowReducer(initialFlowState, { type: 'RECORDING_STARTED', state: recordingState() });
    expect(next).toBe(initialFlowState);
  });

  it('ignores RECORDING_STOPPED when not recording', () => {
    const ready: FlowState = { ...initialFlowState, stage: 'ready', consultationId: 'c1' };
    expect(clinicalFlowReducer(ready, { type: 'RECORDING_STOPPED', state: recordingState() })).toBe(ready);
  });

  it('allows re-recording from the stopped stage', () => {
    const stopped: FlowState = { ...initialFlowState, stage: 'stopped', consultationId: 'c1' };
    const next = clinicalFlowReducer(stopped, { type: 'RECORDING_STARTED', state: recordingState() });
    expect(next.stage).toBe('recording');
  });

  it('reopening a consultation resets downstream capture state', () => {
    const recording: FlowState = { ...initialFlowState, stage: 'recording', consultationId: 'c1', recording: true, sessionId: 's' };
    const next = clinicalFlowReducer(recording, { type: 'CONSULTATION_OPENED', consultationId: 'c2' });
    expect(next).toMatchObject({ stage: 'ready', consultationId: 'c2', recording: false, sessionId: null });
  });
});

describe('canReview', () => {
  it('is true once a draft note id is known even before stopping', () => {
    const recording: FlowState = { ...initialFlowState, stage: 'recording', noteContextItemId: 'note-1' };
    expect(canReview(recording)).toBe(true);
  });

  it('is false in launch/ready with no note', () => {
    expect(canReview(initialFlowState)).toBe(false);
    expect(canReview({ ...initialFlowState, stage: 'ready' })).toBe(false);
  });
});
