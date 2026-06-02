/**
 * TASK-329 P3 — audio store STT task state + persisted-selection resolution.
 *
 * - `sttTask` (transcribe|translate) defaults to 'transcribe', is settable, and
 *   resets with the rest of the store.
 * - `applyPersistedSelection` layers the USER's persisted choice on top of the
 *   tenant/default already seeded into the store (USER → TENANT → DEFAULT), only
 *   accepting a model that is actually in the available (browser-viable) set.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAudioStore } from '@/store/audio-store';

describe('TASK-329 P3 — audio store STT task', () => {
  beforeEach(() => {
    useAudioStore.getState().reset();
  });

  it('defaults sttTask to transcribe', () => {
    expect(useAudioStore.getState().sttTask).toBe('transcribe');
  });

  it('setSttTask updates the task', () => {
    useAudioStore.getState().setSttTask('translate');
    expect(useAudioStore.getState().sttTask).toBe('translate');
  });

  it('reset restores sttTask to transcribe', () => {
    useAudioStore.getState().setSttTask('translate');
    useAudioStore.getState().reset();
    expect(useAudioStore.getState().sttTask).toBe('transcribe');
  });
});

describe('TASK-329 P3 — applyPersistedSelection (USER over TENANT/DEFAULT)', () => {
  beforeEach(() => {
    useAudioStore.getState().reset();
    // initial store: whisperModel = whisper-tiny, available = tiny/base/small
  });

  it('applies a valid user model + task over the seeded tenant/default', () => {
    useAudioStore.getState().applyPersistedSelection({ userModelId: 'whisper-small', userTask: 'translate' });
    expect(useAudioStore.getState().whisperModel).toBe('whisper-small');
    expect(useAudioStore.getState().sttTask).toBe('translate');
  });

  it('keeps the tenant/default model when the user model is not available', () => {
    useAudioStore.getState().applyPersistedSelection({ userModelId: 'whisper-medium' });
    expect(useAudioStore.getState().whisperModel).toBe('whisper-tiny');
  });

  it('normalizes a bare user model id (small -> whisper-small)', () => {
    useAudioStore.getState().applyPersistedSelection({ userModelId: 'small' });
    expect(useAudioStore.getState().whisperModel).toBe('whisper-small');
  });

  it('defaults task to transcribe when the user has no persisted task', () => {
    useAudioStore.getState().setSttTask('translate');
    useAudioStore.getState().reset();
    useAudioStore.getState().applyPersistedSelection({ userModelId: 'whisper-base' });
    expect(useAudioStore.getState().sttTask).toBe('transcribe');
  });
});
