/**
 * `hope.workflows.runWithAudio` — live audio into a STANDALONE workflow run (TASK-1042).
 *
 * The order is the contract, and every step before the run is undone if a later one fails:
 *
 * 1. resolve the Input key that carries the audio (explicit `audioField`, else the single
 *    stream-audio key of the published Input shape) — BEFORE any session exists;
 * 2. `stt.createStreamSession({ workflowSlug, … })` — the session is bound to the workflow, never
 *    to a consultation (C1);
 * 3. open the socket;
 * 4. start the run with `input[audioField] = { sttSessionId }` (C2).
 *
 * Ending the audio is `finalize()` (flush the tail, then close the session) or `close()` (abort
 * it). Neither cancels the run: the run carries on to its result (C4).
 *
 * This module holds the orchestration over small injected dependencies, so it is testable
 * without a socket or HTTP; `WorkflowsResource.runWithAudio` supplies the real ones. Zero runtime
 * dependencies, and `globalThis.WebSocket` only (the socket raises `SocketUnavailableError`).
 */

import { NotFoundError } from './errors';
import type { StreamSessionResponse, CreateStreamSessionRequest } from '../types/stt';
import type { WorkflowSchemaDescription } from '../types/workflow';

/** Thrown, before any session or microphone request, when the audio's Input key cannot be decided. */
export class RunAudioFieldError extends Error {
  /** The stream-audio keys the Input shape declares (empty when none). */
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
  if (keys.length !== 1 || keys[0] !== 'sttSessionId') return false;
  const session = schema.properties.sttSessionId;
  return isPlainObject(session) && session.type === 'string';
}

/**
 * The one Input key of a published workflow that takes live audio. Reads the `…_Input` component
 * of `GET workflows/:slug/schema`. Throws {@link RunAudioFieldError} for zero or several keys.
 */
export function resolveStreamAudioField(description: WorkflowSchemaDescription): string {
  const components = description.components ?? {};
  const inputName = Object.keys(components).find((name) => name.endsWith('_Input'));
  const input = inputName === undefined ? undefined : components[inputName];
  const properties = isPlainObject(input) && isPlainObject(input.properties) ? input.properties : {};
  const candidates = Object.keys(properties).filter((key) => isStreamAudioSchema(properties[key]));

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new RunAudioFieldError(
      `Workflow "${description.slug}" declares no live-audio Input (a stream-delivery audio kind), so there is nowhere to put the STT session.`,
    );
  }
  throw new RunAudioFieldError(
    `Workflow "${description.slug}" declares several live-audio Inputs (${candidates.join(', ')}); pass \`audioField\` to choose one.`,
    candidates,
  );
}

/** What the caller gets to drive the audio. */
export interface RunAudio {
  /** One PCM16 LE MONO frame, as a binary WebSocket frame. */
  sendPcm16(chunk: ArrayBuffer | ArrayBufferView): void;
  /** Flush the tail, then close the session. The run is NOT cancelled and carries on to its result. */
  finalize(): Promise<void>;
  /** Abort the audio without flushing. The run is NOT cancelled. */
  close(): Promise<void>;
}

export interface RunWithAudioOptions {
  /** The Input key that takes the audio. Default: the single stream-audio key of the published Input shape. */
  audioField?: string;
  /** ASR agent override (a `SPEECH_TO_TEXT` agent slug). Default: the workflow's own STT node. */
  agentSlug?: string;
  language?: string;
  sampleRate?: number;
  /** Sent as the run's `Idempotency-Key`. */
  idempotencyKey?: string;
  /** Aborts the setup requests (schema, session, run start). Nothing here cancels a run. */
  signal?: AbortSignal;
}

/** The slice of {@link import('./realtime-stt-socket').RealtimeSttSocket} this module drives. */
export interface RunAudioSocket {
  connect(): Promise<void>;
  sendPcm16(frame: ArrayBuffer | ArrayBufferView): void;
  finalize(): Promise<void>;
  close(): void;
}

export interface RunWithAudioDeps<TRun> {
  schema(slug: string, options: { signal?: AbortSignal }): Promise<WorkflowSchemaDescription>;
  createStreamSession(request: CreateStreamSessionRequest, options: { signal?: AbortSignal }): Promise<StreamSessionResponse>;
  socket(session: StreamSessionResponse): RunAudioSocket;
  closeStreamSession(sessionId: string): Promise<void>;
  run(slug: string, input: Record<string, unknown>, options: { idempotencyKey?: string; signal?: AbortSignal }): Promise<TRun>;
}

export async function runWithAudio<TRun>(
  deps: RunWithAudioDeps<TRun>,
  slug: string,
  input: object,
  options: RunWithAudioOptions = {},
): Promise<{ run: TRun; audio: RunAudio }> {
  const { signal } = options;
  const audioField = options.audioField ?? resolveStreamAudioField(await deps.schema(slug, { signal }));

  const request: CreateStreamSessionRequest = {
    workflowSlug: slug,
    ...(options.agentSlug === undefined ? {} : { agentSlug: options.agentSlug }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
  };
  const session = await deps.createStreamSession(request, { signal });
  const socket = deps.socket(session);

  const end = (): Promise<void> => {
    try {
      socket.close();
    } catch {
      // The socket may never have opened; the session close below is what releases the slot.
    }
    return deps.closeStreamSession(session.sessionId);
  };

  let run: TRun;
  try {
    await socket.connect();
    run = await deps.run(
      slug,
      { ...(input as Record<string, unknown>), [audioField]: { sttSessionId: session.sessionId } },
      { idempotencyKey: options.idempotencyKey, signal },
    );
  } catch (error) {
    await end().catch(() => undefined);
    throw error;
  }

  let ended: Promise<void> | undefined;
  const once = (fn: () => Promise<void>): Promise<void> => (ended ??= fn());

  return {
    run,
    audio: {
      sendPcm16: (chunk) => socket.sendPcm16(chunk),
      finalize: () =>
        once(async () => {
          let finalized = false;
          try {
            await socket.finalize();
            finalized = true;
          } finally {
            await end().catch((error: unknown) => {
              // A completed `stop` ends the session on the gateway, so the DELETE that follows finds
              // nothing: after a SUCCESSFUL finalize a 404 is the expected end, not a failure.
              if (finalized && error instanceof NotFoundError) return;
              throw error;
            });
          }
        }),
      close: () => once(end),
    },
  };
}
