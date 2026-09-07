/**
 * TASK-891 (Lane D / W6) — the platform document-template reference library.
 *
 * Static assertions over the EXPORTED seed data; no live database, in keeping
 * with every other seed suite here (see `seed-idempotency.test.ts`).
 *
 * The heavy guard on this phase lives on the OTHER side of the package boundary:
 * `packages/applications/.../__tests__/platform-reference-shapes.task891.test.ts`
 * runs the same shapes through the REAL `compileDocumentTemplate` /
 * `documentTemplateShapeProblems` and asserts the frozen artifacts match. What
 * this file pins is what `packages/applications` cannot see — the row-shaped
 * facts (ids, slugs, pins, provenance) and the provenance of the protocol text.
 */
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_TEMPLATE_LIBRARY,
  NEW_VISIT_NOTE_SLUG,
  REALTIME_NOTE_PROTOCOL,
  REVISIT_NOTE_SLUG,
  shapeChecksum,
} from '../27-document-template-library';
import { MEDICINE_FOLLOWUP_CONTENT_V3, MEDICINE_NEW_REFERRAL_CONTENT_V3 } from '../07b-arcaai-clinical-content-v3';

describe('the seeded rows are servable and idempotently addressable', () => {
  it('seeds exactly the two visit-type shapes', () => {
    expect(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => entry.slug)).toEqual([NEW_VISIT_NOTE_SLUG, REVISIT_NOTE_SLUG]);
  });

  it('never seeds `soap_note` — that slug is the code-level fail-open default', () => {
    // `platform-document-shapes.ts` owns it, and every seeded workflow's realtime
    // node already names it. A row under that slug would shadow the default.
    expect(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => entry.slug)).not.toContain('soap_note');
  });

  it('allocates ids from the two reserved blocks, in lower case', () => {
    for (const entry of DOCUMENT_TEMPLATE_LIBRARY) {
      expect(entry.id).toMatch(/^8a000000-0000-0000-0000-[0-9a-f]{12}$/);
      expect(entry.versionId).toMatch(/^8b000000-0000-0000-0000-[0-9a-f]{12}$/);
    }
    const ids = DOCUMENT_TEMPLATE_LIBRARY.flatMap((entry) => [entry.id, entry.versionId]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('freezes a checksum computed by the same algorithm the publish path uses', () => {
    for (const entry of DOCUMENT_TEMPLATE_LIBRARY) {
      expect(entry.checksum).toBe(shapeChecksum(entry.shape));
    }
  });

  it('freezes artifacts `resolveForGeneration` can actually use', () => {
    // A version row whose compiled artifacts are unusable is treated as a DATA
    // DEFECT: the service logs `document_template_compiled_missing` and degrades
    // to the platform shape — i.e. the seeded template silently does nothing.
    for (const entry of DOCUMENT_TEMPLATE_LIBRARY) {
      const compiled = entry.compiled as { responseFormat?: unknown; sectionKeys?: unknown };
      expect(compiled.responseFormat).toBeTruthy();
      expect(Array.isArray(compiled.sectionKeys)).toBe(true);
      expect((compiled.sectionKeys as string[]).length).toBeGreaterThan(0);
    }
  });
});

describe('the shared protocol is a traceable excerpt of the signed-off corpus', () => {
  // Block A ("=== SOURCE-OF-TRUTH PROTOCOL ===") is byte-identical across all 22
  // department bodies, so quoting from it quotes the shared protocol rather than
  // one department's prose. This asserts that premise rather than assuming it.
  const blockA = (body: string) => body.slice(body.indexOf('=== SOURCE-OF-TRUTH PROTOCOL'), body.indexOf('=== END SOURCE-OF-TRUTH PROTOCOL ==='));

  it('Block A really is shared between the two visit types', () => {
    expect(blockA(MEDICINE_NEW_REFERRAL_CONTENT_V3)).toBe(blockA(MEDICINE_FOLLOWUP_CONTENT_V3));
  });

  it.each([
    ["Write a statement only if a reader could point to the part of\ntoday's transcript that supports it.", 'ATTRIBUTION'],
    ['Add no advice, no\ninterpretation, no differential, no reassurance, no risk statement and no recommendation\nof your own', 'NO AI AUTHORSHIP'],
  ])('quotes %#(%s) verbatim from Block A', (fragment) => {
    // Verbatim in the corpus (which hard-wraps); the seeded copy is unwrapped, so
    // compare on collapsed whitespace.
    const collapse = (value: string) => value.replace(/\s+/g, ' ');
    expect(collapse(blockA(MEDICINE_NEW_REFERRAL_CONTENT_V3))).toContain(collapse(fragment));
    expect(collapse(REALTIME_NOTE_PROTOCOL)).toContain(collapse(fragment));
  });

  it('does NOT lift RULE 3 verbatim — it contradicts the strict-decoding contract', () => {
    // The corpus says "Omitting a heading is always correct". The compiler emits
    // a schema in which EVERY key is required and absence is the `null` sentinel,
    // so the verbatim sentence instructs the model to do what the decoder forbids.
    expect(MEDICINE_NEW_REFERRAL_CONTENT_V3).toContain('Omitting a heading is always correct');
    expect(REALTIME_NOTE_PROTOCOL).not.toContain('Omitting a heading is always correct');
    // Its INTENT survives, restated against the sentinel the compiler emits.
    expect(REALTIME_NOTE_PROTOCOL).toContain('set the section to null instead');
    expect(REALTIME_NOTE_PROTOCOL).toContain('"N/A"');
  });

  it('fits inside the shape validator’s globalInstruction ceiling, which the full protocol does not', () => {
    const fullProtocol = MEDICINE_NEW_REFERRAL_CONTENT_V3.slice(0, MEDICINE_NEW_REFERRAL_CONTENT_V3.indexOf('When the current encounter'));
    // Measured, not assumed: this is why the protocol could not be lifted whole.
    expect(fullProtocol.length).toBeGreaterThan(10_000);
    expect(REALTIME_NOTE_PROTOCOL.length).toBeLessThanOrEqual(10_000);
  });

  it('names no code system — the containment bar is a blanket substring ban', () => {
    for (const entry of DOCUMENT_TEMPLATE_LIBRARY) {
      expect(JSON.stringify(entry.shape)).not.toContain('ICD');
    }
  });
});

describe('the section lists are the corpus heading lists', () => {
  /** The `**Heading**` / `N. **Heading**` titles of a corpus body, in source order. */
  const corpusHeadings = (body: string): string[] => {
    const block = body.slice(body.indexOf('When the current encounter'), body.indexOf('BEFORE YOU EMIT'));
    return [...block.matchAll(/^\s*(?:\d+\.\s*)?\*\*(.+?)\*\*\s*$/gm)].map((match) => match[1]!.trim());
  };

  it.each([
    [NEW_VISIT_NOTE_SLUG, MEDICINE_NEW_REFERRAL_CONTENT_V3],
    [REVISIT_NOTE_SLUG, MEDICINE_FOLLOWUP_CONTENT_V3],
  ])('%s has one section per corpus heading, in source order', (slug, body) => {
    const entry = DOCUMENT_TEMPLATE_LIBRARY.find((candidate) => candidate.slug === slug)!;
    const headings = corpusHeadings(body);
    expect(headings.length).toBeGreaterThan(0);
    expect(entry.shape.sections.length).toBe(headings.length);
    // Titles are the EMR's section keys, not prose (the corpus header says so), so
    // they are compared on the apostrophe-normalised text rather than loosely.
    const normalise = (value: string) => value.replace(/’/g, "'");
    expect(entry.shape.sections.map((section) => normalise(section.title))).toEqual(headings.map(normalise));
  });
});
