/**
 * Live full-loop consultation seed (one-off).
 *
 * NOT wired into `pnpm db:seed`. Companion to `harness-knowledge-ingest-seed.ts`
 * (which ingested the institutional corpus). This seeds the *input* the durable
 * harness workflow consumes: a Tenant-A (Global) consultation + a TRANSCRIPT
 * context item whose topic (stage-2 hypertension management) overlaps the
 * ingested "Clinic Hypertension Management Protocol" so JIT retrieval pulls that
 * chunk and the generated note can cite it.
 *
 * The workflow's `persist_entities` / `assemble` / `persist_draft` callbacks into
 * apps/api require BOTH rows to exist (consultation findById + findTranscripts +
 * the NamedEntity.contextItemId FK), so we create them up front.
 *
 * Idempotent: upsert-by-id. Uses a FRESH consultation id per run (SEED_TAG, the
 * last 4 digits; default `0331`) so the deterministic workflow id
 * `harness-doc-<id>` does not collide with any stuck/parked prior run
 * (e.g. `0330`, which the ▁-attribution fix re-run supersedes).
 *
 * Usage:
 *   NODE_ENV=development SEED_TAG=0331 pnpm --filter @arcaai/database exec \
 *     tsx scripts/harness-consultation-seed.ts
 */
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: live-test driver
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

const TENANT_A = '50000000-0000-0000-0000-000000000000'; // Global customer tenant
const DOCTOR_A = '70000000-0000-0000-0000-000000000010'; // Global doctor (SEED_USER_IDS.DOCTOR)
const DEPT_GEN = '70000000-0000-0000-0003-000000000001'; // OPD (General Outpatient) — the Global catalog's care-setting
// replacement for the retired GEN specialty department (TASK-763 OD-8).
const HYPERTENSION_DOC_ID = 'bbbbbbbb-0000-0000-0000-000000000001'; // from harness-knowledge-ingest-seed.ts

// Fresh id per run (last 4 digits). Default 0331 supersedes the parked 0330 run.
const SEED_TAG = (process.env.SEED_TAG ?? '0331').padStart(4, '0');
const CONSULTATION_ID = `90000000-0000-0000-0000-00000000${SEED_TAG}`;
const TRANSCRIPT_CTX_ID = `91000000-0000-0000-0000-00000000${SEED_TAG}`;

// Stage-2 hypertension follow-up. Deliberately overlaps the institutional
// protocol: target < 130/80, first-line thiazide / CCB (amlodipine), reassess in
// 2–4 weeks then 3–6 months, DASH + sodium + weight + exercise, electrolytes +
// kidney function — so retrieval pulls the protocol chunk and the model can cite
// the general management statements (NOT the patient-specific readings).
const HYPERTENSION_TRANSCRIPT = `Doctor: Good morning. Your home blood pressure readings have been running high — around 150 over 95 most mornings.
Patient: Yes, doctor. I have been checking it twice a day like you asked.
Doctor: Your office reading today is 148 over 94, which confirms stage 2 hypertension. I think we should start medication now.
Patient: What kind of medication would I take?
Doctor: For a patient like you, a reasonable first-line option is a thiazide-type diuretic or a calcium channel blocker such as amlodipine. I will start you on amlodipine 5 mg once daily.
Patient: How often will we check whether it is working?
Doctor: We will reassess your blood pressure and how well you tolerate the medicine in about two to four weeks. Once you are at goal and stable, we will follow up every three to six months.
Doctor: I would also like you to cut back on salt, follow the DASH eating plan, lose some weight, and get regular aerobic exercise. The target we are aiming for is a blood pressure below 130 over 80.
Patient: Understood. I will work on the diet and the exercise.
Doctor: Good. We will also check your kidney function and electrolytes a couple of weeks after starting the medication.`;

async function main() {
  const prisma = getPlatformAdminPrismaClient_Unscoped();

  // 1) Consultation (Tenant A / GEN / DOCTOR). status defaults to OPEN; the
  //    harness persist_draft flips it to PENDING_REVIEW at the end of the loop.
  const consultation = {
    id: CONSULTATION_ID,
    tenantId: TENANT_A,
    patientId: `PAT-20260607-${SEED_TAG}`,
    appointmentDate: new Date('2026-06-07'),
    doctorId: DOCTOR_A,
    departmentId: DEPT_GEN,
    parentConsultationId: null,
    status: 'OPEN' as const,
    metadata: {
      visitType: 'NEW_PATIENT',
      chiefComplaint: 'Elevated home blood pressure readings — stage 2 hypertension management',
      language: 'en',
      // Realism only: the direct document:start trigger does not depend on this.
      pipelineConfig: { harnessEnabled: true },
    },
    createdBy: DOCTOR_A,
  };
  await prisma.consultation.upsert({
    where: { id: CONSULTATION_ID },
    create: consultation,
    update: consultation,
  });
  console.log(`[consultation] upserted ${CONSULTATION_ID} tenant=${TENANT_A} dept=GEN doctor=${DOCTOR_A}`);

  // 2) TRANSCRIPT context item (the loop's transcript source for assemble +
  //    the NamedEntity.contextItemId FK target for persist_entities).
  const transcript = {
    id: TRANSCRIPT_CTX_ID,
    tenantId: TENANT_A,
    consultationId: CONSULTATION_ID,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: HYPERTENSION_TRANSCRIPT,
    dnaWritingStyleId: null,
    createdBy: DOCTOR_A,
  };
  await prisma.contextItem.upsert({
    where: { id: TRANSCRIPT_CTX_ID },
    create: transcript,
    update: transcript,
  });
  console.log(`[contextItem] upserted ${TRANSCRIPT_CTX_ID} type=TRANSCRIPT consultation=${CONSULTATION_ID}`);

  // 3) Echo the ingested hypertension chunk ids so the verifier can match them
  //    against the persisted citationsMap[*].knowledgeChunkIds.
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { knowledgeDocumentId: HYPERTENSION_DOC_ID, tenantId: TENANT_A },
    orderBy: { chunkIndex: 'asc' },
    select: { id: true, chunkIndex: true, status: true },
  });

  console.log('\n===== SEED RESULT =====');
  console.log(
    JSON.stringify(
      {
        consultationId: CONSULTATION_ID,
        transcriptContextItemId: TRANSCRIPT_CTX_ID,
        tenantId: TENANT_A,
        doctorId: DOCTOR_A,
        hypertensionDocId: HYPERTENSION_DOC_ID,
        hypertensionChunkCount: chunks.length,
        hypertensionChunks: chunks,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('CONSULTATION SEED FAILED:', err);
  process.exit(1);
});
