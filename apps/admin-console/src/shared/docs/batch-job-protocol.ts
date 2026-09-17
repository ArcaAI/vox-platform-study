/**
 * BATCH transcription — the job contract, stated once, for a developer with or without an SDK.
 *
 * A batch job is four things, and the console used to document one of them: upload the audio,
 * start the job, follow its progress, read the transcript. What was printed instead was a single
 * SDK line and a single curl body, both of which end in a 400 or a dead end.
 *
 * ## Two ways in, and only one of them takes a file
 *
 * | Route | Takes | Scope family |
 * |---|---|---|
 * | `POST /audio/transcription-jobs/transcribe` | a multipart `file` + `agentSlug` | `stt:transcription:write` |
 * | `POST /agents/{slug}/transcriptions` | JSON `{ mediaId }` — media that already exists | `agent:invocation:write` |
 *
 * `POST /agents/{slug}/transcriptions` carries NO `FileInterceptor`
 * (`apps/api/src/modules/agent/agent.controller.ts:751-830` — the handler is
 * `@Body() body: AgentTranscriptionBody` and its first line is
 * ``if (!body?.mediaId) throw new BadRequestException('`mediaId` is required.')``). A multipart
 * body therefore arrives empty and the call is a 400. `@arcaai/vox-node`'s
 * `transcribe(slug, { file })` branch (`packages/vox-node/src/resources/agents.ts:213-233`)
 * builds exactly that request, so it cannot succeed against this gateway; the `{ mediaId }`
 * branch can. Documented rather than worked around: the docs follow the code.
 *
 * ## The scope crossing
 *
 * The 201 from `POST /agents/{slug}/transcriptions` hands back
 * `sseUrl: '/api/v1/audio/transcription-jobs/{id}/stream'` — a route on the STT job plane. A key
 * minted with `agent:invocation:write` alone starts the job and then cannot watch it. See
 * `gateway-scopes.ts`.
 *
 * ## Source of truth (file:line — the docs follow the code)
 *
 *  - `apps/api/src/modules/streaming/transcription-job.controller.ts:420-431` — the multipart
 *    route (`FileInterceptor('file')`, `MAX_UPLOAD_HARD_CEILING`), `:1170-1201` — `GET :id` and
 *    the `@Sse()` `GET :id/stream`, `:1203-1222` — cancel / retry, `:639-642` — `GET limits`.
 *  - `apps/api/src/modules/streaming/dto/transcription-job.dto.ts:67-102` —
 *    `TranscribeFileRequest` (`agentSlug`, `consultationId`, `language`), `:303-322` —
 *    `BatchTranscribeResponse` (`id`, `status`, `sseUrl`, `audioUri`, `agentSlug`,
 *    `agentVersionId`).
 *  - `packages/applications/src/services/stt/realtime/dto/transcription-events.ts:15-113` — the
 *    five SSE frames, each a `{ type, data }` envelope.
 *  - `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts:109-200` —
 *    the first frame is always a `status` snapshot; the stream closes on a terminal status.
 */

import { GATEWAY_ROUTE_SCOPES } from './gateway-scopes';

const FALLBACK_ORIGIN = 'https://your-gateway.example.com';

/** Routes, relative to the `api/v1` prefix. */
export const BATCH_STT_ROUTES = Object.freeze({
  /** Multipart: the file itself goes here, and the job starts in the same request. */
  uploadAndStart: '/audio/transcription-jobs/transcribe',
  /** JSON `{ mediaId }`: media that already exists (a consultation recording). */
  startFromMediaId: '/agents/{slug}/transcriptions',
  jobById: '/audio/transcription-jobs/{jobId}',
  jobStream: '/audio/transcription-jobs/{jobId}/stream',
  cancel: '/audio/transcription-jobs/{jobId}/cancel',
  limits: '/audio/transcription-jobs/limits',
});

/** The statuses that END the SSE stream — `transcriptionRealtime.service.ts:149`. */
export const BATCH_JOB_TERMINAL_STATUSES: readonly string[] = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD']);

/** Why `POST /agents/{slug}/transcriptions` is not the upload route, said where a developer will reach for it. */
export const MEDIA_ID_NOTE =
  'POST /agents/{slug}/transcriptions takes a `mediaId` — the id of media that ALREADY exists (a consultation ' +
  'recording). It has no multipart handler, so sending a file to it is a 400 `mediaId is required`. To transcribe ' +
  'a file you hold, upload it to POST /audio/transcription-jobs/transcribe, which names the agent with `agentSlug` ' +
  'and starts the job in the same request.';

export interface BatchStep {
  title: string;
  detail: string;
}

