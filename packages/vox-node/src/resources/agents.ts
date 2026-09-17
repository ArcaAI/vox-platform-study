/**
 * `hope.agents` — the published-AGENT invocation plane (TASK-865).
 *
 * The surface a backend integrator writes against to call a tenant's published
 * Agents as products — an LLM agent, a TTS agent, a batch-ASR agent — with the
 * same client that runs workflows. Backed by the TASK-863 §3.5 routes:
 *
 * ```
 * GET  /api/v1/agents?task=…                          -> list()
 * GET  /api/v1/agents/{slug}                          -> get()
 * POST /api/v1/agents/{slug}/invocations?mode=blocking -> invoke()
 * POST /api/v1/agents/{slug}/invocations?mode=stream   -> invokeAndStream()
 * POST /api/v1/agents/{slug}/speech                    -> synthesize()
 * POST /api/v1/agents/{slug}/transcriptions            -> transcribe({ mediaId })
 * POST /api/v1/audio/transcription-jobs/transcribe     -> transcribe({ file })
 * GET  /api/v1/audio/transcription-jobs/{id}           -> transcriptionJob()
 * GET  /api/v1/audio/transcription-jobs/{id}/stream    -> subscribeTranscription() / waitForTranscription()
 * ```
 *
 * Hand-authored, like `hope.workflows`: this is the BUSINESS plane. Since
 * TASK-930 it accepts BOTH machine credential classes — an API key, and a
 * service account holding `svc:agent:definition:read` /
 * `svc:agent:invocation:write`. Until then the gateway declared `svcScopes: []`
 * here and this resource refused a service-account client at the call site;
 * that refusal is gone, because the scopes it explained away now exist.
 *
 * Administration of agents — CRUD, versions, publish, assignments — is
 * `hope.admin.agent.*`, GENERATED from the admin plane, service-account ONLY,
 * and deliberately not duplicated here.
 *
 * Realtime ASR is NOT here either: a browser captures audio and opens the
 * stream session through `@arcaai/vox` (`audio.start({ agentSlug })`). This
 * package has no audio stack and never will.
 */

import { TranscriptionJobTimeoutError } from '../core/errors';
import { generateUuidV7 } from '../core/idempotency';
import { parseSseStream } from '../core/sse';
import { subscribeToSse } from '../core/sse-subscription';
import type { StreamHandle, StreamHandlers, SubscribeOptions } from '../core/sse-subscription';
import type { Transport } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type {
  AgentInvocationEvent,
  AgentInvocationResult,
  AgentSummary,
  AgentTask,
  SpeechRequest,
  SpeechSynthesis,
  TranscribeSource,
  TranscriptionJobEvent,
  TranscriptionJobHandle,
  TranscriptionJobStatus,
} from '../types/agent';
import type { StartRunOptions } from './workflows';

/**
 * Every gateway route this plane calls, in `route-manifest.json`'s own spelling.
 * `agents.contract.task865.test.ts` asserts each one against the shipped
 * manifest once TASK-863 lands the routes.
 */
export const AGENT_PLANE_ROUTES: ReadonlyArray<{ method: string; path: string }> = Object.freeze([
  { method: 'GET', path: '/api/v1/agents' },
  { method: 'GET', path: '/api/v1/agents/{slug}' },
  { method: 'POST', path: '/api/v1/agents/{slug}/invocations' },
  { method: 'POST', path: '/api/v1/agents/{slug}/speech' },
  { method: 'POST', path: '/api/v1/agents/{slug}/transcriptions' },
  // TASK-983 — the FILE half of `transcribe()`. It is not an `/agents/*` route: uploading audio
  // is the AUDIO plane's job (`stt:transcription:write`), and the agent is named in the form.
  // Listed here because this resource calls it, which is what this constant is checked against.
  { method: 'POST', path: '/api/v1/audio/transcription-jobs/transcribe' },
  // TASK-983 — and where the job it creates is READ. `hope.jobs.*` is the CONSULTATION jobs
  // plane (`/consultations/jobs/{jobId}`) and answers 404 for a transcription job id, which is
  // what an integrator hit on the line after the upload.
  { method: 'GET', path: '/api/v1/audio/transcription-jobs/{id}' },
  { method: 'GET', path: '/api/v1/audio/transcription-jobs/{id}/stream' },
]);

