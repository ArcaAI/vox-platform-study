/**
 * TASK-687 real-database proof — the note-row invariant, against live Postgres.
 *
 * Not a unit test. Runs against the ISOLATED test database on port 5433 ONLY
 * (documented throwaway; `pnpm infra:test:down` removes its volumes):
 *
 *   pnpm infra:test:up
 *   cd packages/database && DATABASE_URL=postgresql://test:test@localhost:5433/hope_test \
 *     DIRECT_URL=... npx prisma db push --schema src/prisma/db_main
 *   DATABASE_URL=postgresql://test:test@localhost:5433/hope_test \
 *     DIRECT_URL=... npx tsx packages/applications/scripts/task687-db-proof.ts
 *
 * The live Temporal proof (apps/harness/scripts/task687_live_proof.py) shows the two
 * workflow EXECUTIONS and the Idempotency-Keys they emit. This proves the other half:
 * that `findOwnHarnessDraft`'s lookup — the thing the note-row invariant actually rests
 * on, because the Redis replay cache degrades to `work()` — resolves correctly against
 * real rows, and in particular that it REFUSES to adopt a RAW_SUMMARY written by any of
 * the five non-harness generators.
 */
// The repo's own factory (Prisma 7 needs the pg driver adapter it wires up). No CLS
// tenant provider is registered here, so the tenant-scope extension passes through.
import { getExtendedPrismaClient } from '@arcaai/database';

const HARNESS_DRAFT_SUBTYPE = 'HARNESS_DRAFT';
const TENANT = '00000000-0000-0000-0000-000000000000';
const SYSTEM_USER = '60000000-0000-0000-0000-000000000000';

const prisma = getExtendedPrismaClient() as never as {
  contextItem: Record<string, (args?: never) => Promise<never>>;
  user: Record<string, (args?: never) => Promise<never>>;
  consultation: Record<string, (args?: never) => Promise<never>>;
  $disconnect: () => Promise<void>;
};

/** The exact shape of `HarnessInternalService.findOwnHarnessDraft`. */
async function findOwnHarnessDraft(consultationId: string) {
  const rows = await prisma.contextItem.findMany({
    where: { consultationId, type: 'RAW_SUMMARY', resourceStatus: { not: 'DELETED' } },
    orderBy: { createdAt: 'asc' },
  });
  const owned = rows.filter((r) => (r.metaData as Record<string, unknown> | null)?.subType === HARNESS_DRAFT_SUBTYPE);
  if (owned.length === 0) return null;
  return owned.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
}

let doctorId = '';

async function makeDoctor() {
  const user = await prisma.user.create({
    data: { username: `t687-${Date.now()}`, password: 'x', createdBy: SYSTEM_USER },
  });
  doctorId = (user as unknown as { id: string }).id;
}

async function makeConsultation(label: string) {
  return prisma.consultation.create({
    data: {
      tenantId: TENANT,
      patientId: `patient-${label}`,
      appointmentDate: new Date(),
      doctorId,
      createdBy: SYSTEM_USER,
    },
  }) as unknown as Promise<{ id: string }>;
}

const rawSummary = (consultationId: string, content: string, metaData: unknown) => ({
  tenantId: TENANT,
  consultationId,
  type: 'RAW_SUMMARY' as const,
  source: 'AI' as const,
  encryptedContent: Buffer.from(content, 'utf8'),
  metaData: metaData as never,
  createdBy: SYSTEM_USER,
});

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail: string) => results.push([name, pass, detail]);

async function main() {
  await makeDoctor();

  // ---- A. Two executions over the same consultation → exactly ONE note row.
  const a = await makeConsultation('caseB');
  // Execution 1 finds nothing and creates, stamping the ownership marker.
  const before = await findOwnHarnessDraft(a.id);
  const created = await prisma.contextItem.create({
    data: rawSummary(a.id, 'DRAFT v1', { subType: HARNESS_DRAFT_SUBTYPE }),
  });
  // Execution 2 (new run id ⇒ the replay cache cannot help) finds execution 1's row.
  const adopted = await findOwnHarnessDraft(a.id);
  await prisma.contextItem.update({ where: { id: adopted!.id }, data: { encryptedContent: Buffer.from('DRAFT v2', 'utf8') } });
  const rowsA = await prisma.contextItem.count({ where: { consultationId: a.id, type: 'RAW_SUMMARY' } });
  const finalA = await prisma.contextItem.findUnique({ where: { id: created.id } });

  check('exec 1 finds no prior draft', before === null, `found=${before?.id ?? 'null'}`);
  check('exec 2 adopts exec 1 row', adopted?.id === created.id, `adopted=${adopted?.id}`);
  check('NOTE ROWS after 2 executions == 1', rowsA === 1, `count=${rowsA}`);
  check('the adopted note UPDATED (not ignored)', Buffer.from(finalA!.encryptedContent as never).toString('utf8') === 'DRAFT v2', `content=${Buffer.from(finalA!.encryptedContent as never).toString('utf8')}`);

  // ---- B. A RAW_SUMMARY from a NON-harness generator is never adopted.
  const b = await makeConsultation('foreign');
  await prisma.contextItem.create({ data: rawSummary(b.id, 'SummaryService note', null) });
  await prisma.contextItem.create({ data: rawSummary(b.id, 'BullMQ processor note', { subType: 'SOMETHING_ELSE' }) });
  const foreign = await findOwnHarnessDraft(b.id);
  check('never adopts another generator’s note', foreign === null, `found=${foreign?.id ?? 'null'}`);

  // ---- C. Never crosses consultations.
  const crossed = await findOwnHarnessDraft(b.id);
  check('never crosses consultations', crossed?.id !== created.id, `found=${crossed?.id ?? 'null'}`);

  // ---- D. Newest-wins over pre-existing duplicates left by the defect.
  const d = await makeConsultation('preexisting');
  const dup1 = await prisma.contextItem.create({ data: rawSummary(d.id, 'dup 1', { subType: HARNESS_DRAFT_SUBTYPE }) });
  await new Promise((r) => setTimeout(r, 10));
  const dup2 = await prisma.contextItem.create({ data: rawSummary(d.id, 'dup 2', { subType: HARNESS_DRAFT_SUBTYPE }) });
  const converged = await findOwnHarnessDraft(d.id);
  check('converges onto the newest duplicate', converged?.id === dup2.id, `picked=${converged?.id === dup2.id ? 'dup2' : converged?.id === dup1.id ? 'dup1' : 'none'}`);

  console.log('\n===== TASK-687 REAL-DATABASE PROOF (postgres :5433) =====');
  for (const [name, pass, detail] of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`);
  }
  const ok = results.every(([, pass]) => pass);
  console.log(`\nRESULT: ${ok ? 'PASS — all invariants hold against live rows' : 'FAIL'}`);
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
