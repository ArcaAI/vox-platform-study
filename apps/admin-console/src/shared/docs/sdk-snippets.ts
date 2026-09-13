/**
 * Copy-pasteable snippets shown to a TENANT'S DEVELOPER after they publish an agent or a
 * workflow (TASK-890 §3.9/§3.10; the browser and HTTP lanes added by TASK-971 lane C).
 *
 * ## Why this file exists rather than a local helper in each dialog
 *
 * Everything in here is RENDERED DOCUMENTATION: prose about how the CONSUMER configures THEIR
 * service, including their own `process.env.HOPE_API_KEY`. `scripts/env-sync.mts` scans the
 * repository for `process.env.X` to build `turbo.json#globalEnv`, and a name it finds becomes
 * part of HOPE's declared environment surface and of the turbo cache key — which these names
 * must never be, because this repo does not read them.
 *
 * The scanner's exemption is `DOCUMENTATION_SURFACES`, and it is deliberately a list of
 * DIRECTORIES, never single files (`env-sync.test.ts` asserts it: a per-file skip could silently
 * hide a genuine read, because the console's ESLint preset carries no `turbo/*` rules to catch
 * one). So a snippet belongs in a documentation TREE. `features/developer-docs/` is the portal's
 * own; this is the shared one the publish dialogs use, and features may import from `shared/`
 * (rule 13) while they may never import each other.
 *
 * Two consequences to keep in mind when editing this file:
 *  - write snippets as TEMPLATE literals — the scanner blanks those, not quoted strings;
 *  - never read a real environment variable here. Nothing in a documentation surface is scanned,
 *    so a genuine read placed here would go undeclared and miss the cache key.
 *
 * ## The one distinction every snippet here is built around (TASK-971 F-C1)
 *
 * The AGENT plane takes its input **flat** (`{ text, variables?, context?, … }`); the WORKFLOW
 * plane takes the **`{ input: … }` envelope**. Mixing them is a 400 on every call, and it is the
 * single most likely mistake a developer holding both slugs will make — so the same derived body
 * is printed in all four lanes, flat on one plane and wrapped on the other, and never guessed at
 * in one lane and hard-coded in another.
 *
 * ## The other trap: `baseUrl` does not mean the same thing in the two SDKs
 *
 * `@arcaai/vox-node` normalizes a trailing `/api/v1` away and re-applies the prefix per route
 * (`packages/vox-node/src/core/url.ts`), so either spelling works there. `@arcaai/vox` does NOT:
 * every browser route is relative to `api.baseUrl`, so the `/api/v1` suffix is REQUIRED or each
 * call answers the gateway's root 404 with nothing thrown. Both snippets say so at the line
 * where it matters.
 */

const HEADER_LINES = [`import { HopeClient } from '@arcaai/vox-node';`, ``];

/**
 * The client construction every snippet opens with — the consumer's own two variables.
 *
 * `baseUrl` is NOT optional: `HopeClient`'s constructor throws without it. A key-only variant
 * used to live here and was rendered by the workflow snippet, so the one example a tenant admin
 * was handed after publishing threw before it made a request (TASK-971 F-A2).
 */
const CLIENT_WITH_BASE_URL = `const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL, apiKey: process.env.HOPE_API_KEY });`;

/** Shell preamble for the HTTP lane — the gateway ORIGIN, then `api/v1` on every path. */
const CURL_ENV_LINES = [
  `# Your gateway origin, and a key minted on the console's API keys screen.`,
  `export HOPE_API_URL=${JSON.stringify('https://your-gateway.example.com')}`,
  `export HOPE_API_KEY=${JSON.stringify('…')}`,
  ``,
];

/** The agent task shapes the business plane exposes — one call per task, never a generic one. */
export type SdkSnippetAgentTask = 'TEXT_GENERATION' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH';

/** Which credential the browser example is written for (OD-3: the session JWT leads). */
export type VoxBrowserCredential = 'accessToken' | 'apiKey';