/** Where a FILE goes. The agent route beside it takes an already-uploaded `mediaId` as JSON. */
const BATCH_TRANSCRIBE_PATH = '/audio/transcription-jobs/transcribe';

/** Where the job it creates is read. NOT `consultations/jobs/…`, which is a different plane. */
function transcriptionJobPath(jobId: string): string {
  return `audio/transcription-jobs/${encodePathSegment(jobId)}`;
}

/**
 * Every status a transcription job stops at. `CANCELLED` and `DEAD` (max retries exceeded) are
 * terminal as surely as `COMPLETED`/`FAILED`: a waiter that ignored them would poll a finished
 * job until its own timeout.
 */
const TERMINAL_TRANSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD']);

/** Options for {@link AgentsResource.waitForTranscription}. */
export interface WaitForTranscriptionOptions {
  signal?: AbortSignal;
  /** Delay between polls, in ms. Default `2000`. */
  pollIntervalMs?: number;
  /** Ceiling on total wait time, in ms, before throwing {@link TranscriptionJobTimeoutError}. Default `600000` (10 min). */
  timeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
}

/** The gateway's `mode=blocking` 504 is a fixed ceiling, not a transient failure — never retry it. */
const BLOCKING_NON_RETRYABLE: ReadonlySet<number> = new Set([504]);

/** Options for {@link AgentsResource.invoke} / {@link AgentsResource.invokeAndStream} — the same knobs as a workflow run start. */
export type InvokeAgentOptions = StartRunOptions;

function agentPath(slug: string): string {
  return `agents/${encodePathSegment(slug)}`;
}

function idempotencyHeaders(options: InvokeAgentOptions): Record<string, string> | undefined {
  const key = options.idempotencyKey ?? (options.idempotent === true ? generateUuidV7() : undefined);
  return key === undefined ? undefined : { 'Idempotency-Key': key };
}

/** Decode one SSE frame into an envelope carrying its own resume cursor; a frame we cannot parse is skipped, not thrown. */
function toInvocationEvent(data: string, resumeToken: string | undefined): AgentInvocationEvent | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof envelope !== 'object' || envelope === null) return null;
  return { ...(envelope as AgentInvocationEvent), ...(resumeToken === undefined ? {} : { resumeToken }) };
}

/**
 * `hope.agents` — call a tenant's published Agents.
 *
 * ```ts
 * const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL!, apiKey: process.env.HOPE_API_KEY! });
 *
 * const [writer] = await hope.agents.list({ task: 'TEXT_GENERATION' });
 * const { output } = await hope.agents.invoke(writer.slug, { note });
 *
 * const speech = await hope.agents.synthesize('clinic-tts', { text: output.text });
 * const job = await hope.agents.transcribe('clinic-asr', { file: recording });
 * ```
 */
