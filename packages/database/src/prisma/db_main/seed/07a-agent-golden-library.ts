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
 * (`AgentTemplateResyncService`) can prove it pristine.
 *
 * The ArcaAI fixture tenant is NOT a clone set: TASK-635 RF-3 gives it 7
 * tenant-owned, UNLOCKED per-visit-type default agents (`ARCAAI_TENANT_AGENTS`
 * below) that mirror its legacy Department prompt-id columns exactly. They reuse
 * the GOLDEN slugs so the resync sweep stays a no-op for that tenant. (TASK-592
 * Workstream D had removed ArcaAI's agents entirely; see the block comment above
 * ARCAAI_TENANT_AGENTS for why that invariant is now retired rather than guarded.)
 *
 * ID blocks (documented in 00-constants.ts):
 *   70000000-…-0002-…  SYSTEM golden departments
 *   71000000-…-0002-…  SYSTEM golden prompt templates
 *   72000000-…-0002-…  SYSTEM golden prompt versions
 *   78000000-…-XXXX-…  Department agents (0002 SYSTEM golden, 0000 Global
 *                      tenant clones, 0001 ArcaAI per-visit-type defaults —
 *                      block retired in TASK-592 Workstream D, RESTORED by
 *                      TASK-635 RF-3 now that the agent carries a visit-type
 *                      axis)
 *
 * SYSTEM_SHARED_READ_MODELS decision (plan §1), AMENDED by TASK-635 B-12:
 * Department and DepartmentAgent are still deliberately NOT widened. PROMPT
 * TEMPLATES ARE: `PromptTemplate`/`PromptVersion` joined SYSTEM_SHARED_READ_MODELS
 * in TASK-635 C2, because the SYSTEM-owned platform-default prompts (the
 * pre-summary tier-2 fallback …040 and the live-summarization default) were
 * otherwise unreadable from any tenant's CLS and the pre-summary chain fell
 * through to a 503. The list-surface objection this note originally raised does
 * NOT materialise: every list/count read in PromptManagementService pins an
 * explicit caller `tenantId`, which the shared-read merge preserves verbatim, so
 * only BY-ID reads (resolution, assertTemplateBindable, version fetches) widen.
 * Provisioning reads the golden rows through the sanctioned unscoped client in
 * `tenant.service.ts`; the resync sweep runs tenant-less (elevated
 * pass-through). A tenant-facing "Library" browse surface, if ever wanted, is
 * a dedicated global-admin-fed endpoint — not a scope widening.
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { DepartmentAgentRole, PromptTemplateCategory } from '../../../generated/core-prisma-client/enums';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { ARCAAI_CLINICAL_DEPARTMENTS, DEFAULT_DEPARTMENTS } from './04-department';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from './07-prompt-template';
import { DAY1_AGENT_LOOP_CONFIG, agentLoopConfigChecksum, agentVersionIdFor, buildLoopConfigSnapshot, seedRowHasLoopConfig } from './07e-consultation-loop-defaults';

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
    // TASK-686 — day-1 loop configuration.
    ...DAY1_AGENT_LOOP_CONFIG,
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
  // TASK-635 RF-4 capability-keyed bindings. Optional on the seed row so the
  // 36 golden/Global rows stay written exactly as before (omitted ⇒ the column
  // is never sent ⇒ NULL ⇒ legacy behaviour). Only the ArcaAI rows set them.
  newPatientTemplateId?: string | null;
  revisitTemplateId?: string | null;
  preSummaryTemplateId?: string | null;
  livePromptTemplateId?: string | null;
  toolConfig?: Record<string, unknown> | null;
  llmOverrides?: Record<string, unknown> | null;
  // TASK-686 — the day-1 loop configuration (TASK-659's seven fields). Carried
  // by every seeded default agent so `LoopConfigService` resolves a real
  // subscription set instead of a running-but-inert loop. The VALUES live in
  // `07e-consultation-loop-defaults.ts` next to the context schema whose kinds
  // they must resolve against; they are declared here only as columns.
  role?: string;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
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
      // TASK-686 — day-1 loop configuration.
      ...DAY1_AGENT_LOOP_CONFIG,
    };
  }),
);

