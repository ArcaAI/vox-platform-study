/**
 * TASK-702 — Data migration for deployed rows: overwrite the free-text
 * ICD-10 code-emission instruction that Tasks 2-3 removed from the SEED, on
 * any DEPLOYED `PromptTemplate` row whose content is still byte-identical to
 * what the OLD (pre-fix) seed wrote.
 *
 * WHY
 * ---
 * `promptTemplate.upsert` (`update: data, create: data`) means a FRESH seed
 * run on an empty/reset dev DB always gets the fixed content — but a database
 * where the seed already ran once (staging, prod, or any long-lived dev DB
 * not periodically `db push --force-reset`) keeps its already-persisted row
 * content until something explicitly re-writes it. Re-running `pnpm db:seed`
 * is not a deploy mechanism for staging/prod (migrations are), and a blind
 * re-seed's `upsert` would silently clobber any tenant-customized row at the
 * same id — this script exists to do the narrower, safer thing: fix ONLY
 * rows that are still exactly what the old seed wrote.
 *
 * WHAT IT TOUCHES
 * ---------------
 * The 12 base-catalog `PromptTemplate` rows (`TEMPLATE_IDS.SOAP_SUMMARY` +
 * the 11 department templates) and the 22 ArcaAI clinical-library
 * `PromptTemplate` rows (`ARCAAI_CLINICAL_TEMPLATE_IDS`, excluding
 * PRE_SUMMARY, which never carried an ICD-10 instruction) named in the
 * ticket README §2.1/§2.2. For each row whose CURRENT `content` fingerprints
 * (sha256) to the known-bad pre-fix value:
 *   - `content` (+ `metaData` for SOAP_SUMMARY, whose structured-output
 *     schema description also changed) is overwritten with the value the
 *     seed now ships (imported directly from the seed modules — single
 *     source of truth, no copy-pasted "new" text in this file).
 *   - The matching `PromptVersion` snapshot is corrected the SAME way the
 *     seed now writes it: for the 11 department templates and the 22 ArcaAI
 *     templates, that is their ONE existing version row (versionNumber 1 for
 *     base-catalog department templates — `DEFAULT_PROMPT_VERSIONS` derives
 *     its content live from the template, so there never was a frozen "v1
 *     as originally shipped" snapshot distinct from the template's own
 *     content; versionNumber `ARCAAI_CLINICAL_APPROVED_VERSION` (3) for
 *     ArcaAI, whose `07b-arcaai-clinical-content-v3.ts` was corrected in
 *     place by Task 3) is updated in place, found by
 *     `{ promptTemplateId, versionNumber }` rather than a hardcoded row id.
 *   - SOAP_SUMMARY is the one exception: its existing versionNumber 3
 *     `PromptVersion` row is a preserved HISTORICAL snapshot (see
 *     `EXTRA_PROMPT_VERSIONS` in `07-prompt-template.ts`) and is never
 *     touched; instead this script inserts the SAME new versionNumber 4 row
 *     the seed now ships (`EXTRA_PROMPT_VERSIONS` id
 *     `72000000-0000-0000-0000-000000000105`) and bumps
 *     `currentVersionNumber` to 4, exactly mirroring the seed.
 *
 * A row whose current content does NOT match the known-bad fingerprint is
 * NEVER overwritten — whether because it already carries the fix (idempotent
 * no-op) or because a tenant admin customized it since seeding (logged as
 * DRIFTED, see below). Deciding what to do with a drifted row is a human,
 * business decision this script does not make.
 *
 * SAFETY
 * ------
 *   - DRY RUN IS THE DEFAULT. Nothing is written unless `--apply` is passed.
 *   - All writes run inside a single interactive transaction; any error
 *     rolls the whole batch back.
 *   - Idempotent: a second run finds every target already-fixed and exits 0
 *     having written nothing.
 *   - Pre-flight printout, before any write, classifies every target row as
 *     to-fix / already-fixed / drifted / not-found.
 *
 * USAGE
 * -----
 *   # 1. dry run (default) — prints the plan, writes nothing
 *   NODE_ENV=development pnpm --filter @arcaai/database exec \
 *     tsx scripts/migrate-icd10-prompt-instructions.ts
 *
 *   # 2. scope to one tenant while reviewing
 *   ... tsx scripts/migrate-icd10-prompt-instructions.ts --tenant 50000000-0000-0000-0000-000000000000
 *
 *   # 3. apply, after the dry-run output has been reviewed
 *   ... tsx scripts/migrate-icd10-prompt-instructions.ts --apply
 *
 * Against a remote database, set DATABASE_URL explicitly. HUMAN-GATED:
 * `--apply` against any real deployed database requires the user's explicit
 * go-ahead — see the ticket README §6.
 *
 * Exit codes: 0 success (or nothing to do) · 1 runtime error · 2 bad invocation.
 */
