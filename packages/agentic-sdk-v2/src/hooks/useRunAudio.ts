/**
 * @arcaai/vox — `useRunAudio`: the microphone into a run (TASK-1039).
 *
 * ```tsx
 * // A consultation is open (`session.open(...)`), so the STT session feeds it.
 * const { start, stop, run, audio, isRecording } = useRunAudio({ workflow: 'live-note' });
 *
 * await start({ visitType: 'follow-up' }, { audio: { language: 'en' } });
 * audio.currentTranscript;  // what the STT session is hearing
 * run.text;                 // what the workflow writes from it
 * await stop();             // ends the capture; the run carries on to its end
 * ```
 *
 * ## What it is, and what it is not
 *
 * The capture and the backend STT session are {@link useArcaAudio}'s — `@arcaai/room` capture into
 * the `@arcaai/stt` streaming transport, opened against the gateway — not a second implementation.
 * The browser never runs a model. This hook adds the ORDER and the pairing:
 *
 * 1. the microphone and the STT session open FIRST, so the session is live before the run reads it;
 * 2. then the run starts ({@link useRun}); if it is refused, the microphone is closed again rather
 *    than left lit;
 * 3. {@link UseRunAudioReturn.stop} ends the capture and NEVER cancels the run.
 *
 * ## The limit of the business plane
 *
 * There is no business-plane route that binds a bare STT session to a workflow run: the sandbox
 * start accepts `recording.sttSessionId`, but that route is admin-plane. A workflow run therefore
 * reads live speech through its CONSULTATION — transcripts the STT session writes into the open
 * consultation — and `start` runs the workflow consultation-bound for that reason. With no
 * consultation open the audio is still captured (and shown in `audio.currentTranscript`), but the
 * run reads none of it. An AGENT run is never consultation-bound; feed it the transcript text you
 * have captured as its input.
 */

import { useCallback } from 'react';
import { useAgenticStore } from '../store';
import type { AudioStartOptions } from '../types/audio';
import { useArcaAudio } from './useArcaAudio';
import type { UseArcaAudio } from './useArca';
import { useRun, type StartRunOptions, type UseRunOptions, type UseRunReturn } from './useRun';

/** Options for {@link useRunAudio}: the {@link useRun} options, plus the consultation a workflow run reads. */
export interface UseRunAudioOptions extends UseRunOptions {
  /**
   * The consultation the workflow run reads the live transcript from. It must be the one the
   * microphone feeds — the consultation open in this provider (`session.open`), which is also the
   * default. A different id is refused before the microphone opens.
   */
  consultationId?: string;
}

/** Options for {@link UseRunAudioReturn.start}. */
export interface RunAudioStartOptions extends Omit<StartRunOptions, 'consultationId'> {
  /** Passed to `audio.start`: language, `agentSlug` (the ASR agent), devices, … */
  audio?: AudioStartOptions;
}

export interface UseRunAudioReturn<TInput = Record<string, unknown>, TOutput = unknown> {
  /** The run (text, events, result, status, cancel, …). */
  run: UseRunReturn<TInput, TOutput>;
  /** The capture and STT session (level, `currentTranscript`, `transcriptSegments`, mute, …). */
  audio: UseArcaAudio;
  /** `audio.isCapturing`, named for the screen that shows a record button. */
  isRecording: boolean;
  /** Open the microphone and the STT session, then start the run. Closes the microphone again if the run is refused. */
  start: (input: TInput, options?: RunAudioStartOptions) => Promise<{ runId: string }>;
  /** End the capture and close the STT session. The run is NOT cancelled — `run.cancel()` does that. */
  stop: () => Promise<void>;
}

export function useRunAudio<TInput = Record<string, unknown>, TOutput = unknown>(options: UseRunAudioOptions): UseRunAudioReturn<TInput, TOutput> {
  const { consultationId, ...runOptions } = options;
  const store = useAgenticStore();
  const audio = useArcaAudio();
  const run = useRun<TInput, TOutput>(runOptions);
  const isWorkflow = options.workflow !== undefined;
  const openConsultationId = store.consultation?.id;

  const { start: audioStart, stop: audioStop } = audio;
  const { start: runStart } = run;

  const start = useCallback(
    async (input: TInput, startOptions: RunAudioStartOptions = {}): Promise<{ runId: string }> => {
      const { audio: audioOptions, ...runStartOptions } = startOptions;

      if (isWorkflow && consultationId !== undefined && consultationId !== openConsultationId) {
        throw new Error(
          `useRunAudio: consultation ${consultationId} is not the one the microphone feeds (${openConsultationId ?? 'none is open'}). ` +
            'Open it with `session.open(...)` first — the STT session writes its transcript into the open consultation.',
        );
      }

      await audioStart(audioOptions);
      try {
        return await runStart(input, isWorkflow ? { ...runStartOptions, consultationId: openConsultationId } : runStartOptions);
      } catch (error) {
        await audioStop().catch(() => undefined);
        throw error;
      }
    },
    [audioStart, audioStop, runStart, isWorkflow, consultationId, openConsultationId],
  );

  const stop = useCallback((): Promise<void> => audioStop(), [audioStop]);

  return { run, audio, isRecording: audio.isCapturing, start, stop };
}
