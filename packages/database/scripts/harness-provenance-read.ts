/**
 * Live full-loop provenance READ-ONLY verification (one-off).
 *
 * Companion to `harness-consultation-seed.ts`. After the Temporal loop
 * persists the RAW_SUMMARY draft, this reads back the persisted provenance the
 * apps/api `GET /consultations/:id/summary/:ctx/provenance` endpoint serializes
 * (SummaryMeta.citationsMap + .guardrailDecisions) and prints the proof:
 *   - consultation status (expected PENDING_REVIEW),
 *   - the citation_verify sensor result (total / supported / decision),
 *   - the substantive claims carrying knowledgeChunkIds (institutional citations),
 *   - the generated note (so the inline [[kb:<id>]] marker is visible).
 *
 * READ-ONLY: SELECT only (findUnique / findMany / findFirst). No writes.
 *
 * Usage:
 *   NODE_ENV=development SEED_TAG=0331 pnpm --filter @arcaai/database exec \
 *     tsx scripts/harness-provenance-read.ts
 */
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: live-test driver
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

const SEED_TAG = (process.env.SEED_TAG ?? '0331').padStart(4, '0');
const CONSULTATION_ID = `90000000-0000-0000-0000-00000000${SEED_TAG}`;
const TARGET_CHUNK = 'ad1bd3fc-bb10-52d5-b3c5-adb8c5360ae5';

async function main() {
  const prisma = getPlatformAdminPrismaClient_Unscoped();

  const consult = await prisma.consultation.findUnique({
    where: { id: CONSULTATION_ID },
    select: { id: true, status: true, tenantId: true },
  });

  const items = await prisma.contextItem.findMany({
    where: { consultationId: CONSULTATION_ID, type: 'RAW_SUMMARY' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, type: true, content: true, createdAt: true },
  });
  const draft = items[0] ?? null;

  const summary = draft
    ? await prisma.summaryMeta.findFirst({
        where: { contextItemId: draft.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          modelName: true,
          entityFaithfulnessScore: true,
          coverageScore: true,
          ragTriadScore: true,
          citationsMap: true,
          guardrailDecisions: true,
        },
      })
    : null;

  const cmap = (summary?.citationsMap ?? {}) as { claims?: any[] };
  const claims = Array.isArray(cmap.claims) ? cmap.claims : [];
  const cited = claims.filter((c) => Array.isArray(c?.knowledgeChunkIds) && c.knowledgeChunkIds.length > 0);
  const targetClaims = cited.filter((c) => c.knowledgeChunkIds.includes(TARGET_CHUNK));

  console.log('===== Harness provenance proof =====');
  console.log(`consultationId   : ${CONSULTATION_ID}`);
  console.log(`consult.status   : ${consult?.status}`);
  console.log(`summaryCtxItemId : ${draft?.id}`);
  console.log(`modelName        : ${summary?.modelName}`);
  console.log(
    `scores           : entityFaithfulness=${summary?.entityFaithfulnessScore} coverage=${summary?.coverageScore} ragTriad=${summary?.ragTriadScore}`,
  );
  console.log(`claims (total)   : ${claims.length}`);
  console.log(`claims w/ chunkIds: ${cited.length}`);
  console.log(`claims citing ${TARGET_CHUNK}: ${targetClaims.length}`);

  console.log('\n----- guardrailDecisions (inferential sensors incl. citation_verify) -----');
  console.log(JSON.stringify(summary?.guardrailDecisions ?? null, null, 2));

  console.log('\n----- substantive claims carrying knowledgeChunkIds -----');
  console.log(
    JSON.stringify(
      cited.map((c) => ({
        id: c.id,
        text: c.text,
        section: c.section,
        status: c.status,
        knowledgeChunkIds: c.knowledgeChunkIds,
      })),
      null,
      2,
    ),
  );

  console.log('\n----- generated note (RAW_SUMMARY content) -----');
  console.log(draft?.content);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('PROVENANCE READ FAILED:', err);
  process.exit(1);
});