export class AgentsResource {
  /**
   * @param sleep Injectable for tests — never a real timer in a unit test. Not part of the
   *   public `HopeClient` surface; `HopeClient` always constructs this resource with the default.
   */
  constructor(
    private readonly transport: Transport,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** `GET /api/v1/agents[?task=…]` — published, active agents visible to the tenant. Never `null`: `[]` means none. */
  async list(options: { task?: AgentTask; signal?: AbortSignal } = {}): Promise<AgentSummary[]> {
    const response = await this.transport.request<{ data?: AgentSummary[] }>({
      path: 'agents',
      query: options.task === undefined ? undefined : { task: options.task },
      signal: options.signal,
    });
    return Array.isArray(response?.data) ? response.data : [];
  }

  /** `GET /api/v1/agents/{slug}` — summary plus `inputSchema` / `outputSchema`. */
  async get(slug: string, options: { signal?: AbortSignal } = {}): Promise<AgentSummary> {
    return this.transport.request<AgentSummary>({ path: agentPath(slug), signal: options.signal });
  }

  /**
   * `POST /api/v1/agents/{slug}/invocations?mode=blocking` — run the agent and
   * WAIT for its output (TEXT_GENERATION). `input` is validated against the
   * agent's `inputSchema` server-side. Throws {@link GatewayTimeoutError} at the
   * gateway's ceiling — which means the invocation is still going, not that it
   * failed; prefer {@link invokeAndStream} for anything long.
   *
   * `input` IS the body — `{ text, context?, variables? }`, sent flat. TASK-890 black-box J6:
   * this used to wrap it as `{ input }`, which the gateway validates against the agent's
   * `inputSchema` (`additionalProperties: false`, `{ text, variables }`) and refuses with a 400
   * on EVERY call. The `{ input }` envelope belongs to the WORKFLOW plane
   * (`POST /workflows/{slug}/runs`), which is a different contract; `context` in particular is
   * withheld from the schema check here and validated against the agent's frozen context schema
   * instead, so it may only travel at the top level.
   */
  async invoke<TOutput = Record<string, unknown>>(
    slug: string,
    input: Record<string, unknown>,
    options: InvokeAgentOptions = {},
  ): Promise<AgentInvocationResult<TOutput>> {
    const headers = idempotencyHeaders(options);
    return this.transport.request<AgentInvocationResult<TOutput>>({
      method: 'POST',
      path: `${agentPath(slug)}/invocations`,
      query: { mode: 'blocking' },
      body: input,
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      hasIdempotencyKey: headers !== undefined,
      nonRetryableStatuses: BLOCKING_NON_RETRYABLE,
    });
  }

  /**
   * `POST /api/v1/agents/{slug}/invocations?mode=stream` — run the agent and
   * read its event stream on the SAME response. Frames share the workflow-run
   * envelope; the last one carries the output in `payload`.
   *
   * No reconnect: TASK-863 §3.5 exposes no per-invocation stream route to
   * resume against, so a dropped connection ends the iteration. Re-invoke with
   * the same `idempotencyKey` to join the in-flight invocation rather than
   * start a second one.
   */
  async *invokeAndStream(
    slug: string,
    input: Record<string, unknown>,
    options: InvokeAgentOptions = {},
  ): AsyncGenerator<AgentInvocationEvent, void, void> {
    const response = await this.transport.stream({
      method: 'POST',
      path: `${agentPath(slug)}/invocations`,
      query: { mode: 'stream' },
      body: input,
      headers: { Accept: 'text/event-stream', ...(idempotencyHeaders(options) ?? {}) },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      hasIdempotencyKey: options.idempotencyKey !== undefined || options.idempotent === true,
    });
    if (!response.body) return;
    for await (const frame of parseSseStream(response.body, { signal: options.signal })) {
      const event = toInvocationEvent(frame.data, frame.id);
      if (event !== null) yield event;
    }
  }

  /**
   * `POST /api/v1/agents/{slug}/speech` — synthesize speech (TEXT_TO_SPEECH).
   * The body is handed back unbuffered so a long clip can be streamed onward.
   */
  async synthesize(slug: string, body: SpeechRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SpeechSynthesis> {
    const response = await this.transport.stream({
      method: 'POST',
      path: `${agentPath(slug)}/speech`,
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return {
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      stream: response.body,
      arrayBuffer: () => response.arrayBuffer(),
    };
  }

  /**
   * BATCH transcription (SPEECH_TO_TEXT) — the job runs asynchronously and the
   * handle is returned immediately. TWO SOURCE SHAPES, TWO GATEWAY ROUTES:
   *
   * | Source | Route | Body | API-key scope |
   * |---|---|---|---|
   * | `{ file }` | `POST /api/v1/audio/transcription-jobs/transcribe` | multipart `file` + `agentSlug` (+ `language`) | `stt:transcription:write` |
   * | `{ mediaId }` | `POST /api/v1/agents/{slug}/transcriptions` | JSON | `agent:invocation:write` |
   *
   * TASK-983 — this method used to post the MULTIPART body to the agent route,
   * which accepts JSON only ("the media must already be uploaded") and answered
   * `400 mediaId is required` for every file. The gateway's file entry point is
   * the audio route above, which is what the browser SDK has always used
   * (`FileTranscriptionService`); the agent slug travels in the form there
   * rather than in the path, and the response carries `sseUrl` / `audioUri` /
   * `agentVersionId` beside the id and status.
   *
   * Realtime transcription is a different plane: a browser opens the stream
   * session through `@arcaai/vox` with the same `agentSlug`, and a server that
   * already HAS audio drives `hope.stt`.
   */
  async transcribe(
    slug: string,
    source: TranscribeSource,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<TranscriptionJobHandle> {
    if (source.file !== undefined) {
      const form = new FormData();
      // The third argument is what gives the part a FILENAME; without one the runtime sends the
      // blob with no name, and the gateway's `ALLOWED_AUDIO_MIMES` check reads the part's own
      // content type — which is why the caller's Blob `type` must survive, untouched, to here.
      form.append('file', source.file, source.filename ?? 'audio');
      form.append('agentSlug', slug);
      if (source.language) form.append('language', source.language);
      return this.transport.request<TranscriptionJobHandle>({
        method: 'POST',
        path: BATCH_TRANSCRIBE_PATH,
        body: form,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    }
    return this.transport.request<TranscriptionJobHandle>({
      method: 'POST',
      path: `${agentPath(slug)}/transcriptions`,
      body: { mediaId: source.mediaId, ...(source.language ? { language: source.language } : {}) },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * `GET /api/v1/audio/transcription-jobs/{jobId}` — read one batch transcription job.
   *
   * This is where a job from {@link transcribe} is read. `hope.jobs.*` is the CONSULTATION jobs
   * plane (`/consultations/jobs/{jobId}`) and answers 404 for a transcription job id — the live
   * finding this method exists to close.
   *
   * `resultText` appears once `status` is `COMPLETED`.
   */
  async transcriptionJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<TranscriptionJobStatus> {
    return this.transport.request<TranscriptionJobStatus>({ path: transcriptionJobPath(jobId), signal: options.signal });
  }

  /**
   * `GET /api/v1/audio/transcription-jobs/{jobId}/stream` — watch a batch job's progress.
   *
   * Frames are `{ type, data }` with the discriminator IN the JSON (there is no SSE `event:`
   * line): `status`, `progress`, `chunk`, `transcript`, `error`. The subscription ENDS itself on
   * a terminal `status` frame (`onClosed('terminal')`); the gateway also completes the stream on
   * its own, which arrives as `onClosed('end')`.
   *
   * `onError` is REQUIRED, as on every subscription in this package: nothing awaits the promise
   * this starts, so a 403 for a missing `stt:transcription:write` scope would otherwise be
   * indistinguishable from a job that is simply taking its time.
   *
   * Reach for {@link waitForTranscription} when the job IS the thing you are waiting on.
   */
  subscribeTranscription(jobId: string, handlers: StreamHandlers<TranscriptionJobEvent>, options: SubscribeOptions = {}): StreamHandle {
    return subscribeToSse(
      this.transport,
      {
        path: `${transcriptionJobPath(jobId)}/stream`,
        dispatch: (payload) => {
          const event = payload as TranscriptionJobEvent;
          handlers.onEvent(event);
          return event.type === 'status' && typeof event.data?.status === 'string' && TERMINAL_TRANSCRIPTION_STATUSES.has(event.data.status);
        },
      },
      handlers,
      options,
    );
  }

  /**
   * Poll {@link transcriptionJob} until the job reaches a terminal status — `COMPLETED`,
   * `FAILED`, `CANCELLED` or `DEAD`. ALL FOUR RESOLVE: a failed job is a valid terminal answer,
   * and a caller reads `status` / `errorCode` rather than catching. Throws
   * {@link TranscriptionJobTimeoutError} once `timeoutMs` elapses without one, and propagates
   * `options.signal`'s abort reason immediately, before or between polls.
   *
   * Polling, not streaming, deliberately: this mirrors `hope.dnaWritingStyle.waitForIngestJob`,
   * and the result a caller wants (`resultText`) is on the JOB, not in a stream frame. Use
   * {@link subscribeTranscription} when it is progress you want to watch.
   */
  async waitForTranscription(jobId: string, options: WaitForTranscriptionOptions = {}): Promise<TranscriptionJobStatus> {
    const { signal, pollIntervalMs = 2000, timeoutMs = 600_000 } = options;
    const deadline = Date.now() + timeoutMs;
    throwIfAborted(signal);

    for (;;) {
      const job = await this.transcriptionJob(jobId, { signal });
      if (TERMINAL_TRANSCRIPTION_STATUSES.has(job.status)) return job;

      if (Date.now() >= deadline) throw new TranscriptionJobTimeoutError(jobId, timeoutMs);
      throwIfAborted(signal);
      await this.sleep(pollIntervalMs);
    }
  }
}