/** The walkthrough, in the order a developer performs it. */
export const BATCH_STT_STEPS: readonly BatchStep[] = Object.freeze([
  {
    title: 'Upload the audio and start the job',
    detail:
      `POST /api/v1${BATCH_STT_ROUTES.uploadAndStart} as multipart/form-data: a \`file\` part and an \`agentSlug\` field ` +
      '(omit `agentSlug` to use the tenant’s assigned ASR agent). 201 answers `{ id, status, sseUrl, audioUri, agentSlug, agentVersionId }`.',
  },
  {
    title: 'Respect the ceilings',
    detail:
      `GET /api/v1${BATCH_STT_ROUTES.limits} answers the numbers the gateway will enforce — files per batch, minutes per ` +
      'recording, megabytes per file, in-flight jobs per user. An oversized or over-long upload is a 400; too many in flight is a 429. ' +
      'A file whose container records no duration is refused too, fail-closed.',
  },
  {
    title: 'Follow the progress',
    detail:
      `GET /api/v1${BATCH_STT_ROUTES.jobStream} (SSE). The first frame is always a \`status\` snapshot; then \`progress\`, ` +
      '`chunk` per finished audio segment, and one `transcript` with the full result. The stream closes on ' +
      `${BATCH_JOB_TERMINAL_STATUSES.join(' / ')}. A browser EventSource cannot set headers: mint a single-use ticket at ` +
      'POST /api/v1/auth/stream-ticket with scope `transcription_job:<id>` and pass it as `?ticket=`.',
  },
  {
    title: 'Read the transcript',
    detail:
      `GET /api/v1${BATCH_STT_ROUTES.jobById} answers the job: \`status\`, \`progress\`, \`mediaId\`, and — once COMPLETED — ` +
      '`resultText` (the transcript itself) with `resultMetadata` beside it; `errorCode` and `errorMessage` on a failure. ' +
      'Polling is therefore a complete alternative to the stream, and the way to fetch the result after any reconnect. ' +
      `POST /api/v1${BATCH_STT_ROUTES.cancel} stops one; it is creator-scoped, so only the caller who started it may.`,
  },
]);

export interface BatchJobSseFrame {
  /** The discriminator. It appears twice per frame — as the SSE `event:` line AND as `type` inside the JSON. */
  type: 'status' | 'progress' | 'chunk' | 'transcript' | 'error';
  example: string;
  note: string;
}

/**
 * Every frame on a batch job's SSE stream, in the order a job meets them.
 *
 * Each frame carries BOTH an SSE `event:` line and a `type` field inside its JSON — they say the
 * same thing, and the JSON one is the safer discriminator because it survives any client that
 * drops unnamed events. The `id:` line is `{jobId}-{epochMs}`: a timestamp, not a resume cursor.
 * `GET …/{jobId}/stream` performs no `Last-Event-ID` replay
 * (`transcription-job.controller.ts:1185-1201` takes the id and nothing else), so after a
 * reconnect read the `status` snapshot the new connection opens with and then
 * `GET …/{jobId}` for `resultText`.
 *
 * Verified live against the dev gateway (2026-09-17): a 22 s recording emitted several
 * `progress` frames, one `transcript`, then `status: COMPLETED`, in 13 s.
 */
export const BATCH_JOB_SSE_FRAMES: readonly BatchJobSseFrame[] = Object.freeze([
  {
    type: 'status',
    example: '{ "type": "status", "data": { "jobId": "01a0…", "status": "PROCESSING", "timestamp": "2026-09-17T09:14:02.511Z", "workerId": "stt-worker-1" } }',
    note: 'Job lifecycle: QUEUED → PROCESSING → COMPLETED | FAILED. The FIRST frame of every connection is a snapshot of where the job already is, so a late subscriber is never left guessing.',
  },
  {
    type: 'progress',
    example: '{ "type": "progress", "data": { "jobId": "01a0…", "progress": 42, "stage": "transcribing" } }',
    note: 'Percentage complete, with the worker’s current stage. Advisory only — never treat 100 as completion; the terminal `status` frame is what ends the job.',
  },
  {
    type: 'chunk',
    example:
      '{ "type": "chunk", "data": { "jobId": "01a0…", "chunkIndex": 3, "text": "chest pain since this morning", "startTime": 12.4, "endTime": 14.9, "isFinal": true, "speakerLabel": "SPEAKER_00", "wordTimestamps": [ { "word": "chest", "start": 12.4, "end": 12.7, "confidence": 0.98 } ] } }',
    note: 'One finished audio segment. Times are seconds from the start of the recording. Useful for showing a transcript as it fills; the authoritative text is the `transcript` frame below.',
  },
  {
    type: 'transcript',
    example:
      '{ "type": "transcript", "data": { "jobId": "01a0…", "text": "…the full transcript…", "language": "en", "languageProbability": 0.99, "durationSeconds": 184.2, "processingTimeSeconds": 21.7, "wordTimestamps": [], "sentenceTimestamps": [], "metadata": {} } }',
    note: 'The complete result, once every chunk is processed. This is the frame to keep; it is also readable afterwards from GET /audio/transcription-jobs/{jobId}.',
  },
  {
    type: 'error',
    example: '{ "type": "error", "data": { "jobId": "01a0…", "errorCode": "JOB_NOT_FOUND", "message": "Job 01a0… not found" } }',
    note: 'The job failed, or the subscription could not be established (`INVALID_JOB_ID`, `JOB_NOT_FOUND`, `RECONNECTION_ERROR`). The stream completes straight after it.',
  },
]);

