/**
 * 09-completion-signals.ts
 *
 * Shows: the three ways to learn that a workflow run has finished, and when
 * each one is the right answer.
 *
 *   1. HOLD THE STREAM — `runAndStream` / `waitForRun`. Lowest latency, and the
 *      SSE lane is the only one that RESUMES. Costs you a live connection.
 *   2. POLL — `getRun` until `isTerminalRunStatus(status)`. Needs nothing but
 *      an HTTP client and the `runId` you kept.
 *   3. WEBHOOK — subscribe to the `WorkflowRun` resource type and HOPE posts
 *      you a reference when a run reaches a terminal status. Nothing has to be
 *      connected while the run is in flight.
 *
 * A webhook is a REFERENCE, never content: HOPE posts identifiers and a
 * `fetchUrl`, and you read what you need with your own credentials. Verify the
 * signature over the RAW body before parsing.
 *
 * Env vars needed:
 *   HOPE_API_URL              e.g. http://localhost:8868
 *   HOPE_API_KEY              a key with workflow:run:read (+ workflow:run:write to start one)
 *   HOPE_WORKFLOW_SLUG        a published workflow slug
 *   HOPE_WEBHOOK_SECRET       the `rawSecret` your webhook subscription returned, for section 3
 *
 * Run: npx tsx examples/09-completion-signals.ts
 */

import { HopeClient, WEBHOOK_SIGNATURE_HEADER, isTerminalRunStatus, verifyWebhookSignature } from '@arcaai/vox-node';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const hope = new HopeClient({ baseUrl: requireEnv('HOPE_API_URL'), apiKey: requireEnv('HOPE_API_KEY') });
  const slug = requireEnv('HOPE_WORKFLOW_SLUG');

  // ── 1. Hold the stream ──────────────────────────────────────────────────────
  const handle = await hope.workflows.run(slug, { input: { note: 'Dry cough, three days.' } });

  // KEEP THIS. There is no business-plane route that lists your runs — a run is reachable only
  // by a `runId` you already hold. Persist it before you do anything else with it.
  const runId = handle.runId;

  const finished = await hope.workflows.waitForRun(slug, runId);
  console.log(`run ${runId}: ${finished.status}${finished.degraded ? ' (with warnings)' : ''}`);
  console.log(`  nodes ${finished.nodeCount ?? '?'} · failed ${finished.failedNodeCount ?? 0} · degraded ${finished.degradedNodeCount ?? 0}`);

  // ── 2. Poll ─────────────────────────────────────────────────────────────────
  //
  // `status` is the PERSISTED vocabulary — RUNNING | COMPLETED | FAILED | CANCELED | TIMED_OUT.
  // The interpreter's own `SUCCEEDED` / `DEGRADED` never reach you: a degraded run is COMPLETED
  // with `degraded: true`, so branch on the flag, never on a status string.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await hope.workflows.getRun(slug, runId);
    if (isTerminalRunStatus(status.status)) {
      console.log(`polled to terminal: ${status.status}`);
      break;
    }
    await sleep(2_000);
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
