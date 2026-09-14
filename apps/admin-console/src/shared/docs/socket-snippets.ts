/**
 * Socket-lane snippets for a published agent or workflow (TASK-975 lane B).
 *
 * ## The documentation-surface rules this file inherits
 *
 * Identical to `sdk-snippets.ts`, and for the same reason: everything here is RENDERED
 * DOCUMENTATION about how a CONSUMER configures THEIR service, including their own
 * `process.env.*`. `scripts/env-sync.mts` scans the repo for `process.env.X` to build
 * `turbo.json#globalEnv`, and its exemption is a list of DIRECTORIES — `shared/docs/` is one.
 * So: write snippets as TEMPLATE literals (the scanner blanks those, not quoted strings), and
 * never read a real environment variable here.
 *
 * ## The one fact this whole file is built around
 *
 * **SSE is the default because it is the only lane that RESUMES.** A dropped SSE connection
 * reconnects with `Last-Event-ID` and loses no frames. A socket's ticket is single-use and the
 * gateway replays nothing after the cursor you opened with, so a drop ends the watch.
 *
 * Socket is therefore not an upgrade — it is the answer to ONE symptom: something between the
 * caller and the gateway BUFFERS `text/event-stream`, which looks like a run that stalls and
 * then completes all at once. Any snippet here that reads as "the faster option" is wrong, and
 * every function below says so at the line where a developer would otherwise assume it.
 *
 * ## The runtime floor is a hard error, never a fallback
 *
 * Both SDKs require `globalThis.WebSocket` (Node 22+, Bun, Deno, edge). `@arcaai/vox-node`
 * throws `SocketUnavailableError` rather than importing a polyfill or silently serving the
 * transport the caller explicitly ruled out — so a doc that omits the floor turns a clear
 * construction-time error into a mystery.
 */

/** Gateway origin placeholder, used when the console has no configured host to offer. */
const FALLBACK_ORIGIN = 'https://your-gateway.example.com';

/**
 * The sentence every socket lane opens with. Stated once, rendered everywhere: a developer
 * comparing the SSE tab with this one is comparing transports, not two different explanations.
 */
export const SOCKET_LANE_RATIONALE =
  'SSE is the default and the only lane that resumes. Reach for a socket when something between ' +
  'you and the gateway buffers text/event-stream — a run that looks stalled and then completes ' +
  'all at once — or when a socket is the connection budget you already hold.';

/** The runtime floor, stated wherever a socket snippet is offered. */
export const SOCKET_RUNTIME_FLOOR =
  'Needs globalThis.WebSocket — Node 22+, Bun, Deno or edge. @arcaai/vox-node throws ' +
  'SocketUnavailableError instead of falling back to the transport you ruled out.';

// ---------------------------------------------------------------------------
// Workflow runs over a socket
// ---------------------------------------------------------------------------

/**
 * Follow a workflow run over a socket from a backend.
 *
 * `transport` is an OPTION on the existing methods, never a different method — which is the
 * point worth teaching: switching lanes changes no other line of the integration.
 */
export function workflowSocketVoxNodeSnippet(slug: string): string {
  return [
    `import { HopeClient, SocketUnavailableError } from '@arcaai/vox-node';`,
    ``,
    `const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL, apiKey: process.env.HOPE_API_KEY });`,
    ``,
    `// \`transport\` is an OPTION on the methods you already call — not a different method.`,
    `// The SDK mints the run-scoped, single-use ticket and opens the URL the gateway returns;`,
    `// a credential never travels in the query string.`,
    `const run = await hope.workflows.run('${slug}', { input: { /* … */ } });`,
    ``,
    `try {`,
    `  for await (const event of hope.workflows.streamRun('${slug}', run.runId, { transport: 'socket' })) {`,
    `    // Same frames, same order, same terminal event as the SSE lane.`,
    `  }`,
    `} catch (error) {`,
    `  if (error instanceof SocketUnavailableError) {`,
    `    // No global WebSocket in this runtime. Drop the option to take the SSE lane,`,
    `    // which is also the only one that resumes after a drop.`,
    `  }`,
    `}`,
  ].join('\n');
}

/** Watch a run over a socket from a React app — one option, nothing else changes. */
export function workflowSocketVoxSnippet(slug: string): string {
  return [
    `import { AgenticProvider, useWorkflowRun } from '@arcaai/vox/core';`,
    ``,
    `// baseUrl INCLUDES /api/v1 here — @arcaai/vox-node adds the prefix for you, this SDK does not.`,
    `const config = { api: { baseUrl: ${JSON.stringify(`${FALLBACK_ORIGIN}/api/v1`)}, accessToken: token } };`,
    `// <AgenticProvider config={config}>…</AgenticProvider>`,
    ``,
    `// The ONLY change from the SSE lane is this option. Everything else is identical:`,
    `// the same events, the same status, the same lastEventId, the same stopWatching().`,
    `const { start, watch, events, status, lastEventId } = useWorkflowRun({ transport: 'socket' });`,
    ``,
    `const handle = await start('${slug}', { /* … */ });`,
    `const stop = watch('${slug}', handle.runId);`,
    ``,
    `// A socket ticket is single-use, so a drop ENDS the watch rather than resuming it.`,
    `// Keep the cursor and start a new one: watch('${slug}', handle.runId, lastEventId).`,
  ].join('\n');
}

