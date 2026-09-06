/**
 * TASK-890 §3.4 — the reference set is copied by TWO implementations, and they must agree.
 *
 *  1. `TenantReferenceSetService` (`@arcaai/applications`) — the runtime copier, run inside
 *     `TenantService.create` and behind `POST admin/tenants/:id/reference-set/sync`.
 *  2. `seed/26-tenant-reference-set.ts` (`@arcaai/database`) — a raw-Prisma second copy, because
 *     the seeded tenants (Global, ArcaAI) are written directly by `05-tenant.ts` and never pass
 *     through the API. `packages/database` cannot import `@arcaai/applications` (that is the
 *     dependency direction inverted), so the duplication is structural, not accidental.
 *
 * Nothing else in the repo notices when one of them grows a kind and the other does not — and the
 * failure mode is silent: after the content flip (L13 step v) a tenant missing a kind resolves
 * `AGENT_NOT_ASSIGNED` / `PROMPT_DEFAULT_NOT_PROVISIONED` on its first consultation, which is
 * proof #9's job to catch on a live database and this test's job to catch at build time.
 *
 * This is a SOURCE-TEXT guard on purpose: importing the seed module into a contract test would
 * pull a Prisma client into a suite that must stay hermetic. It asserts the two things the two
 * implementations must share — the KIND SET and the ORDER — and forces any deliberate divergence
 * to be declared HERE, in one place, with its reason.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_SET_KINDS, type ReferenceSetKind } from '@arcaai/applications';

const SEED_SRC = readFileSync(join(__dirname, '../../packages/database/src/prisma/db_main/seed/26-tenant-reference-set.ts'), 'utf8');

/**
 * The ONE kind the seed deliberately does not copy, with the reason the seed itself states:
 * `WorkflowAssignmentService.resolve` has no SYSTEM tier and never had one, so a seeded tenant
 * with no definition behaves exactly as it does today (the legacy dispatch path). The runtime
 * service still copies it — a tenant admin gets something to publish — and the re-sync route
 * adds it to a seeded tenant on request.
 */
const SEED_DECLARED_EXCEPTIONS: ReadonlySet<ReferenceSetKind> = new Set<ReferenceSetKind>(['workflowDefinitions']);

/** `contextSchemas` → `copyContextSchemas`. */
function copierName(kind: ReferenceSetKind): string {
  return `copy${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

describe('tenant reference set — the seed phase and the runtime service copy the same kinds', () => {
  it('every kind the service copies is implemented by the seed, or is a DECLARED exception', () => {
    const missing = REFERENCE_SET_KINDS.filter((kind) => !SEED_DECLARED_EXCEPTIONS.has(kind) && !SEED_SRC.includes(`async function ${copierName(kind)}(`));
    expect(missing, `seed/26-tenant-reference-set.ts implements no ${missing.map(copierName).join(', ')}`).toEqual([]);
  });

  it('the declared exception is still declared IN THE SEED, so the divergence is documented where it happens', () => {
    for (const kind of SEED_DECLARED_EXCEPTIONS) {
      expect(SEED_SRC).toContain('Workflow definitions are deliberately NOT copied here');
      expect(SEED_SRC.includes(`async function ${copierName(kind)}(`)).toBe(false);
    }
  });

  it('copies in the canonical order — prompts before agents, agents before assignments', () => {
    const shared = REFERENCE_SET_KINDS.filter((kind) => !SEED_DECLARED_EXCEPTIONS.has(kind));
    const provisionBody = SEED_SRC.slice(SEED_SRC.indexOf('export async function provisionTenantReferenceSet'));
    const positions = shared.map((kind) => provisionBody.indexOf(`await ${copierName(kind)}(`));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('stamps the same provenance columns the runtime clone paths stamp — proof #9 cannot tell the two apart', () => {
    for (const column of ['sourceTenantId', 'sourceAgentId', 'sourceSlug', 'sourceVersionNumber', 'sourceTemplateId', 'templateLocked']) {
      expect(SEED_SRC, `seed/26 never writes ${column}`).toContain(column);
    }
  });

  it('refuses the SYSTEM tenant on both sides — it IS the reference set', () => {
    expect(SEED_SRC).toContain('The SYSTEM tenant is the reference set; it cannot be provisioned from itself.');
  });
});
