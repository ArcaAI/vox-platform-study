/**
 * @arcaai/vox — `useRunAudio`: the microphone into a run (TASK-1039, standalone mode TASK-1042).
 *
 * ```tsx
 * // 1) STANDALONE — no consultation is open. The STT session is bound to the workflow itself.
 * const { start, stop, run, audio, isRecording } = useRunAudio({ workflow: 'live-note' });
 * await start({ visitType: 'follow-up' }, { audio: { language: 'en' } });
 * //   ^ opens the mic + an STT session bound to 'live-note', then starts the run with
 * //     input.<audioField> = { sttSessionId }
 * audio.currentTranscript;  // what the STT session is hearing
 * run.text;                 // what the workflow writes from it
 * await stop();             // ends the audio; the run carries on to its end
 *
 * // 2) CONSULTATION-BOUND — `session.open(...)` already ran, so the STT session feeds that
 * //    consultation and the run reads the consultation's transcript. (Unchanged.)
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
 * ## The two modes
 *
 * **Standalone (no consultation open).** The workflow's Input shape must declare a live-audio
 * (stream-delivery) kind, and its settings the `socket` connection. `start` then:
 *
 * - resolves `audioField` — the `audioField` option, else the single Input key of
 *   `GET workflows/:slug/schema` whose schema is the stream-audio payload (an object whose only
 *   property is `sttSessionId`). Zero or several such keys throw {@link RunAudioFieldError}
 *   BEFORE the microphone or any session is requested;
 * - opens the microphone and an STT session created with `workflowSlug` (never a consultation);
 * - starts the run with `{ ...input, [audioField]: { sttSessionId } }`.
 *
 * The gateway can refuse the run start with a coded error, which reaches the caller (and
 * `run.error`) unchanged, after the microphone is closed again: 400 `RUN_AUDIO_INPUT_UNDECLARED`,
 * `RUN_AUDIO_MULTIPLE`, `LIVE_AUDIO_UNSUPPORTED`; 409 `RUN_AUDIO_SESSION_NOT_LIVE`,
 * `RUN_AUDIO_SESSION_BOUND_ELSEWHERE`, `RUN_AUDIO_AGENT_MISMATCH`; 404 for a session that is
 * unknown, another tenant's, or another principal's.
 *
 * **Consultation-bound (a consultation is open).** The STT session writes its transcript into the
 * open consultation and `start` runs the workflow bound to it, exactly as before TASK-1042.
 *
 * An AGENT run is never audio-bound; feed it the transcript text you have captured as its input.
 *
 * **Ending the audio never cancels the run.** `stop()` finalizes and closes the STT session; the
 * run carries on to its result. `run.cancel()` is the only way to stop a run.
 */

import { useCallback } from 'react';
import { useAgenticStore } from '../store';
import type { AudioStartOptions } from '../types/audio';
import { useArcaAudio } from './useArcaAudio';
import type { UseArcaAudio } from './useArca';
import { WORKFLOW_ENDPOINTS } from '../core/constants';
import type { WorkflowSchemaDescription } from '../types/workflowRun';
import { useRun, type StartRunOptions, type UseRunOptions, type UseRunReturn } from './useRun';

/**
 * Thrown by {@link UseRunAudioReturn.start}, before the microphone or any session is requested,
 * when a standalone run's audio Input key cannot be decided: the workflow declares no live-audio
 * Input, or several (pass `audioField` to choose one).
 */
export class RunAudioFieldError extends Error {
  /** The live-audio Input keys the workflow declares (empty when none). */
  readonly candidates: readonly string[];

