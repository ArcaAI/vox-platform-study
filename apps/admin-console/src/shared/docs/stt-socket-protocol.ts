/**
 * The realtime STT socket WITHOUT an SDK — the raw HTTP + WebSocket contract, stated once.
 *
 * A developer who does not use `@arcaai/vox-node` or `@arcaai/vox` calls the gateway directly:
 * one HTTP POST opens the session and answers a single-use ticket, one WebSocket carries the
 * audio and the transcripts, one more POST refreshes the ticket for a reconnect. Every frame in
 * both directions is spelled out here as a literal example, because a protocol a developer has
 * to reverse-engineer from an SDK is not documented.
 *
 * Source of truth (the docs follow the code, never the other way round):
 *   - `apps/api/src/modules/streaming/transcription-job.controller.ts` — `POST stream/session`
 *     (`CreateStreamSessionRequest` → `StreamSessionResponse`, `wsUrl: '/ws/stt/stream'`,
 *     `ticket`, `ticketExpiresAt`) and `POST stream/session/:sessionId/refresh-ticket`.
 *   - `apps/api/src/modules/streaming/stt-ws.gateway.ts` — handshake `?sessionId=&ticket=`,
 *     client frames `audio` / `metadata` / `stop` / `resume` / `close`, binary frames as raw
 *     PCM16 LE mono at the session's `sampleRate` (default 16000), server frames `ready` /
 *     `transcript` / `status` / `error` / `resumed` / `resume_failed`.
 *   - `packages/vox-node/src/types/stt.ts` — the typed mirror of the same frames.
 */

const FALLBACK_ORIGIN = 'https://your-gateway.example.com';

/** Routes, relative to the `api/v1` prefix (the WebSocket path is served at the origin root). */
export const STT_SOCKET_ROUTES = Object.freeze({
  createSession: '/audio/transcription-jobs/stream/session',
  refreshTicket: '/audio/transcription-jobs/stream/session/{sessionId}/refresh-ticket',
  socketPath: '/ws/stt/stream',
  handshake: '/ws/stt/stream?sessionId={sessionId}&ticket={ticket}',
});

export type SttSocketFrameDirection = 'client → server' | 'server → client';

export interface SttSocketFrame {
  direction: SttSocketFrameDirection;
  /** The `type` discriminator, or `binary` for a raw audio frame. */
  type: string;
  /** A literal example a developer can send or expect, verbatim. */
  example: string;
  /** When it is sent, and what it means. */
  note: string;
}

/**
 * Every frame on the wire, in the order a session meets them. `binary` is the fast path for
 * audio; the JSON `audio` frame is the same bytes base64-encoded for clients that cannot send
 * binary WebSocket messages.
 */