export interface AgentSnippetOptions {
  /**
   * Derived from the agent's own `inputSchema`. Applies to `invocations` ONLY — `/speech` and
   * `/transcriptions` take a FIXED gateway body that the agent's schema does not govern.
   */
  exampleBody?: Record<string, unknown> | null;
  /**
   * `false` for NAMED_ENTITY_RECOGNITION: token classification is one-shot, and `?mode=stream`
   * on it is a 400 `MODE_UNSUPPORTED`, not a slower answer. No lane may offer it a stream.
   */
  streamable?: boolean;
}

/** The flat minimum the invocations route always accepts, when no schema is usable. */
const FLAT_MINIMUM: Record<string, unknown> = { text: '…' };

/**
 * One body, rendered identically everywhere. JSON (not a JS object literal with bare keys) on
 * purpose: the Node, Browser, HTTP and Postman lanes then print CHARACTER-IDENTICAL payloads, so
 * a developer comparing two tabs is comparing the transport, not the formatting.
 */
function jsonBlock(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : pad + line))
    .join('\n');
}

function invocationBody(options?: AgentSnippetOptions): Record<string, unknown> {
  return options?.exampleBody ?? FLAT_MINIMUM;
}

// ---------------------------------------------------------------------------
// Lane 1 — @arcaai/vox-node (server)
// ---------------------------------------------------------------------------

/** Invoke / synthesize / transcribe a published agent by slug. */
export function agentVoxNodeSnippet(slug: string, task: SdkSnippetAgentTask, options?: AgentSnippetOptions): string {
  if (task === 'TEXT_TO_SPEECH') {
    return [...HEADER_LINES, CLIENT_WITH_BASE_URL, ``, `const speech = await hope.agents.synthesize('${slug}', { text: '…' });`].join('\n');
  }
  if (task === 'SPEECH_TO_TEXT') {
    return [...HEADER_LINES, CLIENT_WITH_BASE_URL, ``, `const job = await hope.agents.transcribe('${slug}', { file });`].join('\n');
  }

  const lines = [...HEADER_LINES, CLIENT_WITH_BASE_URL, ``, `const { output } = await hope.agents.invoke('${slug}', ${jsonBlock(invocationBody(options), 0)});`];
  if (options?.streamable !== false) {
    lines.push(``, `// …or token by token, over the same route:`, `for await (const frame of hope.agents.invokeAndStream('${slug}', { text: '…' })) {`, `  // meta → chunk… → done`, `}`);
  }
  return lines.join('\n');
}

/**
 * Start a blocking run of a published workflow by slug.
 *
 * `runAndWait` is the blocking lane — the mode is the METHOD, never a body field, and the body
 * is the `{ input }` envelope (the agent plane takes its input flat; mixing the two is a 400 on
 * every call). It throws `GatewayTimeoutError` at the gateway's ~60s ceiling, which means the run
 * is still going: `hope.workflows.run(...)` + `streamRun` is the lane for anything longer.
 */
