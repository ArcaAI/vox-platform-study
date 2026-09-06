/**
 * Conformance regression suite (DATABASE / seed layer).
 *
 * Locks the seed- and scoping-side properties of the conformance scorecard
 * Sibling files carry the other layers:
 *   - apps/api/src/modules/text-compat/__tests__/task-635-conformance.test.ts (R-C1/R-C2/R-C3)
 *   - packages/applications/src/services/consultation/prompt/__tests__/task-635-conformance.test.ts (R-T1/R-T2)
 *   - packages/agentic-sdk-v2/src/compat/__tests__/task-635-conformance.test.ts (R-C1, SDK half)
 *
 * | Property | Origin | Covered here |
 * |---|---|---|
 * | RF-2 | refinement — at most ONE tenant pre-summary candidate per (tenant, surface tag) | |
 * | B-12 | defect — SYSTEM pre-summary default must be readable cross-tenant | |
 *
 * DELIBERATELY NOT DUPLICATED:
 *   - per-TENANT (surface-agnostic) pre-summary candidate uniqueness →
 *     `pre-summary-candidate-uniqueness.test.ts` (Lane A1). That test's own NOTE
 *     says the assertion must become per-(tenant, surface-tag) once the D2 fork
 *     exists; the suite below IS that per-surface assertion, added alongside rather
 *     than replacing it (the A1 test still guards the surface-less legacy case).
 *   - agent-tier vs legacy-column seed equality for the 7 ArcaAI departments ×
 *     2 visit types → `arcaai-agent-column-equality.test.ts` (C2).
 *   - byte-exact v1 prompt fidelity → `v1-clinical-prompt-fidelity.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { SYSTEM_SHARED_READ_MODELS, TENANT_SCOPED_MODELS } from '../../../../extensions/tenant-scope';
import { SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { CUSTOMER_PROMPT_TEMPLATES, DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../07-prompt-template';
import { ARCAAI_CLINICAL_TEMPLATES } from '../07b-arcaai-clinical-templates';
import { SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT, SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE } from '../07d-dept-free-pre-summary-default';

// ---------------------------------------------------------------------------
// RF-2: at most one tenant pre-summary candidate per (tenant, surface tag)
// ---------------------------------------------------------------------------

/**
 * Mirrors `PromptResolutionService.findTenantPreSummaryTemplateId`, which is a
 * TAG CONVENTION rather than a first-class pointer (OD-4(b)):
 *   scope=TENANT_DEFAULT ∧ status=APPROVED ∧ departmentId=null ∧ …
 * A second matching row per (tenant, surface) is resolved first-by-createdAt —
 * i.e. silently, order-dependently — which is exactly defect B-01. RF-2 makes
 * the rule per-surface so the D2 dept-free fork does not recreate B-01.
 *
 * The tag predicate itself is NOT symmetric across surfaces (OD-7(b), README
 * ): `'dept-free'` is a positive opt-in match (`hasEvery(['pre-summary',
 * <surface tag>])`), but `'v1'` is `has('pre-summary')` MINUS any row also
 * tagged `dept-free` — a hand-created tenant row tagged only `pre-summary`
 * must keep resolving on the `'v1'` surface rather than silently falling
 * through to the SYSTEM default, which is what a strict `hasEvery(['pre-summary',
 * 'text-v1'])` predicate (OD-7(a), the originally approved spec) would have
 * done to it.
 *
 * This helper still scans with `hasEvery(pre-summary, surfaceTag)` for BOTH
 * surfaces rather than transcribing the exclusion form literally: every
 * seeded row in this file carries its full tag set regardless (the v1 rows
 * carry both `pre-summary` and `text-v1`; the dept-free fork carries both
 * `pre-summary` and `dept-free`), so the candidate SET this scan finds for
 * each surface is identical to what the production predicate would find over
 * this seeded data — it is a seed-level candidate-uniqueness check, not a
 * literal transcription of the (b) query shape.
 */
