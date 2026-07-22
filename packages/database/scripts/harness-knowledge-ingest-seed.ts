/**
 * Live institutional-RAG seed + ingest driver (one-off).
 *
 * NOT wired into `pnpm db:seed`. This is a manual live-test driver for the
 * Phase-3 full loop. It lives under `packages/database/scripts/**` (the
 * unscoped-client allow-list) and reuses the SAME path the product uses:
 *   register/approve a KnowledgeDocument  ->  enqueue BullMQ
 *   `IngestKnowledgeDocument`  ->  (running apps/api worker) calls the harness
 *   `/api/v1/internal/knowledge/ingest`  ->  chunk + dense(bge-m3) + sparse(BM25)
 *   -> Qdrant upsert + persisted `KnowledgeChunk` rows.
 *
 * It seeds two tenants so cross-tenant isolation is meaningful:
 *   - Tenant A (Global)  : a clinic hypertension-management protocol
 *   - Tenant B (ArcaAI)  : a diabetic foot-care protocol (different topic)
 *
 * Idempotent: KnowledgeDocument rows are upserted by id; the harness point ids
 * are uuid5(tenant:doc:idx) so re-ingest is additive (no dup points).
 *
 * Usage:
 *   NODE_ENV=development pnpm --filter @arcaai/database exec \
 *     tsx scripts/harness-knowledge-ingest-seed.ts
 */
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: live-test driver
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

const TENANT_A = '50000000-0000-0000-0000-000000000000'; // Global customer tenant
const TENANT_B = '50000000-0000-0000-0000-000000000001'; // ArcaAI customer tenant
const DOCTOR_A = '70000000-0000-0000-0000-000000000010'; // Global doctor
const DOCTOR_B = '70000000-0000-0000-0000-000000000040'; // ArcaAI doctor

const DOC_A_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const DOC_B_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── Tenant A corpus: institutional hypertension-management protocol ──────────
const HYPERTENSION_PROTOCOL = `Clinic Hypertension Management Protocol (Adult, Non-Pregnant).

Purpose. This institutional protocol standardizes the diagnosis and pharmacologic management of essential hypertension for adult outpatients across the clinic network. It applies to clinicians prescribing antihypertensive therapy in general practice and cardiology clinics.

Diagnosis and staging. Confirm elevated office blood pressure with out-of-office measurement (home or ambulatory monitoring) before starting drug therapy unless the patient has severe hypertension or evidence of end-organ damage. Stage 1 hypertension is an office systolic blood pressure of 130 to 139 mmHg or diastolic of 80 to 89 mmHg. Stage 2 hypertension is systolic at or above 140 mmHg or diastolic at or above 90 mmHg.

Blood pressure targets. The standard treatment target for most adults is a blood pressure below 130/80 mmHg. For adults aged 65 years and older who are ambulatory and community-dwelling, aim for a systolic blood pressure below 130 mmHg as tolerated, balancing the risk of orthostatic hypotension and falls. Document the individualized target in the chart at the time therapy is started.

First-line agents. First-line pharmacologic therapy is one of: a thiazide-type diuretic (chlorthalidone is preferred over hydrochlorothiazide for its longer duration of action), a dihydropyridine calcium channel blocker such as amlodipine, an ACE inhibitor such as lisinopril, or an angiotensin receptor blocker such as losartan. Do not combine an ACE inhibitor with an ARB. For most patients with stage 2 hypertension or a blood pressure more than 20/10 mmHg above target, initiate therapy with two first-line agents from different classes, preferably as a single-pill combination to improve adherence.

Special populations. In Black adults without heart failure or chronic kidney disease, a thiazide-type diuretic or a calcium channel blocker is preferred as initial therapy. In patients with diabetes and albuminuria, or in chronic kidney disease, an ACE inhibitor or an ARB is preferred for its kidney-protective effect. Avoid ACE inhibitors and ARBs in pregnancy.

Monitoring and follow-up. After starting or changing therapy, reassess blood pressure and review tolerability within 2 to 4 weeks. Once blood pressure is at goal and stable, follow up every 3 to 6 months. Check serum electrolytes and kidney function within 2 to 4 weeks of starting or titrating an ACE inhibitor, an ARB, or a diuretic, and periodically thereafter. Reinforce lifestyle measures at every visit: sodium restriction, the DASH dietary pattern, weight loss, regular aerobic activity, and moderation of alcohol intake.

Escalation. If blood pressure remains above target on an adequately dosed two-drug regimen, add a third first-line agent before labeling the patient as resistant. Confirm adherence, exclude white-coat effect with out-of-office readings, and screen for secondary causes when resistant hypertension is suspected.`;

