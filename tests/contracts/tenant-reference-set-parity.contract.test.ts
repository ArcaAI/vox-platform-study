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
    const missing = REFERENCE_SET_KINDS.filter(
      (kind) => !SEED_DECLARED_EXCEPTIONS.has(kind) && !SEED_SRC.includes(`async function ${copierName(kind)}(`),
    );
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

// ── Per-field policy: TAGS ───────────────────────────────────────────────────
//
// TASK-890 J7-2. The two copiers disagreed about tags, in opposite directions
// and by accident: the seed dropped them on BOTH prompts and agents (the prompt
// copier simply omitted the column), while the service kept them on both. So a
// seeded tenant and a synced tenant ended up with different rows from the same
// source, and nothing noticed.
//
// The policy, resolved once and asserted here on BOTH implementations:
//
//   • PROMPTS  — tags TRAVEL. A prompt template's tags are descriptive content
//     ("specialty:cardiology"), part of what the reference set is FOR; a copy
//     without them is a worse copy.
//   • AGENTS   — tags are DROPPED. An agent tag is `key:value` and the platform's
//     values (`platform-default`, tier markers) assert something about the
//     PLATFORM's row. Copied onto a tenant's agent they are false claims, and
//     `modelAllowedForTier` reads tags of that shape.
//
// A source-text guard for the same reason the rest of this file is one: the seed
// cannot be imported into a hermetic suite.

const AGENT_SERVICE_SRC = readFileSync(join(__dirname, '../../packages/applications/src/services/agent/agent.service.ts'), 'utf8');
const PROMPT_SERVICE_SRC = readFileSync(
  join(__dirname, '../../packages/applications/src/services/prompt-management/prompt-management.service.ts'),
  'utf8',
);

/** The text from `marker` up to the first line that closes at `closeIndent`. */
function blockFrom(src: string, marker: string, closeIndent: string): string {
  const start = src.indexOf(marker);
  expect(start, `not found: ${marker}`).toBeGreaterThan(-1);
  const end = src.indexOf(`\n${closeIndent}}\n`, start + marker.length);
  return src.slice(start, end === -1 ? src.length : end);
}

describe('tenant reference set — the tags policy is the same on both copiers', () => {
  it('PROMPTS keep their tags in the seed, exactly as the service does', () => {
    const seedCopier = blockFrom(SEED_SRC, 'async function copyPromptTemplates(', '');
    expect(seedCopier, 'seed/26 copyPromptTemplates drops tags; the service keeps them').toMatch(/tags:\s*source\.tags\s*\?\?\s*\[\]/);

    const serviceCopier = blockFrom(PROMPT_SERVICE_SRC, 'async cloneFromSystem(', '  ');
    expect(serviceCopier).toMatch(/tags:\s*source\.tags\s*\?\?\s*\[\]/);
  });

  it('AGENTS drop their tags in the service, exactly as the seed does', () => {
    const serviceCopier = blockFrom(AGENT_SERVICE_SRC, 'async cloneFromSystem(', '  ');
    expect(serviceCopier, "agent.service.ts cloneFromSystem carries the platform's tags onto a tenant row").toMatch(/tags:\s*\[\]/);
    expect(serviceCopier).not.toMatch(/tags:\s*source\.tags/);

    const seedCopier = blockFrom(SEED_SRC, 'async function copyAgents(', '');
    expect(seedCopier).toMatch(/tags:\s*\[\]/);
    expect(seedCopier).not.toMatch(/tags:\s*source\.tags/);
  });

  it('states the reason at BOTH agent call sites, so neither is "fixed" back by a reader who sees only one', () => {
    const reason = /tags assert something about the PLATFORM'?s row/i;
    expect(blockFrom(SEED_SRC, 'async function copyAgents(', '')).toMatch(reason);
    expect(blockFrom(AGENT_SERVICE_SRC, 'async cloneFromSystem(', '  ')).toMatch(reason);
  });
});