const PRE_SUMMARY_TAG = 'pre-summary';
const SURFACE_TAGS = ['text-v1', 'dept-free'] as const;

// Mirrors the (unexported) `resolvePromptStatus` in ../07-prompt-template.ts.
const resolveSeedStatus = (category: string): string => (category === 'DNA_ANALYSIS' ? 'DRAFT' : 'APPROVED');
// Mirrors the Prisma schema default `scope PromptTemplateScope @default(TENANT_DEFAULT)`.
const DEFAULT_SCOPE = 'TENANT_DEFAULT';

interface SeedTemplateLike {
  id?: string;
  tenantId: string;
  category: string;
  departmentId: string | null;
  tags: string[];
  scope?: string;
  status?: string;
}

const ALL_SEEDED_TEMPLATES: SeedTemplateLike[] = [
  ...(DEFAULT_PROMPT_TEMPLATES as unknown as SeedTemplateLike[]),
  ...(CUSTOMER_PROMPT_TEMPLATES as unknown as SeedTemplateLike[]),
  ...(ARCAAI_CLINICAL_TEMPLATES as unknown as SeedTemplateLike[]),
  // The department-free pre-summary fork (07d). It is seeded
  // through its own dedicated function (`seedDeptFreePreSummaryDefault`, like
  // C2's live default), not via one of the arrays above, so it must be added
  // here explicitly for per-surface candidate-uniqueness scan to see it.
  SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE as unknown as SeedTemplateLike,
];

const candidatesFor = (surfaceTag: string): Map<string, string[]> => {
  const byTenant = new Map<string, string[]>();
  for (const template of ALL_SEEDED_TEMPLATES) {
    const scope = template.scope ?? DEFAULT_SCOPE;
    const status = template.status ?? resolveSeedStatus(template.category);
    const matches =
      scope === 'TENANT_DEFAULT' &&
      status === 'APPROVED' &&
      (template.departmentId ?? null) === null &&
      template.tags.includes(PRE_SUMMARY_TAG) &&
      template.tags.includes(surfaceTag);
    if (!matches) continue;
    byTenant.set(template.tenantId, [...(byTenant.get(template.tenantId) ?? []), template.id ?? '(no id)']);
  }
  return byTenant;
};