// =============================================================================
// ArcaAI customer tenant — per-visit-type default agents (TASK-635 RF-3).
//
// HISTORY. TASK-592 Workstream D REMOVED ArcaAI's seeded agents and recorded the
// invariant "the ArcaAI departments MUST have no default agent". That was
// correct at the time: a DepartmentAgent was a single prompt pointer, the
// resolver's tier-1a consulted `promptTemplateId` regardless of visit type, and
// a default agent would therefore have collapsed v1's new-referral vs follow-up
// split (F-01) the moment it preempted the visit-type-faithful legacy columns.
//
// TASK-635 C2 (DR-1 / OD-2a) gives the agent a VISIT-TYPE AXIS —
// `newPatientTemplateId` / `revisitTemplateId`, resolved as
// `visitBinding ?? promptTemplateId` — so the collapse is no longer possible.
// RF-3 therefore RETIRES the zero-agent invariant instead of guarding it: the 7
// agents below bind, per visit type, exactly the SAME 14 pinned templates the
// legacy `Department.newPatientPromptId` / `revisitPromptId` columns bind. The
// change is behaviour-identical BY CONSTRUCTION and is proven twice — at the id
// level by seed/__tests__/arcaai-agent-column-equality.test.ts (which replaced
// the deleted arcaai-zero-department-agents.test.ts), and at the resolution
// level by the C2-T2 suite in packages/applications (same promptId, same
// versionNumber, same content bytes; only `resolvedFrom` flips
// 'department' → 'agent', which no consumer keys on — the compat shim's guard is
// `resolvedFrom === 'default'`).
//
// THE SLUGS ARE LOAD-BEARING. They match the SYSTEM golden slugs
// (`${code.toLowerCase()}-default`), and `AgentTemplateResyncService` rule (i)
// clones a golden agent into a tenant only when its slug is ABSENT there.
// Matching slugs make the nightly sweep add nothing for ArcaAI, after which rule
// (iii) ("never touch an unlocked row") protects these rows forever. That closes
// the "sweep silently re-adds an agent" hazard structurally rather than with a
// kill-switch.
//
// The legacy Department prompt-id columns are RETAINED as the deprecated
// tier-1b fallback (RF-3) — they are what these bindings are proven against.
// =============================================================================

const arcaaiAgentId = (n: number): string => `78000000-0000-0000-0001-${pad(n)}`;

/** ArcaAI department code → the golden slug its default agent must carry. */
const ARCAAI_AGENT_SLUG_BY_CODE: Record<string, string> = {
  GEN: 'gen-default',
  SURG: 'surg-default',
  RHEUM: 'rheum-default',
  NEUR: 'neur-default',
  ORTH: 'orth-default',
  HEME: 'heme-default',
  BREN: 'bren-default',
};

