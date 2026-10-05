#!/usr/bin/env node
/**
 * TASK-1038 R-1 — live proof: N concurrent workflow-run SSE streams against a running gateway.
 *
 * Starts N runs of one published workflow, opens one SSE stream per run AT THE SAME TIME, and
 * reports how quickly frames reach the clients:
 *
 *   time-to-first-frame  request sent → first `event:` frame (the connect snapshot)
 *   time-to-first-push   request sent → first PUSHED frame (one that carries an `id:` resume token)
 *   inter-event gap      between consecutive pushed frames of the same stream
 *   delivery lag         pushed frame received − its envelope's `occurredAt` (same-host clocks only)
 *   time-to-terminal     request sent → `workflow.run.completed`
 *
 * Before TASK-1038 every stream's blocking read queued on ONE Redis connection per service, so
 * delivery lag and time-to-first-push grew with N. Run it before and after the change and
 * compare p95s.
 *
 * Usage (Node >= 22, no dependencies):
 *   node sse-load.mjs <baseUrl> <apiKey> <slug> [runCount=200] [--input='<json>'] [--timeout=180] [--start-concurrency=20] [--protocol=2]
 *
 *   baseUrl   e.g. http://localhost:8868   (the /api/v1 prefix is added here)
 *   apiKey    a tenant API key holding workflow:run:write + workflow:run:read
 *   slug      a PUBLISHED workflow whose output declares http-sse (mode=stream is not used;
 *             runs start with mode=async and the stream route is opened separately)
 *   --protocol=2  read run protocol v2 (`x-hope-run-protocol: 2`): terminal `run.completed`,
 *             envelope `ts`. Without it the legacy shapes are read (`workflow.run.completed`,
 *             envelope `occurredAt`).
 *
 * The key is sent as `X-API-Key` and is never printed. Exit code 1 when any stream failed or
 * timed out before its terminal event.
 */

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith('--'));
const flags = Object.fromEntries(
  args
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.join('=')];
    }),
);

const [baseUrlArg, apiKey, slug, runCountArg] = positional;
if (!baseUrlArg || !apiKey || !slug) {
  console.error('usage: node sse-load.mjs <baseUrl> <apiKey> <slug> [runCount=200] [--input=<json>] [--timeout=180] [--start-concurrency=20]');
  process.exit(2);
}
const baseUrl = baseUrlArg.replace(/\/+$/, '');
const runCount = Number(runCountArg ?? 200);
const input = flags.input ? JSON.parse(flags.input) : {};
const timeoutMs = Number(flags.timeout ?? 180) * 1000;
const startConcurrency = Number(flags['start-concurrency'] ?? 20);
const protocolV2 = flags.protocol === '2';
const completedType = protocolV2 ? 'run.completed' : 'workflow.run.completed';
const terminalTypes = new Set(protocolV2 ? ['run.completed', 'run.failed', 'run.cancelled'] : ['workflow.run.completed', 'workflow.run.failed']);
const api = `${baseUrl}/api/v1/workflows/${encodeURIComponent(slug)}`;
const runTag = `sse-load-${Date.now()}`;

/** Start one run (mode=async) and return its id. */
async function startRun(index) {
  const response = await fetch(`${api}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Idempotency-Key': `${runTag}-${index}` },
    body: JSON.stringify({ input }),
  });
  if (response.status !== 202 && response.status !== 200) {
    throw new Error(`start #${index}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()).runId;
}

async function startAll() {
  const runIds = new Array(runCount);
  let next = 0;
  const workers = Array.from({ length: Math.min(startConcurrency, runCount) }, async () => {
    while (next < runCount) {
      const index = next++;
      runIds[index] = await startRun(index);
    }
  });
  await Promise.all(workers);
  return runIds;
}

/** Open one SSE stream and time its frames until the terminal event, an error, or the timeout. */
async function watch(runId) {
  const result = { runId, firstFrameMs: null, firstPushMs: null, terminalMs: null, gaps: [], lags: [], frames: 0, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${api}/runs/${runId}/stream`, {
      headers: { Accept: 'text/event-stream', 'X-API-Key': apiKey, ...(protocolV2 ? { 'x-hope-run-protocol': '2' } : {}) },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastPushAt = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith('event:')) continue; // heartbeat comments
        const now = performance.now();
        const elapsed = now - startedAt;
        result.frames += 1;
        if (result.firstFrameMs === null) result.firstFrameMs = elapsed;
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const pushed = /^id: /m.test(frame);
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (pushed) {
          if (result.firstPushMs === null) result.firstPushMs = elapsed;
          if (lastPushAt !== null) result.gaps.push(now - lastPushAt);
          lastPushAt = now;
          try {
            const envelope = JSON.parse(data);
            const occurredAt = Date.parse(protocolV2 ? envelope.ts : envelope.occurredAt);
            if (Number.isFinite(occurredAt)) result.lags.push(Date.now() - occurredAt);
          } catch {
            /* a frame without a parseable envelope contributes no lag sample */
          }
        }
        if (terminalTypes.has(type)) {
          if (type !== completedType) result.error = `terminal ${type}: ${data?.slice(0, 200)}`;
          result.terminalMs = elapsed;
          controller.abort();
          return result;
        }
      }
    }
    if (result.terminalMs === null) result.error = 'stream ended before a terminal event';
  } catch (err) {
    if (result.terminalMs === null) result.error = controller.signal.aborted ? `timed out after ${timeoutMs / 1000}s` : String(err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  return result;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function row(label, values) {
  const fmt = (v) => (v === null ? '   n/a' : `${v.toFixed(0).padStart(6)}`);
  return `${label.padEnd(22)} n=${String(values.length).padStart(5)}  p50=${fmt(percentile(values, 50))}ms  p95=${fmt(percentile(values, 95))}ms  p99=${fmt(percentile(values, 99))}ms  max=${fmt(values.length ? Math.max(...values) : null)}ms`;
}

const t0 = performance.now();
console.log(`Starting ${runCount} runs of '${slug}' on ${baseUrl} …`);
const runIds = await startAll();
console.log(`Started ${runIds.length} runs in ${((performance.now() - t0) / 1000).toFixed(1)}s. Opening ${runIds.length} concurrent SSE streams …`);

const results = await Promise.all(runIds.map((runId) => watch(runId)));
const ok = results.filter((r) => r.error === null);
const failed = results.filter((r) => r.error !== null);

console.log('');
console.log(
  row(
    'time-to-first-frame',
    ok.map((r) => r.firstFrameMs).filter((v) => v !== null),
  ),
);
console.log(
  row(
    'time-to-first-push',
    ok.map((r) => r.firstPushMs).filter((v) => v !== null),
  ),
);
console.log(
  row(
    'inter-event gap',
    ok.flatMap((r) => r.gaps),
  ),
);
console.log(
  row(
    'delivery lag',
    ok.flatMap((r) => r.lags),
  ),
);
console.log(
  row(
    'time-to-terminal',
    ok.map((r) => r.terminalMs).filter((v) => v !== null),
  ),
);
console.log('');
console.log(`streams: ${results.length}  completed: ${ok.length}  failed: ${failed.length}  frames: ${results.reduce((n, r) => n + r.frames, 0)}`);
for (const r of failed.slice(0, 10)) console.log(`  ${r.runId}: ${r.error}`);
if (failed.length > 10) console.log(`  … ${failed.length - 10} more`);
process.exit(failed.length > 0 ? 1 : 0);
