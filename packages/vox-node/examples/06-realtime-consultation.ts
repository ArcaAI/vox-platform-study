/**
 * 06-realtime-consultation.ts
 *
 * Shows: the whole machine-driven consultation journey end to end —
 * open → start recording → watch the live summary → stop recording →
 * release a `core.humanReview` gate (when the governing workflow has one) →
 * approve the summary → close the consultation → read the context items and
 * the note back.
 *
 * This is the SERVICE-ACCOUNT shape: a machine identity opens a
 * consultation on behalf of a named clinician. An API-key / human-JWT caller
 * follows the same calls but omits `clinicianUserId` everywhere — see each
 * field's doc comment on `OpenConsultationRequest` / `ApproveSummaryRequest` /
 * `CloseConsultationRequest`.
 *
 * Env vars needed:
 *   HOPE_API_URL              e.g. http://localhost:8868
 *   HOPE_SVC_CLIENT_ID        a service-account client id
 *   HOPE_SVC_CLIENT_SECRET    its secret
 *   HOPE_PATIENT_ID           the tenant's own patient identifier
 *   HOPE_CLINICIAN_USER_ID    the clinician this consultation belongs to
 *
 * Run: npx tsx examples/06-realtime-consultation.ts
 */

import { HopeClient, NotFoundError } from '@arcaai/vox-node';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const hope = new HopeClient({
    baseUrl: requireEnv('HOPE_API_URL'),
    serviceAccount: { clientId: requireEnv('HOPE_SVC_CLIENT_ID'), clientSecret: requireEnv('HOPE_SVC_CLIENT_SECRET') },
  });

  // ── 1. Open (get-or-create) ─────────────────────────────────────────────────
  //
  // `open<TContext>` is generic on the `context` shape — a caller who ran
  // `vox-codegen --tenant` passes the generated `OpenConsultationContext` here
  // instead of an untyped `Record<string, unknown>`.
  const consultation = await hope.consultations.open({
    patientId: requireEnv('HOPE_PATIENT_ID'),
    clinicianUserId: requireEnv('HOPE_CLINICIAN_USER_ID'),
  });
  console.log(`consultation ${consultation.id} — isNew=${consultation.isNew ?? false}`);

  // `governingRun` is derived from the persisted marker, never a live harness call — `null` means
  // no workflow was dispatched (an unresolvable department assignment, or a harness outage at
  // open, which never blocks opening a consultation).
  if (consultation.governingRun) {
    console.log(`governed by ${consultation.governingRun.workflowDefinitionSlug} (run ${consultation.governingRun.workflowRunId})`);
  } else {
    console.log('this consultation is ungoverned — no workflow is watching it');
  }

  // ── 2. Start recording, watch the live summary, stop ────────────────────────
  const stream = await hope.stt.createStreamSession();
  await hope.consultations.recording.start(consultation.id, { sessionId: stream.sessionId });

  const liveSummary = hope.consultations.streams.liveSummary(consultation.id, {
    onSnapshot(event) {
      console.log(`live summary: ${event.closed ? 'closed' : 'updated'}`);
    },
    onPreSummary(event) {
      console.log(`pre-summary: ${event.status}`);
    },
    // Required — a subscription is fire-and-forget, and a 403 with nowhere to go is
    // indistinguishable from a quiet consultation unless you handle this.
    onError(error) {
      console.error('live summary stream failed:', error);
    },
  });

  // … the caller streams audio over `hope.stt.socket(stream)` here (see `RealtimeSttSocket`) …

  liveSummary.close();
  await hope.consultations.recording.stop(consultation.id);

  // ── 3. Release the review gate, if the governing workflow parked on one ─────
  //
  // `WorkflowSchemaDescription.reviewNodes` is how you discover the node id without
  // hardcoding it — read once per workflow definition, not per run.
  if (consultation.governingRun) {
    const schema = await hope.workflows.schema(consultation.governingRun.workflowDefinitionSlug);
    for (const { nodeId } of schema.reviewNodes) {
      try {
        const review = await hope.workflows.reviews.get(
          consultation.governingRun.workflowDefinitionSlug,
          consultation.governingRun.workflowRunId,
          nodeId,
        );
        if (review.exists && !review.decided) {
          await hope.workflows.reviews.decide(consultation.governingRun.workflowDefinitionSlug, consultation.governingRun.workflowRunId, nodeId, {
            decision: 'approved',
          });
          console.log(`review ${nodeId} approved`);
        }
      } catch (error) {
        if (error instanceof NotFoundError) console.log(`review ${nodeId} not found for this tenant`);
        else throw error;
      }
    }
  }

  // ── 4. Approve the summary, then close ──────────────────────────────────────
  //
  // Both routes are OCC-guarded — read the row's `version` and pass it as `ifMatch`. `close()` is
  // legal only from `SIGNED` or `TIMED_OUT`: on a `PENDING_REVIEW` consultation, `approve()` must
  // succeed first, or `close()` answers 409.
  const latest = await hope.consultations.summaries.latest(consultation.id);
  if (latest) {
    await hope.consultations.summaries.approve(
      consultation.id,
      latest.id,
      { clinicianUserId: requireEnv('HOPE_CLINICIAN_USER_ID') },
      { ifMatch: latest.version ?? 1 },
    );
    console.log('summary approved and signed');
  }

  const signed = await hope.consultations.get(consultation.id);
  await hope.consultations.close(consultation.id, { clinicianUserId: requireEnv('HOPE_CLINICIAN_USER_ID') }, { ifMatch: signed.version ?? 1 });
  console.log(`consultation ${consultation.id} closed`);

  // ── 5. Read back what you sent, and the run it got ──────────────────────────
  const items = await hope.consultations.listContext(consultation.id);
  for (const item of items) {
    if (item.kindKey) console.log(`context item ${item.id}: kind=${item.kindKey} schemaVersion=${item.contextSchemaVersionId}`);
  }

  const closedConsultation = await hope.consultations.get(consultation.id);
  console.log(`final governingRun status: ${closedConsultation.governingRun?.status ?? 'ungoverned'}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