  constructor(message: string, candidates: readonly string[] = []) {
    super(message);
    this.name = 'RunAudioFieldError';
    this.candidates = candidates;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stream-audio payload schema: an object whose ONLY declared property is `sttSessionId`, a string. */
function isStreamAudioSchema(schema: unknown): boolean {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return false;
  const keys = Object.keys(schema.properties);
  const session = schema.properties.sttSessionId;
  return keys.length === 1 && keys[0] === 'sttSessionId' && isPlainObject(session) && session.type === 'string';
}

function resolveStreamAudioField(slug: string, description: WorkflowSchemaDescription | null): string {
  const components = description?.components ?? {};
  const inputName = Object.keys(components).find((name) => name.endsWith('_Input'));
  const input = inputName === undefined ? undefined : components[inputName];
  const properties = isPlainObject(input) && isPlainObject(input.properties) ? input.properties : {};
  const candidates = Object.keys(properties).filter((key) => isStreamAudioSchema(properties[key]));

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new RunAudioFieldError(
      `Workflow "${slug}" declares no live-audio Input (a stream-delivery audio kind), so there is nowhere to put the STT session.`,
    );
  }
  throw new RunAudioFieldError(
    `Workflow "${slug}" declares several live-audio Inputs (${candidates.join(', ')}); pass \`audioField\` to choose one.`,
    candidates,
  );
}

/** Options for {@link useRunAudio}: the {@link useRun} options, plus the consultation a workflow run reads. */
export interface UseRunAudioOptions extends UseRunOptions {
  /**
   * Standalone mode only (no consultation open): the Input key that takes `{ sttSessionId }`.
   * Default: the single live-audio key of the workflow's published Input shape
   * (`GET workflows/:slug/schema`); zero or several throw {@link RunAudioFieldError}.
   */
  audioField?: string;
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
  const { consultationId, audioField: audioFieldOption, ...runOptions } = options;
  const store = useAgenticStore();
  const audio = useArcaAudio();
  const run = useRun<TInput, TOutput>(runOptions);
  const isWorkflow = options.workflow !== undefined;
  const openConsultationId = store.consultation?.id;

  const fetchSchema = useCallback(
    async (slug: string): Promise<WorkflowSchemaDescription | null> => {
      const client = store.apiClient;
      if (!client) throw new Error('SDK not initialized');
      return client.get<WorkflowSchemaDescription>(WORKFLOW_ENDPOINTS.SCHEMA(slug));
    },
    [store],
  );

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

      // STANDALONE (TASK-1042): no consultation is open, so the STT session is bound to the
      // workflow itself and the run is started carrying its id.
      if (isWorkflow && openConsultationId === undefined) {
        const slug = options.workflow as string;
        // Decide the field FIRST: a workflow that cannot take live audio must not light the mic.
        const audioField = audioFieldOption ?? resolveStreamAudioField(slug, await fetchSchema(slug));
        await audioStart({ ...audioOptions, workflowSlug: slug });
        try {
          const sttSessionId = readSttSessionId(store);
          if (sttSessionId === null) throw new Error('useRunAudio: the STT session did not open, so there is nothing to bind the run to.');
          return await runStart({ ...input, [audioField]: { sttSessionId } } as TInput, runStartOptions);
        } catch (error) {
          await audioStop().catch(() => undefined);
          throw error;
        }
      }

      await audioStart(audioOptions);
      try {
        return await runStart(input, isWorkflow ? { ...runStartOptions, consultationId: openConsultationId } : runStartOptions);
      } catch (error) {
        await audioStop().catch(() => undefined);
        throw error;
      }
    },
    [audioStart, audioStop, runStart, isWorkflow, consultationId, openConsultationId, audioFieldOption, options.workflow, fetchSchema, store],
  );

  const stop = useCallback((): Promise<void> => audioStop(), [audioStop]);

  return { run, audio, isRecording: audio.isCapturing, start, stop };
}

/** The id of the STT session the capture just opened, read the way `useArcaAudio.switchProvider` reads it. */
function readSttSessionId(store: { pluginManager?: unknown }): string | null {
  const pluginManager = store.pluginManager as
    | { getTranscriptionPipeline?: () => { getStreamingSessionManager?: () => { getSessionId?: () => string | null } | null } | null }
    | null
    | undefined;
  return pluginManager?.getTranscriptionPipeline?.()?.getStreamingSessionManager?.()?.getSessionId?.() ?? null;
}