export const STT_SOCKET_FRAMES: readonly SttSocketFrame[] = Object.freeze([
  {
    direction: 'server → client',
    type: 'ready',
    example: '{ "type": "ready", "sessionId": "01a0…", "fromSeq": 1, "sessionEpochMs": 1789636000000 }',
    note: 'The first frame after the handshake. Gate your first audio send on it; `fromSeq` is the next result sequence you will receive.',
  },
  {
    direction: 'client → server',
    type: 'binary',
    example: '<raw PCM16 LE mono bytes at the session sampleRate — 3200 bytes = 100 ms at 16 kHz>',
    note: 'The audio itself, as a binary WebSocket message. Send 20–100 ms chunks continuously; there is no per-chunk acknowledgement.',
  },
  {
    direction: 'client → server',
    type: 'audio',
    example: '{ "type": "audio", "seq": 42, "data": "<base64 PCM16 LE mono>", "metadata": { "speaker": "clinician" } }',
    note: 'The JSON alternative to a binary frame for clients that cannot send binary. `seq` is optional and monotonic; `metadata` is optional and sticks until the next metadata frame.',
  },
  {
    direction: 'client → server',
    type: 'metadata',
    example: '{ "type": "metadata", "metadata": { "speaker": "patient" } }',
    note: 'Sets the metadata attached to every following transcript until replaced. Validated against the agent’s context schema; a violation is answered with an `error` frame and the audio keeps flowing.',
  },
  {
    direction: 'server → client',
    type: 'transcript',
    example:
      '{ "type": "transcript", "text": "chest pain since this morning", "isFinal": false, "startTime": 12.4, "endTime": 14.9, "seq": 7, "utteranceIndex": 3, "language": "en", "speakerLabel": "SPEAKER_00", "wordTimestamps": [ { "word": "chest", "start": 12.4, "end": 12.7, "confidence": 0.98 } ] }',
    note: 'Partials arrive with `isFinal: false` and are replaced; a final has `isFinal: true` and is the text to keep. Times are seconds from the session start; `seq` is what you replay from on a resume.',
  },
  {
    direction: 'server → client',
    type: 'status',
    example: '{ "type": "status", "status": "closed", "message": "Transcription stream completed" }',
    note: 'Session lifecycle. `closed` follows your `stop` once the last final has been delivered.',
  },
  {
    direction: 'server → client',
    type: 'error',
    example: '{ "type": "error", "code": "STREAM_ERROR", "message": "Result stream encountered an error" }',
    note: 'A refused frame or a broken result stream. After an error on the result stream, reconnect and resume — a refused resume is a real transcript gap, not a hiccup.',
  },
  {
    direction: 'client → server',
    type: 'stop',
    example: '{ "type": "stop" }',
    note: 'End of speech: the engine finalises everything buffered and answers the remaining finals, then `status: closed`.',
  },
  {
    direction: 'client → server',
    type: 'resume',
    example: '{ "type": "resume", "sessionId": "01a0…", "lastSeq": 7 }',
    note: 'Sent first thing on a RECONNECT (a fresh ticket from the refresh route — the first one was consumed). The server replays results after `lastSeq`.',
  },
  {
    direction: 'server → client',
    type: 'resumed',
    example: '{ "type": "resumed", "sessionId": "01a0…", "fromSeq": 8 }',
    note: 'The resume was accepted; results continue from `fromSeq`.',
  },
  {
    direction: 'server → client',
    type: 'resume_failed',
    example: '{ "type": "resume_failed", "sessionId": "01a0…", "reason": "buffer_overflow", "minAvailableSeq": 30 }',
    note: '`unknown_session` (the session is gone) or `buffer_overflow` (you fell further behind than the replay buffer). Treat the gap as lost audio.',
  },
  {
    direction: 'client → server',
    type: 'close',
    example: '{ "type": "close" }',
    note: 'Tear the session down. Prefer `stop` first so the last utterance is finalised.',
  },
]);

function origin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Shell walkthrough: open the session with curl, connect with websocat (curl cannot speak WebSocket), refresh a ticket. */
export function sttSessionCurlSnippet(agentSlug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = origin(baseUrl);
  const wsBase = base.replace(/^http/, 'ws');
  return [
    `# 1. Open a session on an API key holding the business-plane scopes. The answer carries the`,
    `#    sessionId, the socket path and a SINGLE-USE ticket (consumed by the first WebSocket open).`,
    `curl -sS -X POST "${base}/api/v1${STT_SOCKET_ROUTES.createSession}" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY" -H "content-type: application/json" \\`,
    `  -d '{ "agentSlug": ${JSON.stringify(agentSlug)}, "sampleRate": 16000 }'`,
    `# → { "sessionId": "01a0…", "status": "created", "wsUrl": "${STT_SOCKET_ROUTES.socketPath}",`,
    `#     "ticket": "…", "ticketExpiresAt": 1789636030000, "agentSlug": ${JSON.stringify(agentSlug)} }`,
    ``,
    `# 2. Connect. The ticket travels in the query string, never a credential; the first frame back`,
    `#    is { "type": "ready" }. Send raw PCM16 LE mono frames as BINARY messages, then { "type": "stop" }.`,
    `websocat --binary "${wsBase}${STT_SOCKET_ROUTES.socketPath}?sessionId=$SESSION_ID&ticket=$TICKET" < audio-16k-mono.pcm`,
    ``,
    `# 3. Reconnecting: the first ticket is spent, so mint another one, reopen, and send`,
    `#    { "type": "resume", "sessionId": "$SESSION_ID", "lastSeq": <last transcript seq you received> }.`,
    `curl -sS -X POST "${base}/api/v1${STT_SOCKET_ROUTES.refreshTicket.replace('{sessionId}', '$SESSION_ID')}" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY"`,
  ].join('\n');
}

