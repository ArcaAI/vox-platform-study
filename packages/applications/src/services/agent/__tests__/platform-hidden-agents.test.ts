/**
 * TASK-974 §5.1 item 1 — the PLATFORM HIDDEN AGENT allow-list.
 *
 * The registry is the whole of the "hidden" concept: there is no `Agent.hidden` column and no
 * visibility enum (D-1). A slug is hidden because this table says so, which is what makes adding
 * a second hidden agent a code change plus an owner decision rather than a data edit.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_HIDDEN_AGENT_SLUGS } from '@arcaai/domains';
// Relative, not through the package root: `@arcaai/database`'s barrel boots a Prisma client,
// and `00-constants.ts` is pure literals with no imports of its own — the same reach
// `tenant-ability.regression.test.ts` uses for `SEED_ROLE_IDS`.
import { PLATFORM_HIDDEN_AGENT_SLUGS as SEED_PLATFORM_HIDDEN_AGENT_SLUGS } from '../../../../../database/src/prisma/db_main/seed/00-constants';
import { DNA_WRITING_STYLE_ANALYST_SLUG, PLATFORM_HIDDEN_AGENTS, isPlatformHiddenAgentSlug } from '../platform-hidden-agents';

describe('PLATFORM_HIDDEN_AGENTS', () => {
  it('declares exactly the DNA writing-style analyst today', () => {
    expect(Object.keys(PLATFORM_HIDDEN_AGENTS)).toEqual(['dna-writing-style-analyst']);
    expect(DNA_WRITING_STYLE_ANALYST_SLUG).toBe('dna-writing-style-analyst');
  });

  it('records the task and the purpose of every hidden slug', () => {
    for (const [slug, entry] of Object.entries(PLATFORM_HIDDEN_AGENTS)) {
      expect(slug.length, `${slug} must be a non-empty lineage key`).toBeGreaterThan(0);
      expect(entry.task).toBe('TEXT_GENERATION');
      expect(typeof entry.purpose).toBe('string');
      expect(entry.purpose.length, `${slug} must record WHY it is hidden`).toBeGreaterThan(0);
    }
  });

  it('isPlatformHiddenAgentSlug answers for a declared slug and refuses everything else', () => {
    expect(isPlatformHiddenAgentSlug(DNA_WRITING_STYLE_ANALYST_SLUG)).toBe(true);
    expect(isPlatformHiddenAgentSlug('casenote-finalization')).toBe(false);
    expect(isPlatformHiddenAgentSlug('')).toBe(false);
    // Not a prefix match, not a case-insensitive match: a lineage key is compared by equality.
    expect(isPlatformHiddenAgentSlug('dna-writing-style-analyst-2')).toBe(false);
    expect(isPlatformHiddenAgentSlug('DNA-Writing-Style-Analyst')).toBe(false);
  });

  /**
   * `AgentRepository.findPlatformHiddenBySlug` enforces the same allow-list one package DOWN,
   * where this registry cannot be imported from (`packages/applications` sits above
   * `packages/domains`). Two lists, one meaning — so the parity is asserted rather than assumed:
   * adding a slug here and not there yields a read that refuses its own registered agent, and
   * the reverse yields an unscoped SYSTEM read nothing declared.
   */
  it('is the same set as the allow-list the domains-tier read enforces', () => {
    expect(Object.keys(PLATFORM_HIDDEN_AGENTS).sort()).toEqual([...PLATFORM_HIDDEN_AGENT_SLUGS].sort());
  });

  /**
   * L5/F6 — and a THIRD list, in the seed.
   *
   * `packages/database` cannot import this registry either, and phase 26 is a second
   * implementation of the reference-set copy for the tenants the seed writes directly. Before
   * this parity check the seed had no skip at all, so `pnpm db:seed` handed every seeded tenant
   * an editable clone of the platform analyst — carrying the platform admin's model, and a
   * `sourceAgentId` pointing back at the SYSTEM row — while the runtime copier correctly refused
   * to make one. Three lists, one meaning; drift in any of them fails here.
   */
  it('is the same set as the allow-list the SEED`s reference-set copy skips', () => {
    expect(Object.keys(PLATFORM_HIDDEN_AGENTS).sort()).toEqual([...SEED_PLATFORM_HIDDEN_AGENT_SLUGS].sort());
  });

  it('narrows the slug type so a caller can index the registry after the check', () => {
    const slug: string = DNA_WRITING_STYLE_ANALYST_SLUG;
    if (isPlatformHiddenAgentSlug(slug)) {
      expect(PLATFORM_HIDDEN_AGENTS[slug].task).toBe('TEXT_GENERATION');
    }
  });
});