/**
 * The same lane without an SDK: mint the ticket over HTTP, then open the URL it returns.
 *
 * `websocat` rather than `curl` because curl cannot speak the WebSocket protocol — offering a
 * curl line here would be a snippet that cannot run.
 */
export function workflowSocketCurlSnippet(slug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = `$HOPE_API_URL/api/v1/workflows/${slug}`;
  return [
    `# Your gateway origin, and a key minted on the console's API keys screen.`,
    `export HOPE_API_URL=${JSON.stringify(baseUrl)}`,
    `export HOPE_API_KEY=${JSON.stringify('…')}`,
    ``,
    `# 1. Mint a run-scoped, single-use ticket (~30s). Scope is derived server-side as`,
    `#    workflow_run:<runId> — it is never taken from the request.`,
    `TICKET=$(curl -sS -X POST "${base}/runs/$RUN_ID/stream-ticket" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY")`,
    ``,
    `# 2. Open the url the response carried, with the ticket as a query parameter.`,
    `#    The gateway answers ws(s):// — curl cannot speak WebSocket, so this is websocat.`,
    `URL=$(printf '%s' "$TICKET" | jq -r .url)`,
    `TOK=$(printf '%s' "$TICKET" | jq -r .ticket)`,
    `websocat "$URL?ticket=$TOK"`,
    ``,
    `# The ticket is consumed by the first open. Every reconnect mints a fresh one — which is`,
    `# also why this lane does not resume: use the SSE stream when a drop must cost no frames.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Realtime speech-to-text
// ---------------------------------------------------------------------------

/**
 * Drive realtime STT from a server that ALREADY HAS audio — a telephony bridge, a recording
 * relay. This is not an inference stack: the gateway resolves the agent and the models.
 */
export function sttRealtimeVoxNodeSnippet(agentSlug: string): string {
  return [
    `import { HopeClient } from '@arcaai/vox-node';`,
    ``,
    `const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL, apiKey: process.env.HOPE_API_KEY });`,
    ``,
    `// The session names the published agent; the gateway resolves the engine and the models.`,
    `const session = await hope.stt.createStreamSession({ agentSlug: '${agentSlug}' });`,
    ``,
    `// The handshake carries a SINGLE-USE ticket, never a credential. The SDK wires`,
    `// refreshTicket for you, so each reconnect re-handshakes with a fresh one.`,
    `const socket = hope.stt.socket(session);`,
    ``,
    `socket.on('transcript', (result) => { /* partial and final segments */ });`,
    `socket.on('status', (message) => { /* session lifecycle */ });`,
    `socket.on('resumed', (message) => { /* the server accepted a resume from your cursor */ });`,
    `socket.on('error', (error) => { /* a refused resume is a real transcript GAP, not a hiccup */ });`,
    `socket.on('close', (event) => { /* … */ });`,
    ``,
    `await socket.connect();`,
    `socket.send(pcm16LeMonoChunk); // binary frames up, typed events down`,
    `socket.finalize();             // flush, then`,
    `await hope.stt.closeStreamSession(session.sessionId);`,
  ].join('\n');
}

/**
 * The browser path to the SAME published agent.
 *
 * Realtime STT is a CAPTURE session, not an invocation — which is exactly why the Browser lane
 * has no `invoke()` for this task. `agentSlug` is the only selector; omit it and the tenant →
 * department assignment cascade chooses. Never a pipeline, engine or model id.
 */
export function sttBrowserCaptureSnippet(agentSlug: string): string {
  return [
    `import { AgenticProvider, useArcaAudio } from '@arcaai/vox';`,
    ``,
    `// …in any component under <AgenticProvider>:`,
    `const audio = useArcaAudio();`,
    ``,
    `// A capture session, not an invocation: the microphone streams to the gateway, which`,
    `// resolves the agent there. Omit agentSlug to let the tenant → department cascade pick.`,
    `await audio.start({ agentSlug: '${agentSlug}' });`,
    `// …`,
    `await audio.stop();`,
    ``,
    `// The browser runs no model of its own — no VAD, no denoise, no ASR weights. Selection is`,
    `// the agent slug and nothing else.`,
  ].join('\n');
}
