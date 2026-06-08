/**
 * Clinical workspace flow state machine (TASK-330 P3, WS4).
 *
 * Drives the guided cockpit lifecycle:
 *   launch → ready (consultation open) → recording → stopped
 * The capture/consultation ids and the live-summary SSE URL travel with the
 * state so the cockpit panels and the review tab stay in lockstep. Invalid
 * transitions are ignored (return the previous state) so a double-click or a
 * stray event can never corrupt the flow.
 *
 * Pure + dependency-free → unit-testable on its own.
 */
import type { RecordingStateResponse } from '../types';

export type FlowStage = 'launch' | 'ready' | 'recording' | 'stopped';

export interface FlowState {
  stage: FlowStage;
  consultationId: string | null;
  sessionId: string | null;
  recording: boolean;
  /** Authenticated live-summary SSE URL returned by the start endpoint. */
  sseUrl: string | null;
  /** Context-item id of the auto-drafted note once review is reachable. */
  noteContextItemId: string | null;
  error: string | null;
}

export const initialFlowState: FlowState = {
  stage: 'launch',
  consultationId: null,
  sessionId: null,
  recording: false,
  sseUrl: null,
  noteContextItemId: null,
  error: null,
};

export type FlowAction =
  | { type: 'CONSULTATION_OPENED'; consultationId: string }
  | { type: 'RECORDING_STARTED'; state: RecordingStateResponse }
  | { type: 'RECORDING_STOPPED'; state: RecordingStateResponse }
  | { type: 'NOTE_READY'; noteContextItemId: string }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' };

export function clinicalFlowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'CONSULTATION_OPENED':
      // (Re)opening a consultation resets the downstream capture state.
      return {
        ...initialFlowState,
        stage: 'ready',
        consultationId: action.consultationId,
      };

    case 'RECORDING_STARTED':
      if (state.stage !== 'ready' && state.stage !== 'stopped') return state;
      return {
        ...state,
        stage: 'recording',
        recording: true,
        sessionId: action.state.sessionId ?? state.sessionId,
        sseUrl: action.state.sseUrl ?? state.sseUrl,
        error: null,
      };

    case 'RECORDING_STOPPED':
      if (state.stage !== 'recording') return state;
      return { ...state, stage: 'stopped', recording: false };

    case 'NOTE_READY':
      return { ...state, noteContextItemId: action.noteContextItemId };

    case 'ERROR':
      return { ...state, error: action.message };

    case 'RESET':
      return initialFlowState;

    default:
      return state;
  }
}

/** The review tab is reachable once capture has stopped or a draft note exists. */
export function canReview(state: FlowState): boolean {
  return state.stage === 'stopped' || state.noteContextItemId !== null;
}