function origin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Shell: upload, follow, read. Everything a batch integration does, with no SDK.
 *
 * `curl -N` is what makes the SSE line work — without it curl buffers the response and the
 * progress arrives all at once at the end, which reads as a stalled job.
 */
export function sttBatchCurlSnippet(agentSlug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = origin(baseUrl);
  return [
    `# Scopes: ${GATEWAY_ROUTE_SCOPES.transcriptionUpload.apiKeyScope} for every request below (upload, read, stream).`,
    `export HOPE_API_URL=${JSON.stringify(base)}`,
    `export HOPE_API_KEY=${JSON.stringify('…')}`,
    ``,
    `# 0. What the gateway will enforce on the upload — check once, not per file.`,
    `curl -sS -H "X-API-Key: $HOPE_API_KEY" "$HOPE_API_URL/api/v1${BATCH_STT_ROUTES.limits}"`,
    `# → { "maxFilesPerBatch": …, "maxDurationMinutes": …, "maxFileSizeMb": …, "maxActiveJobsPerUser": … }`,
    ``,
    `# 1. Upload the audio and start the job — ONE multipart request. The file part is named \`file\`;`,
    `#    \`agentSlug\` names the published ASR agent (omit it for the tenant's assigned one).`,
    `#    The \`;type=\` is REQUIRED: without it curl sends application/octet-stream and the gateway`,
    `#    answers 400 "Unsupported audio type: application/octet-stream".`,
    `JOB=$(curl -sS -X POST "$HOPE_API_URL/api/v1${BATCH_STT_ROUTES.uploadAndStart}" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  -F "file=@consultation.wav;type=audio/wav" \\`,
    `  -F "agentSlug=${agentSlug}")`,
    `JOB_ID=$(printf '%s' "$JOB" | jq -r .id)`,
    `# → { "id": "…", "status": "QUEUED", "sseUrl": "/api/v1${BATCH_STT_ROUTES.jobStream.replace('{jobId}', '<id>')}",`,
    `#     "audioUri": "…", "agentSlug": "${agentSlug}", "agentVersionId": "…" }`,
    ``,
    `# 2. Follow it. -N is not optional: without it curl buffers the whole stream and the job looks stalled.`,
    `#    Each frame's JSON carries its own \`type\` — status | progress | chunk | transcript | error.`,
    `curl -N -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  "$HOPE_API_URL/api/v1${BATCH_STT_ROUTES.jobStream.replace('{jobId}', '$JOB_ID')}"`,
    ``,
    `# 3. Or just poll — and this is also how you fetch the transcript after a reconnect.`,
    `curl -sS -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  "$HOPE_API_URL/api/v1${BATCH_STT_ROUTES.jobById.replace('{jobId}', '$JOB_ID')}"`,
    `# → { "status": "COMPLETED", "progress": 100, "resultText": "…the transcript…", "resultMetadata": { … },`,
    `#     "mediaId": "…", "errorCode": null, "errorMessage": null }`,
    ``,
    `# Already have a mediaId (a consultation recording)? Then the AGENT route starts the job instead —`,
    `# JSON, not multipart, and on ${GATEWAY_ROUTE_SCOPES.agentTranscriptions.apiKeyScope}:`,
    `#   curl -sS -X POST "$HOPE_API_URL/api/v1/agents/${agentSlug}/transcriptions" \\`,
    `#     -H "X-API-Key: $HOPE_API_KEY" -H "content-type: application/json" \\`,
    `#     -d '{ "mediaId": "…" }'`,
    `# A mediaId this tenant does not own is a 404, exactly like an unknown one. There is no standalone`,
    `# media-upload route on this gateway, so the multipart route above is the FIRST form, not the second.`,
    `# Its 201 answers an sseUrl on the STT plane above, which needs ${GATEWAY_ROUTE_SCOPES.transcriptionJobStream.apiKeyScope} to read.`,
  ].join('\n');
}