/** Plain `fetch` + `WebSocket` — Node 22+, Bun, Deno or a browser — no SDK on the import line. */
export function sttRawWebSocketSnippet(agentSlug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = origin(baseUrl);
  return [
    `// No SDK: fetch + WebSocket only (Node 22+, Bun, Deno, or a browser).`,
    `const API = ${JSON.stringify(`${base}/api/v1`)};`,
    `const headers = { 'X-API-Key': process.env.HOPE_API_KEY, 'content-type': 'application/json' };`,
    ``,
    `// 1. Open the session — it names the published agent; the gateway resolves engine and models.`,
    `const created = await fetch(\`\${API}${STT_SOCKET_ROUTES.createSession}\`, {`,
    `  method: 'POST',`,
    `  headers,`,
    `  body: JSON.stringify({ agentSlug: ${JSON.stringify(agentSlug)}, sampleRate: 16000 }),`,
    `}).then((r) => r.json());`,
    `const { sessionId, wsUrl, ticket } = created; // wsUrl is '${STT_SOCKET_ROUTES.socketPath}'`,
    ``,
    `// 2. Connect with the SINGLE-USE ticket in the query string (never an API key).`,
    `const socket = new WebSocket(\`\${API.replace(/^http/, 'ws').replace('/api/v1', '')}\${wsUrl}?sessionId=\${sessionId}&ticket=\${ticket}\`);`,
    `socket.binaryType = 'arraybuffer';`,
    `let lastSeq = 0;`,
    ``,
    `socket.onmessage = (event) => {`,
    `  const frame = JSON.parse(String(event.data));`,
    `  switch (frame.type) {`,
    `    case 'ready':          startSendingAudio(); break;          // gate the first send on this`,
    `    case 'transcript':     lastSeq = frame.seq ?? lastSeq;`,
    `                           if (frame.isFinal) append(frame.text); else showPartial(frame.text); break;`,
    `    case 'status':         if (frame.status === 'closed') socket.close(); break;`,
    `    case 'error':          console.error(frame.code, frame.message); break;`,
    `    case 'resumed':        /* results continue from frame.fromSeq */ break;`,
    `    case 'resume_failed':  /* frame.reason: 'unknown_session' | 'buffer_overflow' — a real gap */ break;`,
    `  }`,
    `};`,
    ``,
    `// 3. Audio: raw PCM16 LE mono at 16 kHz, 20–100 ms per BINARY frame. (Or JSON: { type: 'audio', data: base64 })`,
    `function startSendingAudio() {`,
    `  for (const chunk of pcm16Chunks()) socket.send(chunk); // ArrayBuffer | Uint8Array`,
    `  socket.send(JSON.stringify({ type: 'stop' }));           // end of speech → the last finals, then status: closed`,
    `}`,
    ``,
    `// 4. Reconnect: the first ticket is spent — refresh, reopen, and resume from your cursor.`,
    `async function reconnect() {`,
    `  const { ticket: fresh } = await fetch(\`\${API}${STT_SOCKET_ROUTES.refreshTicket.replace('{sessionId}', '${sessionId}')}\`, { method: 'POST', headers }).then((r) => r.json());`,
    `  const again = new WebSocket(\`…\${wsUrl}?sessionId=\${sessionId}&ticket=\${fresh}\`);`,
    `  again.onopen = () => again.send(JSON.stringify({ type: 'resume', sessionId, lastSeq }));`,
    `}`,
  ].join('\n');
}
