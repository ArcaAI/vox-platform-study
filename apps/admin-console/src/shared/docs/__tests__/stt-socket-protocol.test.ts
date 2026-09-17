import { describe, expect, it } from 'vitest';

import { STT_SOCKET_FRAMES, STT_SOCKET_ROUTES, sttRawWebSocketSnippet, sttSessionCurlSnippet } from '../stt-socket-protocol';

/**
 * The manual (no-SDK) socket contract. Every JSON frame example must parse and carry its own
 * `type`; the two snippets must name the real routes and every frame a client sends or reads,
 * and must import no SDK — that is the whole point of them.
 */
describe('stt-socket-protocol — the raw contract a developer follows without an SDK', () => {
  it('every JSON frame example parses and its type matches the row', () => {
    for (const frame of STT_SOCKET_FRAMES) {
      if (frame.type === 'binary') continue;
      const parsed = JSON.parse(frame.example) as { type: string };
      expect(parsed.type, frame.type).toBe(frame.type);
    }
  });

  it('covers both directions: every client frame the gateway accepts and every server frame it emits', () => {
    const client = STT_SOCKET_FRAMES.filter((f) => f.direction === 'client → server').map((f) => f.type);
    const server = STT_SOCKET_FRAMES.filter((f) => f.direction === 'server → client').map((f) => f.type);
    expect(client).toEqual(expect.arrayContaining(['binary', 'audio', 'metadata', 'stop', 'resume', 'close']));
    expect(server).toEqual(expect.arrayContaining(['ready', 'transcript', 'status', 'error', 'resumed', 'resume_failed']));
  });

  it('the shell walkthrough names the session route, the handshake and the refresh route, and uses websocat for the socket', () => {
    const code = sttSessionCurlSnippet('asr', 'https://api.example.com');
    expect(code).toContain(`https://api.example.com/api/v1${STT_SOCKET_ROUTES.createSession}`);
    expect(code).toContain('"agentSlug": "asr"');
    expect(code).toContain('X-API-Key');
    expect(code).toContain(`wss://api.example.com${STT_SOCKET_ROUTES.socketPath}?sessionId=$SESSION_ID&ticket=$TICKET`);
    expect(code).toContain('/stream/session/$SESSION_ID/refresh-ticket');
    expect(code).toContain('websocat');
    expect(code).not.toMatch(/curl[^\n]*wss?:\/\//);
  });

  it('the fetch + WebSocket sample imports no SDK and handles every server frame', () => {
    const code = sttRawWebSocketSnippet('asr', 'https://api.example.com');
    expect(code).not.toContain('@arcaai/');
    expect(code).not.toContain('import ');
    expect(code).toContain(`${STT_SOCKET_ROUTES.createSession}`);
    expect(code).toContain("agentSlug: \"asr\"");
    expect(code).toContain('new WebSocket(');
    expect(code).toContain("binaryType = 'arraybuffer'");
    for (const type of ['ready', 'transcript', 'status', 'error', 'resumed', 'resume_failed']) {
      expect(code, type).toContain(`case '${type}'`);
    }
    expect(code).toContain("{ type: 'stop' }");
    expect(code).toContain("{ type: 'resume', sessionId, lastSeq }");
    expect(code).toContain('refresh-ticket');
  });
});

/**
 * TASK-983 lane I — three facts a LIVE run of this exact walkthrough contradicted, pinned so the
 * corrected copy cannot drift back. Measured on the dev gateway, 2026-09-17: session → ready →
 * binary PCM → deliberate drop → refresh-ticket → resume → stop → finals → closed.
 */
describe('stt-socket-protocol — the live corrections', () => {
  it('the session answers status "active", not "created"', () => {
    const code = sttSessionCurlSnippet('asr', 'https://api.example.com');
    expect(code).toContain('"status": "active"');
    expect(code).not.toContain('"status": "created"');
  });

  it('the session example lists the fields the response really carries', () => {
    const code = sttSessionCurlSnippet('asr', 'https://api.example.com');
    for (const field of ['sessionId', 'wsUrl', 'ticket', 'ticketExpiresAt', 'agentVersionId', 'maxConcurrent', 'currentActive', 'voiceProfileSeeded']) {
      expect(code, field).toContain(field);
    }
  });

  it('`finalizing` is documented — a client that closes on it drops the last utterance', () => {
    const status = STT_SOCKET_FRAMES.find((frame) => frame.type === 'status');
    expect(status).toBeDefined();
    // `StreamingSessionStatus` — packages/vox-node/src/types/stt.ts:80
    for (const value of ['active', 'finalizing', 'closed', 'rejected']) {
      expect(status!.note, value).toContain(value);
    }
    expect(sttRawWebSocketSnippet('asr', 'https://api.example.com')).toContain('finalizing');
  });

  it('websocat is labelled as a tool to install, and the SDK-free JS sample is offered as the first path', () => {
    const code = sttSessionCurlSnippet('asr', 'https://api.example.com');
    expect(code).toMatch(/install websocat/);
    expect(code).toMatch(/fetch \+ WebSocket/);
  });
});