export function workflowVoxNodeSnippet(slug: string, exampleBody?: Record<string, unknown> | null): string {
  return [
    ...HEADER_LINES,
    CLIENT_WITH_BASE_URL,
    ``,
    `const status = await hope.workflows.runAndWait('${slug}', {`,
    `  input: ${jsonBlock(exampleBody ?? {}, 2)},`,
    `});`,
    ``,
    `// Longer than the gateway's ~60s blocking ceiling? Start it and follow the run instead:`,
    `const run = await hope.workflows.run('${slug}', { input: { /* … */ } });`,
    `for await (const event of hope.workflows.streamRun('${slug}', run.runId)) {`,
    `  // resumable SSE — the default transport is the only lane that resumes`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Lane 2 — @arcaai/vox (browser)
// ---------------------------------------------------------------------------

/** The `/api/v1` suffix is part of the BROWSER SDK's baseUrl — see the file header. */
function browserConfigLine(credential: VoxBrowserCredential): string {
  const value = credential === 'accessToken' ? `accessToken: token /* the signed-in user's JWT */` : `apiKey: ${JSON.stringify('hope_…')}`;
  return `const config = { api: { baseUrl: ${JSON.stringify('https://your-gateway.example.com/api/v1')}, ${value} } };`;
}

/**
 * Invoke a published agent from a React app.
 *
 * Only the INVOCATIONS route has a browser path by slug. `TEXT_TO_SPEECH` and batch
 * `SPEECH_TO_TEXT` do not, and the panel renders those as absences naming the real path rather
 * than calling this function — inventing a snippet for a route the SDK cannot reach would be the
 * worst failure this surface can have.
 */
export function agentVoxSnippet(slug: string, credential: VoxBrowserCredential, options?: AgentSnippetOptions): string {
  if (credential === 'apiKey') {
    return [
      `// Same component, keyed instead of signed in:`,
      browserConfigLine('apiKey'),
    ].join('\n');
  }

  const lines = [
    `import { AgenticProvider, useAgentInvocation } from '@arcaai/vox/core';`,
    ``,
    `// baseUrl INCLUDES /api/v1 here — @arcaai/vox-node adds the prefix for you, this SDK does not.`,
    browserConfigLine('accessToken'),
    `// <AgenticProvider config={config}>…</AgenticProvider>`,
    ``,
    `// …in any component under that provider:`,
    `const { invoke${options?.streamable === false ? '' : ', stream'} } = useAgentInvocation();`,
    `const { output } = await invoke('${slug}', ${jsonBlock(invocationBody(options), 0)});`,
  ];
  if (options?.streamable !== false) {
    lines.push(``, `for await (const frame of stream('${slug}', { text: '…' })) {`, `  // meta → chunk… → done. No resume: an invocation has no run id.`, `}`);
  }
  return lines.join('\n');
}

/**
 * Start and follow a published workflow run from a React app.
 *
 * The browser never selects a delivery mode on the URL: `mode=blocking` would hold a fetch open
 * against the gateway's ~60s ceiling from a UI thread, and `mode=stream` would put the run's
 * whole event stream on a POST this client cannot resume. So it starts the run async and WATCHES
 * it — which is also why `start` takes the payload unwrapped and posts the envelope itself.
 */
export function workflowVoxSnippet(slug: string, exampleBody?: Record<string, unknown> | null): string {
  return [
    `import { AgenticProvider, useWorkflowRun } from '@arcaai/vox/core';`,
    ``,
    `// baseUrl INCLUDES /api/v1 here — @arcaai/vox-node adds the prefix for you, this SDK does not.`,
    browserConfigLine('accessToken'),
    `// <AgenticProvider config={config}>…</AgenticProvider>`,
    ``,
    `// …in any component under that provider:`,
    `const { start, watch, status, events, isRunning } = useWorkflowRun();`,
    ``,
    `// The browser always starts the run async (202) and then WATCHES it — it never selects a`,
    `// delivery lane on the URL. \`start\` takes the payload UNWRAPPED: the hook posts the`,
    `// { input } envelope for you, so this is the one place the body is NOT written wrapped.`,
    `const handle = await start('${slug}', ${jsonBlock(exampleBody ?? {}, 0)});`,
    `const stop = watch('${slug}', handle.runId); // resumable SSE; call stop() to disconnect`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Lane 3 — direct HTTP (curl)
// ---------------------------------------------------------------------------

const CREDENTIAL_COMMENT = [
  `# Any of the three credential classes reaches this route:`,
  `#   -H "Authorization: Bearer $JWT"   -H "X-API-Key: $HOPE_API_KEY"   -H "X-Service-Account-Token: $TOKEN"`,
  `# Never add X-Tenant-Id to a key or a service-account token — the tenant binds to the credential.`,
];

function curlPost(url: string, body: string, { extraFlags = '', trailing = [] }: { extraFlags?: string; trailing?: string[] } = {}): string[] {
  return [
    `curl -sS${extraFlags} -X POST "${url}" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    // The body line closes the command unless more flags follow it.
    `  -d '${body}'${trailing.length > 0 ? ' \\' : ''}`,
    ...trailing,
  ];
}

/** The invoke / speech / transcriptions route as raw HTTP, on the `api/v1` prefix. */
export function agentCurlSnippet(slug: string, task: SdkSnippetAgentTask, options?: AgentSnippetOptions): string {
  const base = `$HOPE_API_URL/api/v1/agents/${slug}`;

  if (task === 'TEXT_TO_SPEECH') {
    return [
      ...CURL_ENV_LINES,
      ...CREDENTIAL_COMMENT,
      ``,
      `# Answers audio (audio/pcm | wav | mpeg), not JSON — send { "ssml": … } instead for markup.`,
      ...curlPost(`${base}/speech`, jsonBlock({ text: '…' }, 6), { trailing: [`  --output speech.wav`] }),
    ].join('\n');
  }

  if (task === 'SPEECH_TO_TEXT') {
    return [
      ...CURL_ENV_LINES,
      ...CREDENTIAL_COMMENT,
      ``,
      `# 201 → { id, status, agentSlug, agentVersionId, sseUrl }. \`mediaId\` is an already-uploaded`,
      `# recording; follow \`sseUrl\` for progress.`,
      ...curlPost(`${base}/transcriptions`, jsonBlock({ mediaId: '…' }, 6)),
    ].join('\n');
  }

  const body = jsonBlock(invocationBody(options), 6);
  const lines = [
    ...CURL_ENV_LINES,
    ...CREDENTIAL_COMMENT,
    ``,
    // Spelled without JSON quoting on purpose: the ONLY quoted "input" a reader should ever find
    // in an agent snippet is one this route would reject.
    `# The body is FLAT. Wrapping it in the workflow plane's { input: … } envelope is a 400 here.`,
    ...curlPost(`${base}/invocations`, body),
  ];
  if (options?.streamable !== false) {
    lines.push(
      ``,
      `# Token stream: real event:/data:/id: frames, :keepalive every 15s, first frame \`meta\`,`,
      `# last \`done\`. There is no resume — an invocation has no run id to reconnect to.`,
      ...curlPost(`${base}/invocations?mode=stream`, body, { extraFlags: ' -N' }),
    );
  }
  return lines.join('\n');
}

/** Start a run, read it, follow it — the three calls a workflow integration actually makes. */
export function workflowCurlSnippet(slug: string, exampleBody?: Record<string, unknown> | null, modes: readonly string[] = []): string {
  const base = `$HOPE_API_URL/api/v1/workflows/${slug}`;
  const lines = [
    ...CURL_ENV_LINES,
    ...CREDENTIAL_COMMENT,
    `# A user JWT additionally needs create:WorkflowRun (read:WorkflowRun for the two reads below).`,
    ``,
    `# 1. Start it. The default ?mode=async answers 202 immediately with the run id.`,
    `#    The body is ENVELOPED — { "input": … } — unlike the agent plane, which takes its input flat.`,
    `RUN=$(curl -sS -X POST "${base}/runs" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: $(uuidgen)" \\`,
    `  -d '${jsonBlock({ input: exampleBody ?? {} }, 6)}')`,
    `RUN_ID=$(printf '%s' "$RUN" | jq -r .runId)`,
    ``,
    `# 2. Read where it got to.`,
    `curl -sS -H "X-API-Key: $HOPE_API_KEY" "${base}/runs/$RUN_ID"`,
    ``,
    `# 3. Or follow it. The first frame is a snapshot with no id:, :keepalive arrives every 15s,`,
    `#    and the stream ends on workflow.run.completed. Resume with -H "Last-Event-ID: <id>".`,
    `curl -N -H "X-API-Key: $HOPE_API_KEY" "${base}/runs/$RUN_ID/stream"`,
    ``,
    `# A browser EventSource cannot set headers: POST "${base}/runs/$RUN_ID/stream-ticket" for a`,
    `# single-use ticket ({ ticket, expiresAt, scope, url }) and pass it as ?ticket=.`,
  ];
  if (modes.includes('blocking')) {
    lines.push(``, `# ?mode=blocking exists, but the gateway cuts it off at ~60s with a 504 — and the run keeps`, `# going. Use the stream above for anything that might take longer.`);
  }
  return lines.join('\n');
}