import { createHash } from 'crypto';

import { ARCAAI_CLINICAL_APPROVED_VERSION, ARCAAI_CLINICAL_TEMPLATES, ARCAAI_CLINICAL_TEMPLATE_IDS } from '../src/prisma/db_main/seed/07b-arcaai-clinical-templates';
import { DEFAULT_PROMPT_TEMPLATES, EXTRA_PROMPT_VERSIONS, TEMPLATE_IDS } from '../src/prisma/db_main/seed/07-prompt-template';
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: maintenance task must see every tenant's rows
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Known-bad sha256 fingerprints of the EXACT pre-fix `content` string each
 * row carried before this ticket's Tasks 2-3, computed once (before editing)
 * against the live tree on 2026-08-16 — see the ticket README §2.1/§2.2 for
 * the source excerpts each hash corresponds to. A deployed row's fingerprint
 * matching one of these means "unmodified since the old (bad) seed wrote
 * it" — the only condition under which this script will overwrite it.
 */
const KNOWN_BAD_SHA256: Record<string, string> = {
  [TEMPLATE_IDS.SOAP_SUMMARY]: '455d0dd74d30d08ae5e8657c645b07ce0ba307d79e939d7a144d687a50257acd',
  [TEMPLATE_IDS.SURGERY_NEW_REFERRAL]: 'a51bc83df1ad5b242e7619a19eeaaaa95355fd3d6714aef79e284fffbcbdb199',
  [TEMPLATE_IDS.MEDICINE_NEW_REFERRAL]: 'bc4e33ed4345d11a2d815f3f7ebd74f61da01434461fe962d9f3eacb976b96fd',
  [TEMPLATE_IDS.MEDICINE_REVISIT]: '545f4b0a3a2dbbd6d6c807f94bc40d75f260669d77af5e2a31604787217a7809',
  [TEMPLATE_IDS.BREN_NEW_REFERRAL]: 'eb3f99f9c6795e71a66ada0cd39ac32388aefd3cb80372fdd56f6d4a081fe368',
  [TEMPLATE_IDS.RHEUM_NEW_REFERRAL]: 'cda5947ef8f8020a08aab8559b539bd16dad1a4486ac2b3c8ef1de0e7a0b8aa1',
  [TEMPLATE_IDS.RHEUM_REVISIT]: '9cb641a77c5ebd74c9764b0b922ee666294359c2da4588f8a36fb00cfc5c91c0',
  [TEMPLATE_IDS.ORTH_NEW_REFERRAL]: 'a2d5dbe04078d4e6d4d42a26e150e0559de37ff81e7cd173d3814117edb21fdb',
  [TEMPLATE_IDS.ORTH_REVISIT]: 'c3cdf308351a7c3611b2899dc3b019dcdb179a59d4bd94d4e03e58c26a7fe7c3',
  [TEMPLATE_IDS.NEUR_NEW_REFERRAL]: '33099e0b2eb33478f09607f8593dc5e13a7970963c10771e427156f04f603137',
  [TEMPLATE_IDS.NEUR_REVISIT]: 'ed1aaba89c6f75aad1ea9ee3e7ba6b798d65a40d2b27c827d5fc70ac4db3b7ab',
  [TEMPLATE_IDS.NEPH_NEW_REFERRAL]: 'e658cfb8a4b5041f950872fd1feaa0dd284f3e1620b0fd55be37c425fc82918c',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_NEW_REFERRAL]: 'f60b9e059f77223e0f3201a887738652ebac84e2380e90565b0858e03bd927a5',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_FOLLOWUP]: 'ab51ae4ff01715bf168ecd2d7ca14be6b2833e2899befa49a36d776546ed8abf',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.MEDICINE_NEW_REFERRAL]: '9f4dca373be9b734113cdbf8b8b79ab6da485804e5553238d6702bb653597658',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.MEDICINE_FOLLOWUP]: '5a6968f52ce9aa29b0edf502e1b05a6f9605069149114caa17e3938c7eb1a61c',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.RHEUMATOLOGY_NEW_REFERRAL]: 'eb9c1ec6b03ed1e79bc2a46718fdaeb9a6fbf5f5eb9d7a0820bad41d35019901',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.RHEUMATOLOGY_FOLLOWUP]: '05577e99cea3a752b6417498fb095af77ae9f0cc4cd5271b716ee8bc036cf27b',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.NEUROLOGY_NEW_REFERRAL]: '4704e09d244723828fd13b20e729d1bcf71cdbaf3d5e59c9fc978d36202f2a99',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.NEUROLOGY_FOLLOWUP]: '5fffe20a4f3e455f33c3d1491e19e8049eb5840b16ac1b7a93d5771f7eaa15ac',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.ORTHOPEDICS_NEW_REFERRAL]: '5270678b80e8b4094cbfde4a0ef4a05c385d2e849f49a58189d3037fe85c6eb7',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.ORTHOPEDICS_REVIEW]: '3ca2ef4e16f42e59c87640839233178fc273110bfd2530deafb126c449d3275d',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.HEMATOLOGY_NEW_REFERRAL]: 'ee69bad6b594cc38c18645c9cfb66b81f5105c29b33b9f129588283e0c57d241',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.HEMATOLOGY_REVISIT]: '934e9ee538fd08db8b168cbb3a5c7c156a3abe3005fcf0f41e1c6940d2820266',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.BREAST_ENDOCRINE_NEW_REFERRAL]: '38b25b057537fa3a782d5e1921f52eaa52c7d3e7dccee0af727ce180f242d3ee',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.BREAST_ENDOCRINE_FOLLOWUP]: '6148bc658de0d98d0dc141b8be33c39112a2b7eb2a324db2059473570e0eeb21',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.DERMATOLOGY_NEW_REFERRAL]: '134f7039a9a70e83459c6398921cbc9df707fd7eab59a8213b8ec68b96b105e9',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.DERMATOLOGY_FOLLOWUP]: '30d1d5913b8faa8489fffc6da9159ab7dfa887fc7f98bf1879e76bcfcb39c0f8',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.DIETETICS_NEW_REFERRAL]: '312e74b25e48b4c1dc69155f996dd51f22d4c5bd2b4fa3418c70fc8b27fe3aa3',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.DIETETICS_FOLLOWUP]: '0fbbeb79abf37ffb8798f1ec0ce18a6ecba2e4da6ca61c8d3f1cc124c0875ab9',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.NEPHROLOGY_NEW_REFERRAL]: '413635f1a04c0020ddd3fbc28da4b996744aa2a4271ff63a02386c2fe4ecc807',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.NEPHROLOGY_FOLLOWUP]: 'b0f0ebbe9455a9feebdc9d937601a1524e73860b223a734b1479a33e1c812256',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.SURGICAL_ONCOLOGY_NEW_REFERRAL]: '3769da011d9c4ff82fac15e12d677c913cb5eeae3515f1a86c524ebf6e3d7c1d',
  [ARCAAI_CLINICAL_TEMPLATE_IDS.SURGICAL_ONCOLOGY_FOLLOWUP]: 'a7d0d694fa7e46f256e2f5635a9ed6ecf88721c457adf4f451af6a4a64532588',
};

