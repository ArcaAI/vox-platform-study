/**
 * the ArcaAI clinical prompt VERSION POLICY, pinned.
 *
 * Owner decision, 2026-08-17
 * (`docs/programs/agentic-workflow-platform/owner-decisions-2026-08-17.md`
 * row 702):
 *
 *   > "allow all current prompt versions, v3 will be default versions when
 *   > go-live."
 *
 * Two clauses, and they pull in opposite directions, so both are pinned here:
 *
 *   - **ALLOW ALL.** v1, v2 and v3 all stay seeded and selectable. v1 in
 *     particular is a byte-exact port of the RUNNING v1 production deployment
 *     (`src/__tests__/v1-clinical-prompt-checksums.fixture.ts` pins its
 *     sha256s); it is a historical artefact that must not be rewritten, and
 *     `ARCAAI_CLINICAL_APPROVED_VERSION = 1` remains a legitimate rollback.
 *
 *   - **v3 IS THE DEFAULT.** Which is load-bearing rather than cosmetic,
 *     because of a residual clinical-safety fact: **10 of v1's 23 bodies still
 *     instruct the model to write an ICD-10 code** (v2 and v3 were cleaned by
 * v1 was deliberately not — see `icd10-prompt-containment.test.ts`
 *     exception 2). So "all versions allowed" means a version that violates
 *     INV-065/066 is still reachable BY ROLLBACK — an explicit, auditable act —
 *     and must never become reachable BY DEFAULT.
 *
 * The guard below is exactly that distinction: v1 may exist, v1 may be rolled
 * back to on purpose, but whatever `ARCAAI_CLINICAL_APPROVED_VERSION` points at
 * — the content every ArcaAI request actually gets — must be free of
 * code-authoring instructions. Moving the pin to 1 or 2 is a one-line change;
 * this test is what makes moving it to a code-authoring version fail CI instead
 * of shipping silently.
 */

import { describe, it, expect } from 'vitest';

import {
  ARCAAI_CLINICAL_APPROVED_VERSION,
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_VERSIONS,
} from '../07b-arcaai-clinical-templates';

const ICD10_PATTERN = /ICD-?10/i;

describe('ArcaAI clinical prompt version policy ', () => {
  describe('all current versions stay available', () => {
    it('seeds exactly versions 1, 2 and 3 — none retired, none added', () => {
      const versions = [...new Set(ARCAAI_CLINICAL_VERSIONS.map((v) => v.versionNumber))].sort();
      expect(versions).toEqual([1, 2, 3]);
    });

    // There is deliberately NO v4. A department's heading list is the customer's signed-off
    // case-note structure, so when the document template and the prompt disagree it is the
    // TEMPLATE that is wrong; `27-document-template-library.ts` now derives every department
    // shape from these v3 bodies. A v4 that rewrote the headings to match a template would be
    // editing the clinical content to fit the software.
    it('seeds versions 1–3 for every template, so any pin up to the corpus default is a complete corpus', () => {
      const templateIds = [...new Set(ARCAAI_CLINICAL_VERSIONS.map((v) => v.promptTemplateId))];
      for (const versionNumber of [1, 2, 3]) {
        const forVersion = ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === versionNumber);
        expect(forVersion.map((v) => v.promptTemplateId).sort(), `version ${versionNumber} must cover every template`).toEqual(
          [...templateIds].sort(),
        );
      }
    });

    it('gives every seeded version a non-empty body', () => {
      const empty = ARCAAI_CLINICAL_VERSIONS.filter((v) => !v.content || v.content.trim().length === 0);
      expect(empty.map((v) => `${v.promptTemplateId}@v${v.versionNumber}`)).toEqual([]);
    });
  });

  describe('v3 is the go-live default for every template', () => {
    it('pins the corpus default at 3', () => {
      expect(ARCAAI_CLINICAL_APPROVED_VERSION).toBe(3);
    });

    it('pins every template to the approved version on BOTH the content row and the version pointer', () => {
      // A drift between `content` and `approvedVersionNumber` is the F-01/F-02
      // integrity defect the corpus's own module comment warns about: the
      // resolver serves the pinned PromptVersion snapshot, so a `content`
      // column saying something else is a silent divergence.
      for (const template of ARCAAI_CLINICAL_TEMPLATES) {
        expect(template.approvedVersionNumber, `${template.id} approvedVersionNumber`).toBe(ARCAAI_CLINICAL_APPROVED_VERSION);
        expect(template.currentVersionNumber, `${template.id} currentVersionNumber`).toBe(ARCAAI_CLINICAL_APPROVED_VERSION);

        const pinned = ARCAAI_CLINICAL_VERSIONS.find(
          (v) => v.promptTemplateId === template.id && v.versionNumber === ARCAAI_CLINICAL_APPROVED_VERSION,
        );
        expect(pinned, `${template.id} must have a PromptVersion row at the approved version`).toBeDefined();
        expect(template.content, `${template.id} content must equal its pinned snapshot`).toBe(pinned!.content);
      }
    });
  });

  describe('the DEFAULT may never be a code-authoring version (the guard)', () => {
    it('serves no ICD-10 authoring instruction at the approved pin', () => {
      // Deliberately asserted against the PIN, not against "v3": if someone
      // rolls ARCAAI_CLINICAL_APPROVED_VERSION back to 1 or 2, this is the
      // assertion that fires. v1 stays selectable; it just cannot become the
      // silent default.
      const servedAtPin = ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === ARCAAI_CLINICAL_APPROVED_VERSION);
      const violations = servedAtPin.filter((v) => ICD10_PATTERN.test(v.content)).map((v) => v.promptTemplateId);
      expect(violations, 'the default-served corpus must never instruct the model to write a diagnostic code').toEqual([]);

      const liveViolations = ARCAAI_CLINICAL_TEMPLATES.filter((t) => ICD10_PATTERN.test(t.content)).map((t) => t.id);
      expect(liveViolations).toEqual([]);
    });

    it('records the residual risk truthfully: v1 remains selectable AND still carries the wording', () => {
      // Not an aspiration — a fact this test refuses to let anyone forget.
      // If v1 is ever cleaned (with the clinical/product sign-off its checksum
      // fixture requires), this expectation must be updated deliberately.
      const v1WithIcd10 = ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === 1 && ICD10_PATTERN.test(v.content));
      expect(v1WithIcd10.length).toBe(10);
      expect(ARCAAI_CLINICAL_APPROVED_VERSION).not.toBe(1);
    });
  });
});
