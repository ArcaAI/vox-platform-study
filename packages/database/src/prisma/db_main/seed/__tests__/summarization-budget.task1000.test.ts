/**
 * TASK-1000 — every seeded summarization agent is given a budget its note shape can fit in.
 *
 * The defect this pins: all 22 `arcaai-*-summary-*` agents shared one `maxTokens: 2048` across
 * templates running from 5 to 23 sections. On 2026-09-22 a 14-section note outgrew it mid
 * consultation, the engine cut the turn JSON at `stop_reason: "length"`, and the fragment was
 * written into the note's first section as if it were clinical content.
 */
import { describe, expect, it } from 'vitest';

import { ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES, arcaaiDocumentTemplateSlug } from '../27-document-template-library';
import { SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS, SUMMARIZATION_TOKENS_PER_SECTION, summarizationMaxTokens } from '../25-agents';
import { ARCAAI_DEPARTMENT_AGENT_SPECS, ARCAAI_DEPARTMENT_TABLE, VISIT_TYPES, arcaaiAgentSlug } from '../29-arcaai-agents-and-workflows';

const sectionsBySlug = new Map(ARCAAI_DEPARTMENT_DOCUMENT_TEMPLATES.map((item) => [item.slug, item.shape.sections.length]));

const maxTokensOf = (slug: string): number => {
  const spec = ARCAAI_DEPARTMENT_AGENT_SPECS.find((candidate) => candidate.slug === slug);
  expect(spec, `no seeded agent ${slug}`).toBeDefined();
  return (spec!.parameters as { generation: { maxTokens: number } }).generation.maxTokens;
};

describe('TASK-1000 — seeded summarization budgets are sized to the note shape', () => {
  it('covers all 22 department agents', () => {
    expect(ARCAAI_DEPARTMENT_AGENT_SPECS).toHaveLength(ARCAAI_DEPARTMENT_TABLE.length * VISIT_TYPES.length);
    expect(ARCAAI_DEPARTMENT_AGENT_SPECS).toHaveLength(22);
  });

  it('never seeds an agent below the owner-directed absolute floor', () => {
    for (const spec of ARCAAI_DEPARTMENT_AGENT_SPECS) {
      expect(maxTokensOf(spec.slug), spec.slug).toBeGreaterThanOrEqual(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS);
    }
  });

  it('gives every agent at least its own template’s per-section allowance', () => {
    for (const row of ARCAAI_DEPARTMENT_TABLE) {
      for (const visit of VISIT_TYPES) {
        const sections = sectionsBySlug.get(arcaaiDocumentTemplateSlug(row.slugPart, visit));
        expect(sections, `${row.slugPart} ${visit} has no document template`).toBeDefined();
        expect(maxTokensOf(arcaaiAgentSlug(row, visit)), `${row.slugPart} ${visit}`).toBeGreaterThanOrEqual(
          sections! * SUMMARIZATION_TOKENS_PER_SECTION,
        );
      }
    }
  });

  it('sizes the two templates that are genuinely larger than the floor above it', () => {
    // Surgical oncology intake: 23 sections, the largest shape the platform ships.
    const sonc = ARCAAI_DEPARTMENT_TABLE.find((row) => row.slugPart === 'sonc')!;
    expect(sectionsBySlug.get(arcaaiDocumentTemplateSlug('sonc', 'new-visit'))).toBe(23);
    expect(maxTokensOf(arcaaiAgentSlug(sonc, 'new-visit'))).toBe(23 * SUMMARIZATION_TOKENS_PER_SECTION);
  });

  it('holds the floor for the template that actually failed (14 sections) and for the smallest (5)', () => {
    const bren = ARCAAI_DEPARTMENT_TABLE.find((row) => row.slugPart === 'bren')!;
    const diet = ARCAAI_DEPARTMENT_TABLE.find((row) => row.slugPart === 'diet')!;

    expect(sectionsBySlug.get(arcaaiDocumentTemplateSlug('bren', 'new-visit'))).toBe(14);
    expect(maxTokensOf(arcaaiAgentSlug(bren, 'new-visit'))).toBe(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS);
    expect(maxTokensOf(arcaaiAgentSlug(diet, 'revisit'))).toBe(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS);
  });

  it('never seeds the 2048 that caused the incident', () => {
    for (const spec of ARCAAI_DEPARTMENT_AGENT_SPECS) {
      expect(maxTokensOf(spec.slug), spec.slug).not.toBe(2048);
    }
  });
});

describe('summarizationMaxTokens', () => {
  it('degrades an unresolvable section count to the floor rather than to nothing', () => {
    expect(summarizationMaxTokens(0)).toBe(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS);
    expect(summarizationMaxTokens(Number.NaN)).toBe(SUMMARIZATION_ABSOLUTE_FLOOR_TOKENS);
  });
});