/** The one new PromptVersion row this migration ever inserts (mirrors the seed). */
const SOAP_SUMMARY_V4 = EXTRA_PROMPT_VERSIONS.find((v) => v.id === '72000000-0000-0000-0000-000000000105');
if (!SOAP_SUMMARY_V4) throw new Error('EXTRA_PROMPT_VERSIONS is missing the expected SOAP_SUMMARY v4 row (id …0105)');

export interface MigrationTarget {
  id: string;
  tenantId: string;
  label: string;
  /** New `content` — imported live from the seed; never hand-duplicated here. */
  newContent: string;
  /** SOAP_SUMMARY only: the fixed `metaData` (structured-output schema). */
  newMetaData?: unknown;
  /** SOAP_SUMMARY only: bump `currentVersionNumber` and insert this new PromptVersion row. */
  newVersionRow?: { id: string; versionNumber: number; content: string; variables: unknown; changeReason: string; changedBy: string };
  /** Every other target: the ONE existing PromptVersion row to correct in place, found by (templateId, versionNumber) — never a hardcoded row id. */
  correctVersionNumber?: number;
}

const buildTargets = (): MigrationTarget[] => {
  const targets: MigrationTarget[] = [];

  for (const template of DEFAULT_PROMPT_TEMPLATES) {
    if (!(template.id in KNOWN_BAD_SHA256)) continue;
    if (template.id === TEMPLATE_IDS.SOAP_SUMMARY) {
      targets.push({
        id: template.id,
        tenantId: template.tenantId,
        label: template.name,
        newContent: template.content,
        newMetaData: (template as { metaData?: unknown }).metaData,
        newVersionRow: {
          id: SOAP_SUMMARY_V4.id,
          versionNumber: SOAP_SUMMARY_V4.versionNumber,
          content: SOAP_SUMMARY_V4.content,
          variables: SOAP_SUMMARY_V4.variables,
          changeReason: SOAP_SUMMARY_V4.changeReason,
          changedBy: SOAP_SUMMARY_V4.changedBy,
        },
      });
      continue;
    }
    targets.push({
      id: template.id,
      tenantId: template.tenantId,
      label: template.name,
      newContent: template.content,
      correctVersionNumber: template.currentVersionNumber,
    });
  }

  for (const template of ARCAAI_CLINICAL_TEMPLATES) {
    if (!(template.id in KNOWN_BAD_SHA256)) continue;
    targets.push({
      id: template.id,
      tenantId: template.tenantId,
      label: template.name,
      newContent: template.content,
      correctVersionNumber: ARCAAI_CLINICAL_APPROVED_VERSION,
    });
  }

  return targets;
};