export const ARCAAI_TENANT_AGENTS: AgentSeedRow[] = ARCAAI_CLINICAL_DEPARTMENTS.map((dept, i) => {
  const slug = ARCAAI_AGENT_SLUG_BY_CODE[dept.code];
  if (!slug) {
    throw new Error(`No ArcaAI agent slug mapped for department code ${dept.code}`);
  }
  // Read through `string | null` locals: the seed's own literal types already
  // prove these are non-null (TS narrows a falsy check to `never`), but the
  // mirror only means anything if the columns really are set, and this keeps the
  // intent legible if a future department is added with a null column.
  const newPatientPromptId: string | null = dept.newPatientPromptId;
  const revisitPromptId: string | null = dept.revisitPromptId;
  if (!newPatientPromptId || !revisitPromptId) {
    throw new Error(`ArcaAI department ${slug} is missing a visit-type prompt column — cannot mirror it onto an agent`);
  }
  return {
    // Reuses the id block retired in Workstream D, so upsert-by-id self-heals
    // any stale pre-Workstream-D rows still sitting in long-lived dev DBs.
    id: arcaaiAgentId(i + 1),
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: dept.id,
    name: `${dept.name} Default Agent`,
    slug,
    description: `Day-1 default documentation agent for ${dept.name} (v1 per-visit-type prompts)`,
    // Required NOT-NULL base binding; also the within-tier fallback when a
    // request carries no/unknown visit type.
    promptTemplateId: newPatientPromptId,
    newPatientTemplateId: newPatientPromptId,
    revisitTemplateId: revisitPromptId,
    // Pre-summary keeps resolving via the tenant TENANT_DEFAULT row (…024) and
    // live keeps the SYSTEM default — RF-3 restores the SUMMARY axis only.
    preSummaryTemplateId: null,
    livePromptTemplateId: null,
    toolConfig: null,
    llmOverrides: null,
    // The 14 templates are seeded `approvedVersionNumber: 1` (07b), so the
    // APPROVAL pin IS the governance pin — no admin pin column needed (DR-1b).
    pinnedVersionNumber: null,
    isDefault: true,
    // Tenant-owned wiring, NOT a golden clone: unlocked, no lineage, so resync
    // rule (iii) never touches it.
    sourceAgentTemplateSlug: null,
    templateLocked: false,
    metaData: null,
    tags: ['arcaai', 'clinical', 'v1-parity'],
    // TASK-686 — day-1 loop configuration.
    ...DAY1_AGENT_LOOP_CONFIG,
  };
});

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

    const agents: AgentSeedRow[] = [...GOLDEN_AGENTS, ...GLOBAL_TENANT_AGENTS, ...ARCAAI_TENANT_AGENTS];

    // TASK-686 — the loop-config columns are FILL-IF-ABSENT, unlike every other
    // column here. The rest of this row is platform-curated content a re-seed is
    // meant to refresh; loop configuration is a TENANT decision the console
    // (TASK-667) exists to make, so a re-seed must never revert it. Reading the
    // current rows first is what lets an already-seeded database pick the
    // day-1 defaults up while leaving a configured agent alone.
    const configuredAgentIds = new Set(
      (
        await client.departmentAgent.findMany({
          where: { id: { in: agents.map((agent) => agent.id) } },
          select: {
            id: true,
            role: true,
            subscribedKinds: true,
            writeScope: true,
            goal: true,
            guardrailProfile: true,
            alwaysActions: true,
            neverActions: true,
          },
        })
      )
        .filter((row) =>
          seedRowHasLoopConfig({
            role: row.role,
            subscribedKinds: (row.subscribedKinds ?? null) as Record<string, unknown> | null,
            writeScope: (row.writeScope ?? null) as Record<string, unknown> | null,
            goal: (row.goal ?? null) as Record<string, unknown> | null,
            guardrailProfile: row.guardrailProfile,
            alwaysActions: (row.alwaysActions ?? null) as string[] | null,
            neverActions: (row.neverActions ?? null) as string[] | null,
          }),
        )
        .map((row) => row.id),
    );

    for (const agent of agents) {
      const { metaData, toolConfig, llmOverrides, role, subscribedKinds, writeScope, goal, guardrailProfile, alwaysActions, neverActions, ...rest } =
        agent;
      const loopConfig = {
        ...(role != null ? { role: role as DepartmentAgentRole } : {}),
        ...(subscribedKinds != null ? { subscribedKinds: subscribedKinds as Prisma.InputJsonValue } : {}),
        ...(writeScope != null ? { writeScope: writeScope as Prisma.InputJsonValue } : {}),
        ...(goal != null ? { goal: goal as Prisma.InputJsonValue } : {}),
        ...(guardrailProfile != null ? { guardrailProfile } : {}),
        ...(alwaysActions != null ? { alwaysActions: alwaysActions as Prisma.InputJsonValue } : {}),
        ...(neverActions != null ? { neverActions: neverActions as Prisma.InputJsonValue } : {}),
      };
      const data = {
        ...rest,
        ...(metaData != null ? { metaData: metaData as Prisma.InputJsonValue } : {}),
        ...(toolConfig != null ? { toolConfig: toolConfig as Prisma.InputJsonValue } : {}),
        ...(llmOverrides != null ? { llmOverrides: llmOverrides as Prisma.InputJsonValue } : {}),
      };
      await client.departmentAgent.upsert({
        where: { id: agent.id },
        update: configuredAgentIds.has(agent.id) ? data : { ...data, ...loopConfig },
        create: { ...data, ...loopConfig },
      });
    }
    console.log(`Seeded ${agents.length} department agents (golden + fixture-tenant clones + ArcaAI per-visit-type defaults)`);

    // TASK-686 — the immutable loop-config snapshot `LoopConfigService` resolves
    // as `agentConfigVersionId`. Mirrors what
    // `DepartmentAgentService.writeLoopConfigVersionIfNeeded` would have written
    // had the agent been configured through the API: version 1, the canonical
    // seven-field snapshot, and the same sha256 checksum (parity is asserted by
    // `day1-loop-defaults.task686.test.ts`). CREATE-ONLY — an agent that already
    // has ANY version row is left entirely alone.
    let versionsCreated = 0;
    for (const agent of agents) {
      if (configuredAgentIds.has(agent.id)) continue;
      const existing = await client.departmentAgentVersion.findFirst({ where: { agentId: agent.id }, select: { id: true } });
      if (existing) continue;

      const snapshot = buildLoopConfigSnapshot(agent);
      await client.departmentAgentVersion.create({
        data: {
          id: agentVersionIdFor(agent.id),
          tenantId: agent.tenantId,
          agentId: agent.id,
          versionNumber: 1,
          configSnapshot: snapshot as Prisma.InputJsonValue,
          checksum: agentLoopConfigChecksum(agent),
          changeReason: 'Day-1 platform default loop configuration',
          createdBy: SYSTEM_USER_ID,
        },
      });
      versionsCreated += 1;
    }
    console.log(`Seeded ${versionsCreated} day-1 agent loop-config version(s)`);
  } catch (error) {
    console.error('Error seeding agent golden library:', error);
    throw error;
  }
};
