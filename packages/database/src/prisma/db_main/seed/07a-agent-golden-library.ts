/**
 * TASK-548 — Agent Golden Library (SYSTEM tenant).
 *
 * Promotes the 18-department fixture catalog (04-department.ts +
 * 07-prompt-template.ts) into platform-curated GOLDEN rows owned by the
 * SYSTEM tenant (00000000-…):
 *
 *   - 18 SYSTEM `Department` rows (code/name/description/promptConfig; the
 *     legacy per-department prompt pointers stay null — golden rows carry the
 *     binding on the agent instead),
 *   - 13 SYSTEM APPROVED `PromptTemplate`s (verbatim content copies of the
 *     fixture templates) + one v1 `PromptVersion` snapshot each,
 *   - 18 SYSTEM `DepartmentAgent` golden rows — ONE default agent per
 *     department, `templateLocked: false` (the golden rows ARE the templates;
 *     the lock applies to tenant CLONES only).
 *
 * The Global fixture tenant is expressed as CLONES of the golden set via
 * `asAgentTemplateCopies` (mirrors 06-stt.ts `asTemplateCopies`): every
 * fixture-tenant agent is `templateLocked: true`, carries
 * `sourceAgentTemplateSlug` lineage, and stamps
 * `metaData.sourceTemplateVersionNumber` so the resync sweep
 * (`AgentTemplateResyncService`) can prove it pristine. (TASK-592 Workstream D:
 * the ArcaAI fixture tenant NO LONGER gets seeded default agents — its clinical
 * departments resolve via the visit-type-faithful legacy prompt-id columns; see
 * 07b-arcaai-clinical-templates.ts.)
 *
 * ID blocks (documented in 00-constants.ts):
 *   70000000-…-0002-…  SYSTEM golden departments
 *   71000000-…-0002-…  SYSTEM golden prompt templates
 *   72000000-…-0002-…  SYSTEM golden prompt versions
 *   78000000-…-XXXX-…  Department agents (0002 SYSTEM golden, 0000 Global
 *                      tenant clones; ArcaAI 0001 block retired in Workstream D)
 *
 * SYSTEM_SHARED_READ_MODELS decision (plan §1): Department / PromptTemplate /
 * DepartmentAgent are deliberately NOT widened to SYSTEM-shared reads — doing
 * so would surface the 18 SYSTEM departments and golden templates inside every
 * tenant's own list surfaces (department dropdowns, template pickers).
 * Provisioning reads the golden rows through the sanctioned unscoped client in
 * `tenant.service.ts`; the resync sweep runs tenant-less (elevated
 * pass-through). A tenant-facing "Library" browse surface, if ever wanted, is
 * a dedicated global-admin-fed endpoint — not a scope widening.
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory } from '../../../generated/core-prisma-client/enums';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { DEFAULT_DEPARTMENTS } from './04-department';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from './07-prompt-template';

const pad = (n: number): string => n.toString().padStart(12, '0');

const goldenDepartmentId = (n: number): string => `70000000-0000-0000-0002-${pad(n)}`;
const goldenTemplateId = (n: number): string => `71000000-0000-0000-0002-${pad(n)}`;
const goldenVersionId = (n: number): string => `72000000-0000-0000-0002-${pad(n)}`;
const goldenAgentId = (n: number): string => `78000000-0000-0000-0002-${pad(n)}`;
const globalAgentId = (n: number): string => `78000000-0000-0000-0000-${pad(n)}`;

/**
 * Which fixture template each department's golden default agent documents
 * with. Departments with a wired new-referral summary prompt use it; the rest
 * fall back to the catch-all SOAP final-summary; Cardiology keeps its
 * department-specific CUSTOM prompt. Exported for the inventory-lock test.
 */