describe('RF-2 — at most ONE tenant pre-summary candidate per (tenant, surface tag)', () => {
  it.each(SURFACE_TAGS)('surface %s resolves deterministically for every seeded tenant', (surfaceTag) => {
    const offenders = [...candidatesFor(surfaceTag).entries()].filter(([, ids]) => ids.length > 1);

    expect(offenders).toEqual([]);
  });

  it('the seeded ArcaAI v1 row carries BOTH the family tag and the text-v1 surface tag', () => {
    // Since OD-7(b) the production 'v1' query no longer REQUIRES the `text-v1`
    // tag (it excludes `dept-free` instead, so an untagged row still
    // resolves) — but the seeded row keeps carrying it as a label, and this
    // scan still uses it to identify the v1 candidate set for the
    // uniqueness check above.
    const arcaaiV1 = [...candidatesFor('text-v1').values()].flat();
    expect(arcaaiV1.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B-12, as amended by TASK-890 L13 step v: the SYSTEM defaults are the REFERENCE
// SET each tenant is provisioned from, not rows a tenant reads across the boundary
// ---------------------------------------------------------------------------

describe('the SYSTEM prompt defaults are a reference set, and their seeded rows still say so', () => {
  /**
   * B-12 made `PromptTemplate` / `PromptVersion` SYSTEM-shared-read so a non-owning tenant could
   * resolve the platform defaults by id. TASK-890 OD-M replaced that mechanism: a prompt is
   * CONTENT (§1.5), so each tenant is PROVISIONED with its own clone (seed phase
   * `26-tenant-reference-set.ts`, `TenantReferenceSetService` at runtime) and
   * `PromptResolutionService` resolves a `SYSTEM_DEFAULTS.*` pointer through `sourceTemplateId`
   * to that clone.
   *
   * The seeded rows below are UNCHANGED and still matter — they are the source the clone is
   * taken from. What changed is the reachability mechanism, and this locks the new one: the two
   * models are tenant-scoped and NOT shared-read, so nothing resolves them by widening.
   */
  it('PromptTemplate and PromptVersion are tenant-scoped and NOT SYSTEM-shared (the flip)', () => {
    for (const model of ['PromptTemplate', 'PromptVersion']) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
      expect(SYSTEM_SHARED_READ_MODELS.has(model), `${model} is CONTENT — it is cloned, not shared`).toBe(false);
    }
  });

  it('the SYSTEM catch-all SOAP fallback (…036) is owned by the SYSTEM tenant and pinned APPROVED v1 ', () => {
    const row = ALL_SEEDED_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.CATCHALL_SOAP) as
      (SeedTemplateLike & { approvedVersionNumber?: number }) | undefined;

    expect(row).toBeDefined();
    // `SYSTEM_DEFAULTS.promptId` — the platform-wide SOAP fallback `assemble`
    // reads for every tenant with no SOAP opinion. Under the GLOBAL customer
    // tenant it was invisible to every other tenant (reads widen only to
    // `[caller, SYSTEM]`), so the durable lane's prompt assembly 404'd.
    expect(row?.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(row?.approvedVersionNumber).toBe(1);
    expect(row?.status ?? resolveSeedStatus(row!.category)).toBe('APPROVED');
  });

  it('the SYSTEM pre-summary default (…040) is owned by the SYSTEM tenant and pinned APPROVED v1', () => {
    const row = ALL_SEEDED_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.PRE_SUMMARY_DEFAULT) as
      (SeedTemplateLike & { approvedVersionNumber?: number }) | undefined;

    expect(row).toBeDefined();
    // Before the C2 fold-in this row belonged to the GLOBAL customer tenant, so
    // every other tenant's lookup missed it and the chain 503'd.
    expect(row?.tenantId).toBe(SYSTEM_TENANT_ID);
    // The resolver serves the immutable PromptVersion snapshot, not the mutable
    // template row — which requires the approved pin.
    expect(row?.approvedVersionNumber).toBe(1);
    expect(row?.status ?? resolveSeedStatus(row!.category)).toBe('APPROVED');
  });
});

// ---------------------------------------------------------------------------
// R-C3 (ii) flip: the seeded dept-free fork (D2)
// ---------------------------------------------------------------------------

describe('R-C3 (ii) flip — the seeded department-free pre-summary fork (D2)', () => {
  it('exists at SYSTEM_DEFAULTS.deptFreePreSummaryPromptId, SYSTEM-owned, APPROVED, pinned v1', () => {
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.id).toBe(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID);
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.status).toBe('APPROVED');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.scope).toBe('TENANT_DEFAULT');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.departmentId).toBeNull();
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.approvedVersionNumber).toBe(1);
  });

  it("carries the ['pre-summary','dept-free'] surface tags (RF-2)", () => {
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.tags).toEqual(expect.arrayContaining(['pre-summary', 'dept-free']));
  });

  it('its body contains NO {current_department} / {visit_type} placeholder or "(Latest Dept Note)" heading', () => {
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('{current_department}');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('{visit_type}');
    expect(SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT).not.toContain('(Latest Dept Note)');
  });

  it('dept-free surface scan now sees exactly this one candidate for the SYSTEM tenant', () => {
    const candidates = candidatesFor('dept-free');
    expect(candidates.get(SYSTEM_TENANT_ID)).toEqual([SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID]);
  });
});

// ---------------------------------------------------------------------------
// PENDING — assertions to add when C3 lands
// ---------------------------------------------------------------------------
//
// * R-N1 — after C3: assert the seeded SYSTEM live-default template is the one
//   the live loop actually serves (today only its BYTES are locked, by
//   `system-live-soap-default-checksum.test.ts`; the wiring assertion needs the
//   C3 live chain).
