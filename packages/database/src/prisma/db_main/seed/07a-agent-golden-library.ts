/**
 * Golden Prompt Library (SYSTEM tenant).
 *
 * Promotes the 18-department fixture catalog (04-department.ts +
 * 07-prompt-template.ts) into platform-curated GOLDEN rows owned by the
 * SYSTEM tenant (00000000-…):
 *
 *   - 18 SYSTEM `Department` rows (code/name/description/promptConfig; the
 *     legacy per-department prompt pointers stay null),
 *   - 13 SYSTEM APPROVED `PromptTemplate`s (verbatim content copies of the
 *     fixture templates) + one v1 `PromptVersion` snapshot each.
 *
 * ## What left, and why the file kept its name
 *
 * This file also used to seed 18 SYSTEM golden `DepartmentAgent` rows, a
 * lock-and-lineage CLONE set for the Global fixture tenant, and 7 tenant-owned
 * per-visit-type agents for ArcaAI. All three went with `DepartmentAgent` itself
 * (TASK-815) — a prompt template's binding to a workflow now lives on the NODE
 * that references it, so there is no per-department agent row to seed. The
 * DEPARTMENT and PROMPT halves are untouched: they are the golden catalog every
 * tenant's provisioning still copies from.
 *
 * The filename and `seedAgentGoldenLibrary` are left alone deliberately. Both
 * are referenced by `seed/index.ts` ordering, by the pipeline-completeness test,
 * and by a phase number that encodes FK order (`07a` runs after `04`/`07`);
 * renaming them is a rename with no behavioural content, and this ticket is
 * already a deletion.
 *
 * ID blocks (documented in 00-constants.ts):
 *   70000000-…-0002-…  SYSTEM golden departments
 *   71000000-…-0002-…  SYSTEM golden prompt templates
 *   72000000-…-0002-…  SYSTEM golden prompt versions
 *
 * SYSTEM_SHARED_READ_MODELS decision, amended:
 * Department is still deliberately NOT widened. PROMPT TEMPLATES ARE: `PromptTemplate`/`PromptVersion` joined SYSTEM_SHARED_READ_MODELS
 * because the SYSTEM-owned platform-default prompts (the
 * pre-summary tier-2 fallback …040 and the live-summarization default) were
 * otherwise unreadable from any tenant's CLS and the pre-summary chain fell
 * through to a 503. The list-surface objection this note originally raised does
 * NOT materialise: every list/count read in PromptManagementService pins an
 * explicit caller `tenantId`, which the shared-read merge preserves verbatim, so
 * only BY-ID reads (resolution, assertTemplateBindable, version fetches) widen.
 * Provisioning reads the golden rows through the sanctioned unscoped client in
 * `tenant.service.ts`. A tenant-facing "Library" browse surface, if ever wanted,
 * is a dedicated super-admin-fed endpoint — not a scope widening.
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory } from '../../../generated/core-prisma-client/enums';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { DEFAULT_DEPARTMENTS } from './04-department';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from './07-prompt-template';

const pad = (n: number): string => n.toString().padStart(12, '0');

const goldenDepartmentId = (n: number): string => `70000000-0000-0000-0002-${pad(n)}`;
const goldenTemplateId = (n: number): string => `71000000-0000-0000-0002-${pad(n)}`;
const goldenVersionId = (n: number): string => `72000000-0000-0000-0002-${pad(n)}`;

/**
 * Which fixture template each department's golden default agent documents with.
 *
 * One entry per care-setting department (04-department.ts). Each binds that
 * setting's NEW-encounter generic template — the format a tenant with no
 * configuration of its own should get on its first consultation. Settings that
 * also ship a follow-up/revisit body (OPD, IPD, PERI, BEH, PEDS) expose it
 * through the department's legacy `revisitPromptId` column, not through a
 * second golden agent: the golden library is ONE default agent per department.
 *
 * The map is total over DEFAULT_DEPARTMENTS — `sourceIdForCode` throws on a
 * miss, so adding a department without a template here fails the seed loudly
 * rather than silently shipping a tenant an unbound agent.
 *
 * Exported for the inventory-lock test.
 */
export const GOLDEN_TEMPLATE_SOURCE_BY_CODE: Record<string, string> = {
  OPD: TEMPLATE_IDS.GENERIC_OUTPATIENT_NEW,
  IPD: TEMPLATE_IDS.GENERIC_INPATIENT_ADMISSION,
  ER: TEMPLATE_IDS.GENERIC_EMERGENCY_ENCOUNTER,
  PERI: TEMPLATE_IDS.GENERIC_PERIOP_ASSESSMENT,
  RAD: TEMPLATE_IDS.GENERIC_IMAGING_REPORT,
  LAB: TEMPLATE_IDS.GENERIC_LAB_REPORT,
  BEH: TEMPLATE_IDS.GENERIC_BEHAVIORAL_ASSESSMENT,
  PEDS: TEMPLATE_IDS.GENERIC_PEDIATRIC_NEW,
};

/** Guarded accessor — every department code above has a mapped source. */
const sourceIdForCode = (code: string | null): string => {
  const id = code ? GOLDEN_TEMPLATE_SOURCE_BY_CODE[code] : undefined;
  if (!id) {
    throw new Error(`No golden template source mapped for department code ${code}`);
  }
  return id;
};

// =============================================================================
// SYSTEM golden departments — 1:1 with the fixture catalog, trailing id slot
// matches the fixture ordering (…-0002-…01 = GEN … …-0002-…18 = SONC).
// =============================================================================

