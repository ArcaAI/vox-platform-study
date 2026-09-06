/**
 * TASK-890 J7-1 — a prompt template is authored in exactly ONE tenant.
 *
 * The eight generic care-setting bodies were authored on the GLOBAL customer
 * tenant (`07-prompt-template.ts`) and then PROMOTED onto SYSTEM as byte copies
 * under fresh ids (`07a-agent-golden-library.ts`). That left two rows with the
 * same name in two tenants, and phase 26's clone guard — which skips a source
 * whose `(tenantId, name)` the target already owns, so a tenant never gains a
 * second row it cannot tell apart — correctly refused to clone them back.
 *
 * Measured consequence on the dev database before this fix: Global carried 9 of
 * SYSTEM's 17 templates as stamped clones and kept 8 UNSTAMPED originals, so the
 * owner's rule ("Global has the same as SYSTEM") was false for exactly the eight
 * bodies every newly-provisioned tenant is supposed to start from.
 *
 * The fix is authorship, not a guard exception: the eight live on SYSTEM, and
 * Global receives them the way every other tenant does — as a stamped clone.
 * These tests pin the three properties that keeps true.
 */

import { describe, expect, it } from 'vitest';
import { SYSTEM_TENANT_ID } from '../prisma/db_main/seed/00-constants';
import { CUSTOMER_PROMPT_TEMPLATES, DEFAULT_PROMPT_TEMPLATES, DEFAULT_TENANT_ID } from '../prisma/db_main/seed/07-prompt-template';
import { GOLDEN_PROMPT_TEMPLATES, GOLDEN_TEMPLATE_SOURCE_BY_CODE } from '../prisma/db_main/seed/07a-agent-golden-library';

const ALL_SEEDED = [...DEFAULT_PROMPT_TEMPLATES, ...CUSTOMER_PROMPT_TEMPLATES] as ReadonlyArray<{
  id: string;
  tenantId: string;
  name: string;
  departmentId?: string | null;
}>;

const GOLDEN_SOURCE_IDS = new Set(Object.values(GOLDEN_TEMPLATE_SOURCE_BY_CODE));

describe('reference-set prompt authoring — one home per template', () => {
  it('authors the eight generic care-setting bodies on the SYSTEM tenant', () => {
    const golden = ALL_SEEDED.filter((t) => GOLDEN_SOURCE_IDS.has(t.id));
    expect(golden).toHaveLength(GOLDEN_SOURCE_IDS.size);
    for (const template of golden) {
      expect(template.tenantId, `${template.name} is not authored on SYSTEM`).toBe(SYSTEM_TENANT_ID);
    }
  });

  it('gives them no department — a SYSTEM row may not point at a customer tenant’s department', () => {
    for (const template of ALL_SEEDED.filter((t) => GOLDEN_SOURCE_IDS.has(t.id))) {
      expect(template.departmentId ?? null, `${template.name} still names a department`).toBeNull();
    }
  });

  it('leaves no SYSTEM template sharing a name with a Global-authored one — phase 26 skips those by name', () => {
    const globalNames = new Set(ALL_SEEDED.filter((t) => t.tenantId === DEFAULT_TENANT_ID).map((t) => t.name));
    const collisions = ALL_SEEDED.filter((t) => t.tenantId === SYSTEM_TENANT_ID && globalNames.has(t.name)).map((t) => t.name);
    expect(collisions, `these SYSTEM templates can never be cloned into Global: ${collisions.join(', ')}`).toEqual([]);
  });

  it('mints no second SYSTEM copy in the golden library — the golden set IS the seeded rows', () => {
    const seededIds = new Set(ALL_SEEDED.map((t) => t.id));
    const minted = GOLDEN_PROMPT_TEMPLATES.filter((t) => !seededIds.has(t.id)).map((t) => t.name);
    expect(minted, `07a mints duplicate SYSTEM rows for: ${minted.join(', ')}`).toEqual([]);
  });
});
