import { describe, expect, it } from 'vitest';

import { CUSTOMER_PROMPT_TEMPLATES, DEFAULT_PROMPT_TEMPLATES } from '../07-prompt-template';
import { ARCAAI_CLINICAL_TEMPLATES } from '../07b-arcaai-clinical-templates';

/**
 * Static-inspection guard for `PromptResolutionService.findTenantPreSummaryTemplateId`
 * (packages/applications/.../consultation/prompt/prompt-resolution.service.ts:464-490),
 * which identifies a tenant's pre-summary template BY CONVENTION rather than a
 * first-class pointer: tenantId + scope=TENANT_DEFAULT + status=APPROVED +
 * departmentId=null + resourceStatus=ENABLED + tags includes 'pre-summary'.
 *
 * The Global tenant seeded TWO rows matching this convention
 * `…026` PRE_SUMMARY_SYSTEM (a one-paragraph system-role stub) and `…040`
 * PRE_SUMMARY_DEFAULT (the full body). The multi-candidate branch resolves the
 * first by `createdAt asc, id asc`, so the stub silently won over the intended
 * default. Per OD-4(b) the fix is to keep the convention but make a second
 * matching row a seed-time failure instead of a silent, order-dependent pick.
 *
 * This test replicates the seed function's status/scope defaulting — the
 * `resolvePromptStatus` rule and the Prisma `scope @default(TENANT_DEFAULT)` —
 * over every seed-defined template array (both `07-prompt-template.ts` arrays
 * plus the ArcaAI clinical templates, which carry `scope`/`status` explicitly),
 * since a naive read of the raw seed objects would miss `…026` (it omits both
 * fields and relies on the defaults).
 *
 * NOTE: once the dept-free pre-summary fork lands (Lane D2 /
 * OD-1b), a tenant may legitimately carry TWO pre-summary rows — the v1-parity
 * body (tag `smr-v1`) and the dept-free fork (a distinct surface tag, e.g.
 * `dept-free`). At that point this assertion must become per-(tenant,
 * surface-tag) uniqueness rather than per-tenant uniqueness — see RF-2 in
 * docs/implementation/TASK-635-Summarization-Agent-Conformance/README.md
 */

// Mirrors the (unexported) `resolvePromptStatus` in ../07-prompt-template.ts.
const resolveSeedStatus = (category: string): string => (category === 'DNA_ANALYSIS' ? 'DRAFT' : 'APPROVED');

// Mirrors the Prisma schema default `scope PromptTemplateScope @default(TENANT_DEFAULT)`
// (prompt-template.prisma) — seed rows that want the default simply omit `scope`.
const DEFAULT_SCOPE = 'TENANT_DEFAULT';
const PRE_SUMMARY_TAG = 'pre-summary';

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
];

const matchesPreSummaryConvention = (template: SeedTemplateLike): boolean => {
  const scope = template.scope ?? DEFAULT_SCOPE;
  const status = template.status ?? resolveSeedStatus(template.category);
  return (
    template.departmentId == null && scope === DEFAULT_SCOPE && status === 'APPROVED' && template.tags.includes(PRE_SUMMARY_TAG)
  );
};

/**
 * DELIBERATE EXPECTATION SHIFT.
 *
 * `…040` PRE_SUMMARY_DEFAULT no longer belongs to the GLOBAL customer tenant: C2
 * re-owned it to the SYSTEM tenant (seed 07-prompt-template.ts + migration
 * 20260808000100) so that every tenant can read it through the
 * SYSTEM_SHARED_READ_MODELS widening — before that, tier-2 was unreachable
 * cross-tenant and the pre-summary chain fell through to a 503 for any tenant
 * without its own TENANT_DEFAULT row.
 *
 * The at-most-one-per-tenant assertion below is UNCHANGED and still meaningful:
 * the Global tenant now has ZERO candidates and the SYSTEM tenant has exactly
 * one. The extra assertion added here pins WHICH tenant owns it, so a future
 * accidental re-own back to a customer tenant fails loudly instead of quietly
 * satisfying "at most one".
 */
describe('pre-summary convention candidate uniqueness (/ OD-4b)', () => {
  it('has at most one pre-summary-tag candidate per tenant', () => {
    const candidatesByTenant = new Map<string, string[]>();
    for (const template of ALL_SEEDED_TEMPLATES) {
      if (!matchesPreSummaryConvention(template)) continue;
      const list = candidatesByTenant.get(template.tenantId) ?? [];
      list.push(template.id ?? '<unknown-id>');
      candidatesByTenant.set(template.tenantId, list);
    }

    const tenantsWithMultipleCandidates = [...candidatesByTenant.entries()].filter(([, ids]) => ids.length > 1);

    expect(tenantsWithMultipleCandidates).toEqual([]);
  });

  it('seeds SYSTEM_DEFAULTS.preSummaryPromptId (…040) under the SYSTEM tenant, not a customer tenant (B-12)', () => {
    const systemDefault = ALL_SEEDED_TEMPLATES.find((t) => t.id === '71000000-0000-0000-0000-000000000040');
    expect(systemDefault, 'the SYSTEM pre-summary default row disappeared from the seed').toBeDefined();
    expect(systemDefault!.tenantId).toBe('00000000-0000-0000-0000-000000000000');
    // Still a convention-matching row — SYSTEM ownership must not accidentally
    // drop the tags/scope that make it discoverable.
    expect(matchesPreSummaryConvention(systemDefault!)).toBe(true);
  });

  it('leaves the Global customer tenant with no pre-summary candidate of its own', () => {
    const globalCandidates = ALL_SEEDED_TEMPLATES.filter(
      (t) => t.tenantId === '50000000-0000-0000-0000-000000000000' && matchesPreSummaryConvention(t),
    );
    // Global now resolves the SYSTEM row through the shared-read widening, the
    // same path every other tenant takes — one code path, not two.
    expect(globalCandidates).toEqual([]);
  });
});