export const MIGRATION_TARGETS: MigrationTarget[] = buildTargets();

export type RowClassification = 'to-fix' | 'already-fixed' | 'drifted' | 'not-found';

export interface ClassifiedTarget {
  target: MigrationTarget;
  classification: RowClassification;
  currentContentSha256?: string;
}

/** Minimal client contract this script needs — real Prisma client or an in-memory fake (tests). */
export interface MigrationClient {
  promptTemplate: {
    findMany: (args: unknown) => Promise<Array<{ id: string; content: string }>>;
    update: (args: unknown) => Promise<unknown>;
  };
  promptVersion: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
    upsert: (args: unknown) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: MigrationClient) => Promise<T>) => Promise<T>;
}

/** Read-only classification pass — no writes. */
export async function classifyTargets(client: MigrationClient, targets: MigrationTarget[], tenantId: string | null): Promise<ClassifiedTarget[]> {
  const scoped = tenantId ? targets.filter((t) => t.tenantId === tenantId) : targets;
  const ids = scoped.map((t) => t.id);
  const rows = await client.promptTemplate.findMany({ where: { id: { in: ids } } });
  const rowById = new Map(rows.map((r) => [r.id, r]));

  return scoped.map((target) => {
    const row = rowById.get(target.id);
    if (!row) return { target, classification: 'not-found' as const };
    const currentContentSha256 = sha256(row.content);
    if (row.content === target.newContent) return { target, classification: 'already-fixed' as const, currentContentSha256 };
    if (currentContentSha256 === KNOWN_BAD_SHA256[target.id]) return { target, classification: 'to-fix' as const, currentContentSha256 };
    return { target, classification: 'drifted' as const, currentContentSha256 };
  });
}

