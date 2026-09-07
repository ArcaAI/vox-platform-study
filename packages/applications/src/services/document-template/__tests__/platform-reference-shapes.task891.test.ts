/**
 * TASK-891 (Lane D / W6) — the seeded platform document-template reference library.
 *
 * The library lives in `packages/database` (`seed/27-document-template-library.ts`)
 * because that is where seeds live, and that package may not import
 * `@arcaai/applications` — importing it would close the cycle
 * applications -> domains -> database. So the seed carries its OWN copy of
 * `compileDocumentTemplate`, and this suite is what stops the two drifting.
 *
 * The import below reaches across the package boundary BY RELATIVE PATH, which is
 * a test-only construction with an established precedent in this repo
 * (`consultation/loop/__tests__/day1-loop-defaults.task686.test.ts` does exactly
 * the same thing for `07e`'s canonicalisers). It is not a runtime dependency:
 * nothing in `src/**` outside `__tests__` may do this.
 *
 * Three claims, and they are worth keeping apart:
 *
 *  1. **The seeded shapes are publishable.** They are validated by the REAL
 *     `documentTemplateShapeProblems`, not by a restatement of it — a shape a
 *     tenant admin could not have authored has no business being seeded.
 *  2. **The frozen artifacts are what the real compiler emits.** `compiled` is
 *     stored on the immutable version row and `resolveForGeneration` treats an
 *     unusable one as a data defect (it logs and degrades to the platform shape),
 *     so a divergent port would present as "the tenant's template silently does
 *     nothing", which is precisely the failure this ticket exists to fix.
 *  3. **The pair actually expresses the visit-type axis.** Two rows that differ
 *     only in their title would satisfy every mechanical check above and satisfy
 *     none of the requirement.
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate, DOCUMENT_TEMPLATE_COMPILER_VERSION } from '../document-template-compiler';
import { documentTemplateShapeProblems, DocumentTemplateShape, MAX_DOCUMENT_SECTIONS } from '../document-template-shape';
import { computeShapeChecksum } from '../document-shape-diff';
import { SOAP_NOTE_SLUG } from '../platform-document-shapes';

import {
  DOCUMENT_TEMPLATE_LIBRARY,
  NEW_VISIT_NOTE_SHAPE,
  NEW_VISIT_NOTE_SLUG,
  REVISIT_NOTE_SHAPE,
  REVISIT_NOTE_SLUG,
  SEED_DOCUMENT_TEMPLATE_COMPILER_VERSION,
} from '../../../../../database/src/prisma/db_main/seed/27-document-template-library';

const asShape = (shape: unknown) => shape as DocumentTemplateShape;

describe('the seeded shapes are publishable by the real validator', () => {
  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))('%s has zero shape problems', (_slug, entry) => {
    expect(documentTemplateShapeProblems(entry.shape)).toEqual([]);
  });

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))('%s declares no STRUCTURED section', (_slug, entry) => {
    // The seed's compiler port covers PROSE/BULLETS only and throws on
    // STRUCTURED. Asserting the precondition here is what makes that honest.
    expect(asShape(entry.shape).sections.map((section) => section.form)).not.toContain('STRUCTURED');
  });

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))('%s marks no section `required`', (_slug, entry) => {
    // D-21: under `strict: true` a required section forbids the decoder from
    // representing "not discussed", so it invents one. Ten sections would be ten
    // invitations. A tenant that wants a never-blank section sets it on its own row.
    expect(asShape(entry.shape).sections.filter((section) => section.required === true)).toEqual([]);
  });

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))('%s stays within the section ceiling', (_slug, entry) => {
    expect(asShape(entry.shape).sections.length).toBeLessThanOrEqual(MAX_DOCUMENT_SECTIONS);
  });
});

describe('the frozen artifacts equal what the real compiler emits', () => {
  it('the seed port declares the same compiler version', () => {
    expect(SEED_DOCUMENT_TEMPLATE_COMPILER_VERSION).toBe(DOCUMENT_TEMPLATE_COMPILER_VERSION);
  });

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))(
    '%s: compiled === compileDocumentTemplate(shape)',
    (_slug, entry) => {
      expect(entry.compiled).toEqual(compileDocumentTemplate(asShape(entry.shape)));
    },
  );

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))('%s: checksum === computeShapeChecksum(shape)', (_slug, entry) => {
    expect(entry.checksum).toBe(computeShapeChecksum(entry.shape));
  });

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))(
    '%s: every section is nullable and every key is required (the D-21 pair)',
    (_slug, entry) => {
      const compiled = compileDocumentTemplate(asShape(entry.shape));
      const schema = compiled.responseFormat.json_schema as {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, { type: unknown }>;
      };

      expect(compiled.responseFormat.strict).toBe(true);
      expect(schema.additionalProperties).toBe(false);
      // Every key required — optionality is the NULLABLE type, never a missing key.
      expect(schema.required).toEqual(compiled.sectionKeys);
      for (const key of compiled.sectionKeys) {
        expect(schema.properties[key]?.type).toEqual(['string', 'null']);
        expect(compiled.sectionStates.sections[key]).toEqual({ allowNotDiscussed: true });
      }
    },
  );

  it.each(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => [entry.slug, entry] as const))('%s: sectionKeys preserve AUTHORED order', (_slug, entry) => {
    expect((entry.compiled as { sectionKeys: string[] }).sectionKeys).toEqual(asShape(entry.shape).sections.map((section) => section.key));
  });
});

describe('the pair expresses the visit-type axis', () => {
  const newVisit = NEW_VISIT_NOTE_SHAPE.sections.map((section) => section.key);
  const revisit = REVISIT_NOTE_SHAPE.sections.map((section) => section.key);

  it('neither slug shadows the platform code-default', () => {
    // A tenant row with `soap_note` SHADOWS `SOAP_NOTE_SHAPE`, and every seeded
    // workflow's realtime node names that slug today. Seeding it would change
    // what existing lanes resolve; these two get their own slugs instead.
    expect([NEW_VISIT_NOTE_SLUG, REVISIT_NOTE_SLUG]).not.toContain(SOAP_NOTE_SLUG);
    expect(DOCUMENT_TEMPLATE_LIBRARY.map((entry) => entry.slug)).not.toContain(SOAP_NOTE_SLUG);
  });

  it('the two shapes are not the same document under two names', () => {
    expect(newVisit).not.toEqual(revisit);
    const shared = newVisit.filter((key) => revisit.includes(key));
    // Three shared keys out of 18 distinct: a follow-up note tracks change, a new-visit
    // note collects history. If this ever grows towards "identical", the axis has
    // stopped meaning anything.
    expect(shared).toEqual(['examination_and_vitals', 'previous_diagnosis', 'current_diagnosis']);
    expect(newVisit.filter((key) => !revisit.includes(key)).length).toBeGreaterThanOrEqual(6);
    expect(revisit.filter((key) => !newVisit.includes(key)).length).toBeGreaterThanOrEqual(6);
  });

  it('both carry the shared realtime protocol as their globalInstruction', () => {
    expect(NEW_VISIT_NOTE_SHAPE.globalInstruction).toBe(REVISIT_NOTE_SHAPE.globalInstruction);
    expect(NEW_VISIT_NOTE_SHAPE.globalInstruction ?? '').toContain('NO AI AUTHORSHIP');
    // The compiler's own null-sentinel sentence and the protocol must agree:
    // the corpus's "omit the heading" wording would contradict it.
    expect(NEW_VISIT_NOTE_SHAPE.globalInstruction ?? '').toContain('set the section to null instead');
  });
});