export const GOLDEN_TEMPLATE_SOURCE_BY_CODE: Record<string, string> = {
  GEN: TEMPLATE_IDS.CATCHALL_SOAP,
  CARD: TEMPLATE_IDS.CARD_CUSTOM,
  RAD: TEMPLATE_IDS.CATCHALL_SOAP,
  LAB: TEMPLATE_IDS.CATCHALL_SOAP,
  NEUR: TEMPLATE_IDS.NEUR_NEW_REFERRAL,
  ORTH: TEMPLATE_IDS.ORTH_NEW_REFERRAL,
  DERM: TEMPLATE_IDS.DERM_NEW_REFERRAL,
  PSYCH: TEMPLATE_IDS.CATCHALL_SOAP,
  PEDS: TEMPLATE_IDS.CATCHALL_SOAP,
  ER: TEMPLATE_IDS.CATCHALL_SOAP,
  SURG: TEMPLATE_IDS.SURGERY_NEW_REFERRAL,
  MED: TEMPLATE_IDS.MEDICINE_NEW_REFERRAL,
  BREN: TEMPLATE_IDS.BREN_NEW_REFERRAL,
  RHEUM: TEMPLATE_IDS.RHEUM_NEW_REFERRAL,
  HEME: TEMPLATE_IDS.HEME_NEW_REFERRAL,
  DIET: TEMPLATE_IDS.DIET_NEW_REFERRAL,
  NEPH: TEMPLATE_IDS.NEPH_NEW_REFERRAL,
  SONC: TEMPLATE_IDS.SONC_NEW_REFERRAL,
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
// SYSTEM golden agents — ONE default documentation agent per department. The
// golden rows ARE the templates: never locked, no lineage.
// =============================================================================

export const GOLDEN_AGENTS = DEFAULT_DEPARTMENTS.map((dept, i) => {
  const goldenTpl = goldenTemplateBySourceId.get(sourceIdForCode(dept.code));
  if (!goldenTpl) {
    throw new Error(`No golden template mapped for department code ${dept.code}`);
  }
  return {
    id: goldenAgentId(i + 1),
    tenantId: SYSTEM_TENANT_ID,
    departmentId: goldenDepartmentId(i + 1),
    name: `${dept.name} Default Agent`,
    slug: `${dept.code.toLowerCase()}-default`,
    description: `Day-1 default documentation agent for ${dept.name}`,
    promptTemplateId: goldenTpl.id,
    pinnedVersionNumber: null as number | null,
    isDefault: true,
    sourceAgentTemplateSlug: null as string | null,
    templateLocked: false,
    metaData: null as Record<string, unknown> | null,
    tags: ['golden-library'],
  };
});

const goldenAgentByCode = new Map<string, (typeof GOLDEN_AGENTS)[number]>(
  GOLDEN_AGENTS.map((agent) => {
    const dept = GOLDEN_DEPARTMENTS.find((d) => d.id === agent.departmentId);
    return [dept?.code as string, agent];
  }),
);

// =============================================================================
// Fixture tenants expressed as clones (mirrors 06-stt.ts `asTemplateCopies`).
// =============================================================================

interface AgentSeedRow {
  id: string;
  tenantId: string;
  departmentId: string;
  name: string;
  slug: string;
  description: string;
  promptTemplateId: string;
  pinnedVersionNumber: number | null;
  isDefault: boolean;
  sourceAgentTemplateSlug: string | null;
  templateLocked: boolean;
  metaData: Record<string, unknown> | null;
  tags: string[];
}

/**
 * Stamp template lineage on tenant copies: locked, `sourceAgentTemplateSlug`
 * = the golden slug (= the row's own slug for seed-provisioned copies), and
 * the pristine-detection anchor `metaData.sourceTemplateVersionNumber` (the
 * golden template's version the copy's content was taken from — v1 at seed
 * time).
 */
const asAgentTemplateCopies = (rows: AgentSeedRow[]): AgentSeedRow[] =>
  rows.map((row) => ({
    ...row,
    sourceAgentTemplateSlug: row.slug,
    templateLocked: true,
    metaData: { sourceTemplateVersionNumber: 1 },
  }));

/**
 * Global customer tenant (50000000-…): its fixture templates ARE the content
 * source of the golden library, so its agent clones bind the tenant's own
 * fixture template directly (content-identical to golden v1 by construction).
 */
export const GLOBAL_TENANT_AGENTS: AgentSeedRow[] = asAgentTemplateCopies(
  DEFAULT_DEPARTMENTS.map((dept, i) => {
    const golden = goldenAgentByCode.get(dept.code);
    if (!golden) {
      throw new Error(`No golden agent for department code ${dept.code}`);
    }
    return {
      id: globalAgentId(i + 1),
      tenantId: SEED_TENANT_ID,
      departmentId: dept.id,
      name: golden.name,
      slug: golden.slug,
      description: golden.description,
      promptTemplateId: sourceIdForCode(dept.code),
      pinnedVersionNumber: null,
      isDefault: true,
      sourceAgentTemplateSlug: null,
      templateLocked: false,
      metaData: null,
      tags: ['golden-library'],
    };
  }),
);

// NOTE (TASK-592 Workstream D): the ArcaAI customer tenant NO LONGER receives
// seeded default DepartmentAgents. Its departments are the 7 v1 clinical
// departments (04-department.ts), wired via the legacy Department prompt-id
// columns to per-visit-type APPROVED templates (07b-arcaai-clinical-templates.ts).
// A default agent resolves ONE template per department and ignores visit type,
// which would collapse v1's new-referral vs follow-up split — so the ArcaAI
// departments MUST have no default agent (the resolver then uses the
// visit-type-faithful tier-1 legacy path). The former ArcaAI golden clones
// (ARCAAI_SNAPSHOT_SPECS / ARCAAI_AGENT_TEMPLATE_SNAPSHOTS /
// ARCAAI_AGENT_TEMPLATE_VERSIONS / ARCAAI_TENANT_AGENTS) were removed here.
// The SYSTEM golden library and the Global-tenant clones are unchanged.

// =============================================================================
// Seed function — idempotent upsert-by-id. Runs AFTER 04-department and
// 07-prompt-template (FKs: DepartmentAgent → Department + PromptTemplate).
// =============================================================================

export const seedAgentGoldenLibrary = async (client: CorePrismaClient) => {
  console.log('Seeding agent golden library (SYSTEM tenant)...');

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

    const agents = [...GOLDEN_AGENTS, ...GLOBAL_TENANT_AGENTS];
    for (const agent of agents) {
      const { metaData, ...rest } = agent;
      const data = {
        ...rest,
        ...(metaData != null ? { metaData: metaData as Prisma.InputJsonValue } : {}),
      };
      await client.departmentAgent.upsert({
        where: { id: agent.id },
        update: data,
        create: data,
      });
    }
    console.log(`Seeded ${agents.length} department agents (golden + fixture-tenant clones)`);
  } catch (error) {
    console.error('Error seeding agent golden library:', error);
    throw error;
  }
};
