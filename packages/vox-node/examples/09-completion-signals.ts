/**
 * 09-completion-signals.ts
 *
 * Shows: the three ways to learn that a run has finished, and when each one is
 * the right answer. Everything starts with `hope.workflows.run(slug, input)` (or
 * `hope.agents.run(slug, input)`), which returns a `RunHandle` (SDK 5.0).
 *
 *   1. HOLD THE STREAM — `run.text()` / `run.events()` / `run.wait()`. Lowest
 *      latency, and the SSE lane is the only one that RESUMES (by `seq`, for
 *      you). Costs you a live connection.
 *   2. POLL — `run.wait({ poll: true })`, or `getRun` until
 *      `isTerminalRunStatus(status)`. Needs nothing but an HTTP client and the
 *      `runId` you kept.
 *   3. WEBHOOK — subscribe to the `WorkflowRun` resource type and HOPE posts
 *      you a reference when a run reaches a terminal status. Nothing has to be
 *      connected while the run is in flight.
 *
 * A webhook is a REFERENCE, never content: HOPE posts identifiers and a
 * `fetchUrl`, and you read what you need with your own credentials. Verify the
 * signature over the RAW body before parsing.
 *
 * Closing a stream, breaking out of a `for await`, or aborting a signal NEVER
 * cancels a run — a run is a durable execution. Only `run.cancel()` does.
 *
 * Env vars needed:
 *   HOPE_API_URL              e.g. http://localhost:8868
 *   HOPE_API_KEY              a key with workflow:run:read (+ workflow:run:write to start one)
 *   HOPE_WORKFLOW_SLUG        a published workflow slug
 *   HOPE_AGENT_SLUG           (optional) a published TEXT_GENERATION agent slug, for the agent-run example
 *   HOPE_WEBHOOK_SECRET       the `rawSecret` your webhook subscription returned, for section 3
 *
 * Run: npx tsx examples/09-completion-signals.ts
 */

import { HopeClient, RunFailedError, WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from '@arcaai/vox-node';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const hope = new HopeClient({ baseUrl: requireEnv('HOPE_API_URL'), apiKey: requireEnv('HOPE_API_KEY') });
  const slug = requireEnv('HOPE_WORKFLOW_SLUG');

  // ── 1. Hold the stream ──────────────────────────────────────────────────────
  //
  // `input` is the workflow's input object itself — NOT wrapped in `{ input }`. An
  // `Idempotency-Key` is sent on every start (yours via `{ idempotencyKey }`, else a fresh
  // UUIDv7); the same key JOINS the run in flight instead of starting a second one.
  const run = await hope.workflows.run(slug, { note: 'Dry cough, three days.' }, { idempotencyKey: `completion-demo-${Date.now()}` });

  // KEEP THIS. There is no business-plane route that lists your runs — a run is reachable only
  // by a `runId` you already hold. Persist it before you do anything else with it.
  const runId = run.runId;

  // The text the run writes, as it is written. Frames, tickets and reconnects are the handle's.
  for await (const chunk of run.text()) process.stdout.write(chunk);

  // The delivered value, verified (a large result is fetched by signed URL and its sha256 is
  // checked). `null` when the run completed and delivered nothing. Throws `RunFailedError`
  // when the run did not complete.
  try {
    const delivered = await run.result();
    console.log(`\nrun ${runId} delivered:`, delivered);
  } catch (error) {
    if (!(error instanceof RunFailedError)) throw error;
    console.log(`run ${runId} did not complete: ${error.message}`);
  }

  // The terminal outcome the handle saw. `degraded` is a COMPLETED run with warnings — branch
  // on the flag, never on a status string.
  const outcome = await run.wait();
  console.log(`run ${runId}: ${outcome.status}${outcome.degraded ? ' (with warnings)' : ''}`);

  // ── 2. Poll ─────────────────────────────────────────────────────────────────
  //
  // No stream at all: `GET …/runs/:runId` every `intervalMs`. Use it behind a proxy that buffers
  // `text/event-stream`, or in a cron job that has only the `runId` it stored. `attach` makes no
  // request — it is how a DIFFERENT process picks the run up.
  //
  // `status` is the PERSISTED vocabulary — RUNNING | COMPLETED | FAILED | CANCELED | TIMED_OUT.
  const later = hope.workflows.attach(slug, runId);
  const polled = await later.wait({ poll: true, intervalMs: 2_000 });
  console.log(`polled to terminal: ${polled.status}`);

  // Cancel is explicit and idempotent. `cancel_requested` means the signal was SENT — the run may
  // still be winding down, so read `status` / `wait()` for the final word.
  //
  //   await run.cancel();

  // ── 2b. The same handle for an AGENT run ────────────────────────────────────
  //
  // `hope.agents.run(slug, input)` starts an asynchronous, addressable agent run and returns the
  // very same `RunHandle`. `input` is the agent's invocation body, FLAT — `{ text, context?,
  // variables? }`. An agent run has one step, `nodeId: 'agent'`.
  const agentSlug = process.env.HOPE_AGENT_SLUG;
  if (agentSlug !== undefined) {
    const agentRun = await hope.agents.run(agentSlug, { text: 'Dry cough, three days.' });
    for await (const chunk of agentRun.text()) process.stdout.write(chunk);
    const answer = await agentRun.result();
    console.log(`\nagent run ${agentRun.runId}:`, answer);
  }

  // ── 3. Webhook ──────────────────────────────────────────────────────────────
  //
  // Subscribing is an ADMIN call and needs a SERVICE ACCOUNT holding `svc:webhook:event:write` —
  // that scope predates the `svc:admin:*` convention, so a service account granted every
  // `svc:admin:*` scope still does not have it. Ask for it by name:
  //
  //   await platform.admin.webhookEvent.create({
  //     name: 'workflow-runs',
  //     url: 'https://your-service.example.com/hooks/hope',
  //     resourceTypeName: 'WorkflowRun',
  //   });
  //
  // `resourceTypeName` is matched by plain string equality and validated against no list, so a
  // typo is accepted at create time and then simply never fires.
  //
  // The receiver side is `handleDelivery` below — wire it to your own HTTP framework, reading the
  // signature from the `WEBHOOK_SIGNATURE_HEADER` header and passing the RAW request body.
}

/**
 * Verify, enqueue, return. Never parse before verifying: the digest covers the exact bytes on
 * the wire, and a `JSON.parse` → `JSON.stringify` round trip will never match.
 */
export function handleDelivery(rawBody: Buffer, signatureHeader: string): boolean {
  if (!verifyWebhookSignature(rawBody, signatureHeader, process.env.HOPE_WEBHOOK_SECRET ?? '')) return false;

  // `{ eventType, resourceType, resourceId, tenantId, occurredAt, fetchUrl }` — identifiers only.
  // `resourceId` is the run's domain id and `fetchUrl` points at the admin route that reads it,
  // which your own service-account credentials can fetch. HOPE never posts PHI to a third party.
  const delivery = JSON.parse(rawBody.toString('utf8')) as { resourceType: string; resourceId: string | null };
  if (delivery.resourceType === 'WorkflowRun') {
    // A `WorkflowRun` only ever emits ONE event, and only on a terminal status: the start of a
    // run emits nothing. So this delivery IS "the run finished" — read the row to learn how.
    console.log(`run ${delivery.resourceId ?? '?'} reached a terminal status`);
  }
  return true;
}

/** The header name the delivery arrives under, re-exported so a receiver never hardcodes it. */
export { WEBHOOK_SIGNATURE_HEADER };

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
