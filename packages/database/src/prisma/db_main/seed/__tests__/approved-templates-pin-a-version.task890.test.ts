/**
 * An APPROVED prompt template MUST pin a version.
 *
 * `PromptResolutionService.resolveGovernedContent` serves the `PromptVersion`
 * snapshot at `approvedVersionNumber` — never the mutable `content` column — so
 * a row that is APPROVED with a NULL pin resolves to nothing and is silently
 * SKIPPED by clinical resolution, while the console reads "Approved · not
 * approved". Three seeded ARCAAI rows shipped that way (TASK-890 black-box J2-7),
 * including "ArcaAI SOAP Summary", the tenant's department-agnostic summary
 * FALLBACK — so the fallback could not serve.
 *
 * The seed writes `status` through `resolvePromptStatus(category)`, so the
 * invariant is asserted against that resolved status, not the literal's own.
 */

import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_PROMPT_TEMPLATES,
  CUSTOMER_PROMPT_VERSIONS,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_PROMPT_VERSIONS,
  EXTRA_PROMPT_VERSIONS,
  resolvePromptPublication,
} from '../07-prompt-template';

interface SeededTemplate {
  id: string;
  name: string;
  category: string;
  currentVersionNumber?: number;
  approvedVersionNumber?: number | null;
}

const SEEDED: SeededTemplate[] = [
  ...(DEFAULT_PROMPT_TEMPLATES as unknown as SeededTemplate[]),
  ...(CUSTOMER_PROMPT_TEMPLATES as unknown as SeededTemplate[]),
];

const SEEDED_VERSIONS = [...DEFAULT_PROMPT_VERSIONS, ...EXTRA_PROMPT_VERSIONS, ...CUSTOMER_PROMPT_VERSIONS] as Array<{
  promptTemplateId: string;
  versionNumber: number;
}>;

describe('seeded prompt templates', () => {
  it('pins an approved version on every row the seed publishes as APPROVED', () => {
    const unpinned = SEEDED
      .filter((template) => {
        const publication = resolvePromptPublication(template);
        return publication.status === 'APPROVED' && publication.approvedVersionNumber === null;
      })
      .map((template) => template.name);

    expect(unpinned, 'APPROVED without approvedVersionNumber resolves to nothing at runtime').toEqual([]);
  });

  it('pins a version that is actually seeded', () => {
    for (const template of SEEDED) {
      const pinned = resolvePromptPublication(template).approvedVersionNumber;
      if (pinned === null) continue;
      const exists = SEEDED_VERSIONS.some((version) => version.promptTemplateId === template.id && version.versionNumber === pinned);
      expect(exists, `${template.name} pins v${pinned}, which has no seeded PromptVersion row`).toBe(true);
      expect(pinned, `${template.name} pins v${pinned} above its current version`).toBeLessThanOrEqual(template.currentVersionNumber ?? 1);
    }
  });

  it('leaves a DRAFT row unpinned', () => {
    const dna = SEEDED.find((template) => template.category === 'DNA_ANALYSIS');

    expect(dna).toBeDefined();
    expect(resolvePromptPublication(dna!).status).toBe('DRAFT');
    expect(resolvePromptPublication(dna!).approvedVersionNumber).toBeNull();
  });
});