/** Plain `fetch` — Node 22+, Bun, Deno or a browser — no SDK on the import line. */
export function sttBatchFetchSnippet(agentSlug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = origin(baseUrl);
  return [
    `// No SDK: fetch + FormData only. Scope: ${GATEWAY_ROUTE_SCOPES.transcriptionUpload.apiKeyScope}.`,
    `const API = ${JSON.stringify(`${base}/api/v1`)};`,
    `const key = process.env.HOPE_API_KEY;`,
    ``,
    `// 1. Upload and start. Do NOT set content-type yourself — the runtime writes the multipart boundary.`,
    `const form = new FormData();`,
    `form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'consultation.wav');`,
    `form.append('agentSlug', ${JSON.stringify(agentSlug)});`,
    `const job = await fetch(\`\${API}${BATCH_STT_ROUTES.uploadAndStart}\`, {`,
    `  method: 'POST',`,
    `  headers: { 'X-API-Key': key },   // no content-type here`,
    `  body: form,`,
    `}).then((r) => r.json());`,
    `// → { id, status: 'QUEUED', sseUrl, audioUri, agentSlug, agentVersionId }`,
    ``,
    `// 2. Follow it. The response body is text/event-stream; read it as a stream, not with .json().`,
    `const progress = await fetch(\`\${API}${BATCH_STT_ROUTES.jobStream.replace('{jobId}', '${job.id}')}\`, {`,
    `  headers: { 'X-API-Key': key, Accept: 'text/event-stream' },`,
    `});`,
    `for await (const frame of readSseFrames(progress.body)) {`,
    `  const { type, data } = JSON.parse(frame);   // the discriminator is INSIDE the JSON`,
    `  if (type === 'progress') report(data.progress);`,
    `  if (type === 'transcript') keep(data.text);           // the full result`,
    `  if (type === 'status' && ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'].includes(data.status)) break;`,
    `}`,
    ``,
    `// 3. Or poll — and this is how you read the transcript after any reconnect: the stream has no`,
    `//    Last-Event-ID replay, so re-open, read the status snapshot, then fetch the job.`,
    `const finished = await fetch(\`\${API}${BATCH_STT_ROUTES.jobById.replace('{jobId}', '${job.id}')}\`, {`,
    `  headers: { 'X-API-Key': key },`,
    `}).then((r) => r.json());`,
  ].join('\n');
}

/**
 * The Node lane's batch story.
 *
 * `hope.agents.transcribe` is the only batch method `@arcaai/vox-node` carries, and it reaches
 * the AGENT route — so it needs a `mediaId`. There is no SDK method for the audio job plane
 * (`hope.jobs` is the CONSULTATION job plane, `consultations/jobs/:jobId`), so the job is
 * followed with the transport the SDK is built on: a plain fetch against the `sseUrl` it
 * answered.
 */
export function sttBatchVoxNodeSnippet(agentSlug: string): string {
  return [
    `import { HopeClient } from '@arcaai/vox-node';`,
    ``,
    `const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL, apiKey: process.env.HOPE_API_KEY });`,
    ``,
    `// The SDK's batch method reaches POST /agents/{slug}/transcriptions, which takes the id of media`,
    `// that ALREADY exists — a consultation recording. Scope: ${GATEWAY_ROUTE_SCOPES.agentTranscriptions.apiKeyScope}.`,
    `const job = await hope.agents.transcribe('${agentSlug}', { mediaId });`,
    `// → { id, status, agentSlug, agentVersionId, pipelineId, sseUrl }`,
    ``,
    `// Holding a FILE instead? Upload it to POST /api/v1${BATCH_STT_ROUTES.uploadAndStart} — that route,`,
    `// and only that route, accepts multipart. The SDK has no method for it (nor for the job plane below).`,
    ``,
    `// Follow the job on the sseUrl it answered. \`hope.jobs\` is the CONSULTATION job plane`,
    `// (consultations/jobs/:jobId) and does not reach this one, so use fetch.`,
    `// Scope: ${GATEWAY_ROUTE_SCOPES.transcriptionJobStream.apiKeyScope} — a DIFFERENT family from the start above.`,
    `const stream = await fetch(new URL(job.sseUrl, process.env.HOPE_API_URL), {`,
    `  headers: { 'X-API-Key': process.env.HOPE_API_KEY, Accept: 'text/event-stream' },`,
    `});`,
    `// Frames are { type: 'status' | 'progress' | 'chunk' | 'transcript' | 'error', data: … }.`,
  ].join('\n');
}
