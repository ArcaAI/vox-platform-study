/**
 * Published-Agent types — the BUSINESS-plane view (TASK-865, over the TASK-863
 * routes). What an integrator may discover and invoke; never how an agent is
 * configured (that is `hope.admin.agent.*`, generated from the admin plane).
 */

import type { WorkflowRunEvent } from './workflow';

/** The task family a published Agent serves. */
export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH';

/** One published, active Agent visible to the tenant — `GET /api/v1/agents` / `GET /api/v1/agents/{slug}`. */
export interface AgentSummary {
  /** The public lineage key — the value you pass as `slug` to every method here. */
  slug: string;
  name: string;
  description: string | null;
  task: AgentTask;
  /** The ACTIVE published version currently resolved for this slug. */
  versionNumber: number;
  /** `true` for the slug the TENANT-level assignment names for this task. */
  isTenantDefault: boolean;
  /** JSON Schema the invocation `input` is validated against (TEXT_GENERATION). */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema of the invocation output. */
  outputSchema?: Record<string, unknown>;
  /** Wire protocols the agent is reachable over (e.g. `'invocation'`, `'speech'`, `'transcription'`, `'stream-session'`). */
  protocols?: string[];
}

/** Body of `POST /api/v1/agents/{slug}/invocations`. `input` is validated server-side against `inputSchema`. */
export interface InvokeAgentRequest {
  input: Record<string, unknown>;
}

/**
 * The `?mode=blocking` response. `output` conforms to the agent's `outputSchema`;
 * the envelope is otherwise forwarded as the gateway sends it (TASK-863 owns
 * the exact shape — extra fields are preserved, never dropped).
 */
export interface AgentInvocationResult<TOutput = Record<string, unknown>> {
  output: TOutput;
  [extra: string]: unknown;
}

/** Payload of an `agent.invocation.*` stream frame. */
export interface AgentInvocationEventPayload {
  invocationId?: string;
  status?: string;
  output?: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * One `?mode=stream` SSE frame — the SAME envelope as a workflow run event
 * (`schemaVersion`, `id`, `type`, `correlationId`, `payload`, `resumeToken`, …),
 * with an agent payload. Sharing the type is deliberate: one parser, one shape.
 */
export type AgentInvocationEvent = WorkflowRunEvent<AgentInvocationEventPayload>;

/**
 * What `POST /api/v1/agents/{slug}/transcriptions` accepts: an audio file
 * (multipart) OR the id of media already uploaded through the media routes.
 */
export type TranscribeSource =
  | {
      /** Audio to transcribe. Sent as the multipart `file` part. */
      file: Blob;
      /** File name for the multipart part (default `audio`). */
      filename?: string;
      /** ISO 639-1 language hint; omit to let the agent decide. */
      language?: string;
      mediaId?: never;
    }
  | {
      /** Id of media already uploaded through the media routes. Sent as JSON. */
      mediaId: string;
      language?: string;
      file?: never;
    };

/** The `TranscriptionJob` the gateway returns (TASK-861 payload); poll or stream it with `hope.jobs`-style routes on the audio plane. */
export interface TranscriptionJobHandle {
  id: string;
  status: string;
  jobType?: string;
  [extra: string]: unknown;
}

/** Body of `POST /api/v1/agents/{slug}/speech` — exactly one of `text` / `ssml`. */
export type SpeechRequest = ({ text: string; ssml?: never } | { ssml: string; text?: never }) & Record<string, unknown>;

/**
 * The synthesized audio. The body is NOT buffered for you: read `stream`
 * incrementally (chunked audio) or call `arrayBuffer()` once for the whole clip.
 */
export interface SpeechSynthesis {
  /** The response `Content-Type` (e.g. `audio/mpeg`, `audio/wav`, or `text/event-stream` when the agent streams frames). */
  contentType: string;
  /** The raw response body, unconsumed. `null` only for an empty response. */
  stream: ReadableStream<Uint8Array> | null;
  /** Buffer the whole body. Consumes `stream`. */
  arrayBuffer(): Promise<ArrayBuffer>;
}