/** Apply the fix to every `to-fix`-classified target, inside the caller's transaction. Returns the count fixed. */
export async function applyFixes(tx: MigrationClient, classified: ClassifiedTarget[]): Promise<number> {
  let fixed = 0;
  for (const { target, classification } of classified) {
    if (classification !== 'to-fix') continue;

    await tx.promptTemplate.update({
      where: { id: target.id },
      data: {
        content: target.newContent,
        ...(target.newMetaData !== undefined ? { metaData: target.newMetaData } : {}),
        ...(target.newVersionRow ? { currentVersionNumber: target.newVersionRow.versionNumber } : {}),
      },
    });

    if (target.newVersionRow) {
      const { id, versionNumber, content, variables, changeReason, changedBy } = target.newVersionRow;
      await tx.promptVersion.upsert({
        where: { id },
        update: { content, variables, changeReason, changedBy },
        create: { id, tenantId: target.tenantId, promptTemplateId: target.id, versionNumber, content, variables, changeReason, changedBy },
      });
    } else if (target.correctVersionNumber !== undefined) {
      await tx.promptVersion.updateMany({
        where: { promptTemplateId: target.id, versionNumber: target.correctVersionNumber },
        data: { content: target.newContent },
      });
    }

    fixed += 1;
  }
  return fixed;
}

interface Options {
  apply: boolean;
  tenantId: string | null;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { apply: false, tenantId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--tenant') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('--tenant requires a tenant id');
        process.exit(2);
      }
      opts.tenantId = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: migrate-icd10-prompt-instructions.ts [--tenant <tenantId>] [--apply]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = getPlatformAdminPrismaClient_Unscoped() as unknown as MigrationClient;

  const mode = opts.apply ? 'APPLY' : 'DRY RUN (default — no writes)';
  console.log('===== TASK-702 — ICD-10 prompt-instruction migration =====');
  console.log(`mode   : ${mode}`);
  console.log(`tenant : ${opts.tenantId ?? 'ALL'}`);
  console.log(`targets: ${MIGRATION_TARGETS.length}`);

  const classified = await classifyTargets(prisma, MIGRATION_TARGETS, opts.tenantId);

  const byClass = { 'to-fix': 0, 'already-fixed': 0, drifted: 0, 'not-found': 0 } as Record<RowClassification, number>;
  console.log('\n----- pre-flight classification (read-only) -----');
  for (const { target, classification } of classified) {
    byClass[classification] += 1;
    console.log(`  [${classification.toUpperCase().padEnd(13)}] ${target.label.padEnd(40)} ${target.id}`);
  }
  console.log(
    `\nsummary: ${byClass['to-fix']} to fix, ${byClass['already-fixed']} already fixed, ${byClass.drifted} DRIFTED (needs manual review), ${byClass['not-found']} not found`,
  );

  const drifted = classified.filter((c) => c.classification === 'drifted');
  if (drifted.length > 0) {
    console.log('\n----- DRIFTED rows (tenant-customized since seeding — NOT touched) -----');
    for (const { target } of drifted) console.log(`  ${target.id}  ${target.label}  (tenant ${target.tenantId})`);
  }

  if (byClass['to-fix'] === 0) {
    console.log('\nNothing to fix — already clean.');
    return;
  }

  if (!opts.apply) {
    console.log(`\nDRY RUN — no rows were modified. Re-run with --apply to fix these ${byClass['to-fix']} row(s).`);
    return;
  }

  const fixed = await prisma.$transaction(async (tx) => applyFixes(tx, classified));
  console.log(`\nAPPLIED — fixed ${fixed} row(s).`);
}

// Main-module guard so unit tests can import the pure helpers without running
// (mirrors backfill-context-item-media-id.ts / decrypt-row.ts —
// `require.main === module` is unreliable under tsx).
const invokedDirectly = typeof process.argv[1] === 'string' && /migrate-icd10-prompt-instructions/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('MIGRATE ICD-10 PROMPT INSTRUCTIONS FAILED:', err);
    process.exit(1);
  });
}
