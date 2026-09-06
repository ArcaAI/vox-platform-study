/**
 * Golden Prompt Library (SYSTEM tenant).
 *
 * Promotes the department fixture catalog (04-department.ts) into
 * platform-curated GOLDEN rows owned by the SYSTEM tenant (00000000-…):
 *
 *   - 18 SYSTEM `Department` rows (code/name/description/promptConfig; the
 *     legacy per-department prompt pointers stay null).
 *
 * ## Prompt templates are NO LONGER promoted (TASK-890 J7-1)
 *
 * This phase used to also mint 8 SYSTEM `PromptTemplate` rows as byte COPIES of
 * the Global-tenant fixture bodies, under their own `71000000-…-0002-…` ids.
 * That put the same template NAME in two tenants, and phase 26 skips a source
 * whose `(tenantId, name)` the target already owns — so Global could never
 * receive those eight as stamped clones and kept unstamped originals instead
 * (measured on dev: 9 of SYSTEM's 17). `07-prompt-template.ts` now authors those
 * eight ON SYSTEM, one home per template, and this file only SELECTS them:
 * `GOLDEN_PROMPT_TEMPLATES` / `GOLDEN_PROMPT_VERSIONS` are a view over the
 * seeded rows, kept because the seed's own tests read them.
 *
 * ## What left, and why the file kept its name
 *
 * This file also used to seed 18 SYSTEM golden `DepartmentAgent` rows, a
 * lock-and-lineage CLONE set for the Global fixture tenant, and 7 tenant-owned
 * per-visit-type agents for ArcaAI. All three went with `DepartmentAgent` itself
 * a prompt template's binding to a workflow now lives on the NODE
 * that references it, so there is no per-department agent row to seed. The
 * DEPARTMENT half is untouched: it is the golden catalog every tenant's
 * provisioning still copies from.
 *
 * The filename and `seedAgentGoldenLibrary` are left alone deliberately. Both
 * are referenced by `seed/index.ts` ordering, by the pipeline-completeness test,
 * and by a phase number that encodes FK order (`07a` runs after `04`/`07`);
 * renaming them is a rename with no behavioural content, and this ticket is
 * already a deletion.
 *
 * ID blocks (documented in 00-constants.ts):
 *   70000000-…-0002-… SYSTEM golden departments
 *   71000000-…-0002-… RETIRED — was SYSTEM golden prompt templates
 *   72000000-…-0002-… RETIRED — was SYSTEM golden prompt versions
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
import { SYSTEM_TENANT_ID } from './00-constants';
import { DEFAULT_DEPARTMENTS } from './04-department';
import { DEFAULT_PROMPT_TEMPLATES, DEFAULT_PROMPT_VERSIONS, TEMPLATE_IDS } from './07-prompt-template';

const pad = (n: number): string => n.toString().padStart(12, '0');

const goldenDepartmentId = (n: number): string => `70000000-0000-0000-0002-${pad(n)}`;
// `71000000-…-0002-…` (golden templates) and `72000000-…-0002-…` (their versions)
// are RETIRED id blocks. They existed only for the byte copies this phase used to
// mint; the eight bodies are authored on SYSTEM by `07-prompt-template.ts` under
// their own ids now. Do not re-use these prefixes — a re-seeded database may still
// carry rows written under them by an older seed.

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

const fixtureTemplateById = new Map<string, (typeof DEFAULT_PROMPT_TEMPLATES)[number]>(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));

// =============================================================================
// SYSTEM golden prompt templates — a VIEW, no longer a copy (TASK-890 J7-1).
//
// This block used to PROMOTE the eight generic care-setting bodies: read them
// out of the Global fixture catalog, re-key them under `71000000-…-0002-…`,
// re-anchor their department to the golden SYSTEM one, and upsert them as a
// second set of rows. That is what put the same template NAME in two tenants —
// and phase 26 (`26-tenant-reference-set.ts`) skips a source whose
// `(tenantId, name)` the target already owns, so Global could never receive
// those eight as stamped clones and kept its unstamped originals instead
// (measured: 9 of 17 on the dev database).
//
// `07-prompt-template.ts` now authors those eight ON SYSTEM directly, so there
// is nothing left to promote. What stays here is the SELECTION — which template
// backs which care setting — expressed as a view over the seeded rows. The
// exports are kept because the inventory-lock and FK-closure tests read them;
// `seedAgentGoldenLibrary` no longer writes a prompt row, because phase 07
// already did.
// =============================================================================

const uniqueSourceIds: string[] = [];
for (const dept of DEFAULT_DEPARTMENTS) {
  const sourceId = GOLDEN_TEMPLATE_SOURCE_BY_CODE[dept.code];
  if (sourceId && !uniqueSourceIds.includes(sourceId)) {
    uniqueSourceIds.push(sourceId);
  }
}

export const GOLDEN_PROMPT_TEMPLATES = uniqueSourceIds.map((sourceId) => {
  const source = fixtureTemplateById.get(sourceId);
  if (!source) {
    throw new Error(`Golden library source template ${sourceId} missing from DEFAULT_PROMPT_TEMPLATES`);
  }
  // The seed authors these on SYSTEM. Assert it rather than assume it: a row
  // moved back to a customer tenant would silently un-do J7-1 and hand every
  // newly-provisioned tenant one customer's template.
  if (source.tenantId !== SYSTEM_TENANT_ID) {
    throw new Error(`Golden library source template ${sourceId} ('${source.name}') must be authored on the SYSTEM tenant, not ${source.tenantId}`);
  }
  return source;
});

const goldenTemplateIds = new Set(GOLDEN_PROMPT_TEMPLATES.map((t) => t.id));

export const GOLDEN_PROMPT_VERSIONS = DEFAULT_PROMPT_VERSIONS.filter((version) => goldenTemplateIds.has(version.promptTemplateId));

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

    // NO prompt-template or prompt-version write (TASK-890 J7-1). The eight
    // golden bodies are authored on SYSTEM by `07-prompt-template.ts`, which
    // runs before this phase and upserts them along with every other seeded
    // template. Re-writing them here is what minted the duplicate SYSTEM rows
    // this ticket removed; `GOLDEN_PROMPT_TEMPLATES` / `GOLDEN_PROMPT_VERSIONS`
    // are now a VIEW over those rows and exist for the seed's own tests.
    console.log(`Golden prompt library: ${GOLDEN_PROMPT_TEMPLATES.length} SYSTEM templates already written by phase 07`);
  } catch (error) {
    console.error('Error seeding golden prompt library:', error);
    throw error;
  }
};