// ── Tenant B corpus: a deliberately DIFFERENT topic (isolation control) ──────
const DIABETIC_FOOT_PROTOCOL = `Diabetic Foot Care and Ulcer Prevention Protocol.

Purpose. This protocol guides screening, risk stratification, and preventive care of the diabetic foot for adults with type 1 or type 2 diabetes mellitus in the outpatient setting.

Annual screening. Perform a comprehensive foot examination at least once a year for all patients with diabetes, and more frequently for those with prior ulceration, amputation, or peripheral arterial disease. Assess protective sensation with a 10-gram monofilament at the plantar surfaces, test vibration with a 128-Hz tuning fork, and palpate the dorsalis pedis and posterior tibial pulses.

Risk stratification. Categorize each patient as low, moderate, or high risk based on loss of protective sensation, foot deformity, peripheral arterial disease, and ulcer or amputation history. Match the follow-up interval and footwear referral to the risk category.

Daily care education. Instruct patients to inspect their feet daily, wash and dry between the toes, apply emollient to dry skin but not between the toes, never walk barefoot, and check footwear for foreign objects before wearing. Cut nails straight across and avoid self-treating corns and calluses.

Wound management. Refer any new foot ulcer urgently to the multidisciplinary foot care service for debridement, offloading with total contact casting or a removable walker, infection assessment, and vascular evaluation. Maintain glycemic control and treat infection with culture-directed antibiotics.`;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const prisma = getPlatformAdminPrismaClient_Unscoped();

  const docs = [
    {
      id: DOC_A_ID,
      tenantId: TENANT_A,
      createdBy: DOCTOR_A,
      title: 'Clinic Hypertension Management Protocol',
      source: 'institutional/protocols/hypertension-management.md',
      text: HYPERTENSION_PROTOCOL,
    },
    {
      id: DOC_B_ID,
      tenantId: TENANT_B,
      createdBy: DOCTOR_B,
      title: 'Diabetic Foot Care and Ulcer Prevention Protocol',
      source: 'institutional/protocols/diabetic-foot-care.md',
      text: DIABETIC_FOOT_PROTOCOL,
    },
  ];

  // 1) Register + approve the KnowledgeDocument rows (DRAFT -> APPROVED).
  for (const d of docs) {
    const base = {
      tenantId: d.tenantId,
      title: d.title,
      source: d.source,
      sourceType: 'text',
      mimeType: 'text/plain',
      checksum: sha256(d.text),
      status: 'APPROVED' as const,
      approvedBy: d.createdBy,
      approvedAt: new Date(),
      createdBy: d.createdBy,
      updatedBy: d.createdBy,
    };
    await prisma.knowledgeDocument.upsert({
      where: { id: d.id },
      create: { id: d.id, ...base },
      update: base,
    });
    console.log(`[doc] upserted ${d.id} tenant=${d.tenantId} "${d.title}"`);
  }

  // 2) Enqueue the REAL BullMQ ingest jobs (consumed by the running apps/api
  //    worker). Same queue name + connection the app uses (default prefix).
  const connection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASS || undefined,
  };
  const queue = new Queue('IngestKnowledgeDocument', { connection });

  for (const d of docs) {
    const jobId = `live-ingest-${d.id}`;
    // Make the driver re-runnable: drop any prior (e.g. failed) job with this id.
    await queue.remove(jobId).catch(() => undefined);
    await queue.add(
      'IngestKnowledgeDocument',
      { jobId, knowledgeDocumentId: d.id, tenantId: d.tenantId, userId: d.createdBy, text: d.text },
      { jobId, attempts: 3, removeOnComplete: false, removeOnFail: false },
    );
    console.log(`[queue] enqueued ingest job ${jobId}`);
  }

  // 3) Poll for the persisted KnowledgeChunk rows (worker -> harness -> Qdrant
  //    -> persist). ~90s budget (first call JIT-warms the bge-m3 path).
  const deadline = Date.now() + 90_000;
  const counts: Record<string, number> = {};
  while (Date.now() < deadline) {
    let allDone = true;
    for (const d of docs) {
      counts[d.id] = await prisma.knowledgeChunk.count({
        where: { knowledgeDocumentId: d.id, tenantId: d.tenantId },
      });
      if (counts[d.id] === 0) allDone = false;
    }
    if (allDone) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  // 4) Report evidence: chunk rows + doc ingest markers + Qdrant point ids.
  console.log('\n===== INGEST RESULT =====');
  for (const d of docs) {
    const doc = await prisma.knowledgeDocument.findUnique({ where: { id: d.id } });
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { knowledgeDocumentId: d.id, tenantId: d.tenantId },
      orderBy: { chunkIndex: 'asc' },
      select: {
        chunkIndex: true,
        qdrantPointId: true,
        embeddingModel: true,
        embeddingDim: true,
        status: true,
        tokenCount: true,
      },
    });
    console.log(JSON.stringify(
      {
        docId: d.id,
        tenantId: d.tenantId,
        title: d.title,
        doc_status: doc?.status,
        doc_ingestedAt: doc?.ingestedAt,
        doc_chunkCount: doc?.chunkCount,
        persisted_chunk_rows: chunks.length,
        chunks,
      },
      null,
      2,
    ));
  }

  await queue.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('SEED DRIVER FAILED:', err);
  process.exit(1);
});