export const GOLDEN_DEPARTMENTS = DEFAULT_DEPARTMENTS.map((dept, i) => ({
  id: goldenDepartmentId(i + 1),
  tenantId: SYSTEM_TENANT_ID,
  code: dept.code,
  name: dept.name,
  description: dept.description,
  defaultSummaryTemplate: dept.defaultSummaryTemplate,
  // Legacy prompt pointers reference tenant-owned templates; golden rows
  // carry the binding via the golden agent instead.
  preSummaryPromptId: null as string | null,
  newPatientPromptId: null as string | null,
  revisitPromptId: null as string | null,
  promptConfig: dept.promptConfig,
}));

const goldenDepartmentByCode = new Map<string, (typeof GOLDEN_DEPARTMENTS)[number]>(GOLDEN_DEPARTMENTS.map((d) => [d.code, d]));
const fixtureDepartmentById = new Map<string, (typeof DEFAULT_DEPARTMENTS)[number]>(DEFAULT_DEPARTMENTS.map((d) => [d.id, d]));
const fixtureTemplateById = new Map<string, (typeof DEFAULT_PROMPT_TEMPLATES)[number]>(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));

// =============================================================================
// SYSTEM golden prompt templates — verbatim content copies of the fixture
// sources, deduplicated (the catch-all backs six departments), APPROVED so a
// freshly-provisioned tenant resolves them for clinical generation.
// =============================================================================

const uniqueSourceIds: string[] = [];
for (const dept of DEFAULT_DEPARTMENTS) {
  const sourceId = GOLDEN_TEMPLATE_SOURCE_BY_CODE[dept.code];
  if (sourceId && !uniqueSourceIds.includes(sourceId)) {
    uniqueSourceIds.push(sourceId);
  }
}

export const GOLDEN_PROMPT_TEMPLATES = uniqueSourceIds.map((sourceId, i) => {
  const source = fixtureTemplateById.get(sourceId);
  if (!source) {
    throw new Error(`Golden library source template ${sourceId} missing from DEFAULT_PROMPT_TEMPLATES`);
  }
  // Department-specific sources re-anchor to the SYSTEM golden department.
  const sourceDept = source.departmentId ? fixtureDepartmentById.get(source.departmentId) : undefined;
  const goldenDept = sourceDept ? goldenDepartmentByCode.get(sourceDept.code) : undefined;
  return {
    id: goldenTemplateId(i + 1),
    tenantId: SYSTEM_TENANT_ID,
    name: source.name,
    description: source.description,
    content: source.content,
    category: source.category,
    status: 'APPROVED' as const,
    variables: source.variables ?? null,
    currentVersionNumber: 1,
    departmentId: goldenDept?.id ?? null,
    tags: source.tags,
    // Provenance for the inventory-lock test (NOT persisted).
    sourceFixtureTemplateId: sourceId,
  };
});

const goldenTemplateBySourceId = new Map<string, (typeof GOLDEN_PROMPT_TEMPLATES)[number]>(
  GOLDEN_PROMPT_TEMPLATES.map((t) => [t.sourceFixtureTemplateId, t]),
);

export const GOLDEN_PROMPT_VERSIONS = GOLDEN_PROMPT_TEMPLATES.map((tpl, i) => ({
  id: goldenVersionId(i + 1),
  tenantId: SYSTEM_TENANT_ID,
  promptTemplateId: tpl.id,
  versionNumber: 1,
  content: tpl.content,
  variables: tpl.variables,
  changeReason: 'Initial golden library version',
  changedBy: SYSTEM_USER_ID,
}));

// =============================================================================
// Seed function — idempotent upsert-by-id. Runs AFTER 04-department and
// 07-prompt-template (FKs: DepartmentAgent → Department + PromptTemplate).
// =============================================================================

export const seedAgentGoldenLibrary = async (client: CorePrismaClient) => {
  console.log('Seeding golden prompt library (SYSTEM tenant)...');

  try {
    for (const dept of GOLDEN_DEPARTMENTS) {
      await client.department.upsert({
        where: { id: dept.id },
        update: dept,
        create: dept,
      });
    }
    console.log(`Seeded ${GOLDEN_DEPARTMENTS.length} golden departments`);

    const templates = [...GOLDEN_PROMPT_TEMPLATES];
    for (const template of templates) {
      const { sourceFixtureTemplateId: _source, variables, ...rest } = template;
      const data = {
        ...rest,
        category: rest.category as PromptTemplateCategory,
        status: rest.status,
        ...(variables != null ? { variables: variables as Prisma.InputJsonValue } : {}),
      };
      await client.promptTemplate.upsert({
        where: { id: template.id },
        update: data,
        create: data,
      });
    }
    console.log(`Seeded ${templates.length} golden/snapshot prompt templates`);

    const versions = [...GOLDEN_PROMPT_VERSIONS];
    for (const version of versions) {
      const { variables, ...rest } = version;
      const data = {
        ...rest,
        ...(variables != null ? { variables: variables as Prisma.InputJsonValue } : {}),
      };
      await client.promptVersion.upsert({
        where: { id: version.id },
        update: data,
        create: data,
      });
    }
    console.log(`Seeded ${versions.length} golden/snapshot prompt versions`);
  } catch (error) {
    console.error('Error seeding golden prompt library:', error);
    throw error;
  }
};
