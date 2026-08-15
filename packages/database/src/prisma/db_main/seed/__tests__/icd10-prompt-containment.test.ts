import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_PROMPT_TEMPLATES,
  CUSTOMER_PROMPT_VERSIONS,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_PROMPT_VERSIONS,
  EXTRA_PROMPT_VERSIONS,
  SOAP_OUTPUT_SCHEMA,
} from '../07-prompt-template';
import { ARCAAI_CLINICAL_TEMPLATES, ARCAAI_CLINICAL_VERSIONS } from '../07b-arcaai-clinical-templates';

/**
 * TASK-702 golden test — register invariants INV-065/066/071/231/233/373/432/449
 * (`docs/architecture/agentic-workflow-platform/design.md`, `01-invariant-register.md`,
 * category `terminology`): no seeded prompt may instruct the model to
 * free-write an ICD-10 diagnosis code. Verification, not the prompt, is the
 * only sanctioned source of a code — "the clinician stated it" is model-
 * asserted transcription fidelity, not a tool-verified match, so it does not
 * satisfy the invariant either.
 *
 * The containment bar is a blanket substring ban: no seeded `content` string
 * (nor a JSON-schema field description) may contain "ICD-10" anywhere, live
 * or historical, full stop — not "only if verified", not "only in a negated
 * sentence". A negated instruction ("do not write an ICD-10 code") still
 * names the code system to the model; the fix text throughout this ticket
 * says "a diagnostic code" instead, precisely so the term never appears at
 * all.
 *
 * TWO deliberate, documented exceptions are allow-listed below:
 *
 * 1. The `EXTRA_PROMPT_VERSIONS` row for SOAP_SUMMARY versionNumber 3
 *    (id …0102) is a preserved historical snapshot of what version 3
 *    actually said when it was served — mutating it would falsify the
 *    history log (the ticket's own scoping explicitly requires it be left
 *    alone; the fix ships as a new versionNumber 4 row instead).
 *
 * 2. `ARCAAI_CLINICAL_VERSIONS` entries at versionNumber 1 are OUT OF SCOPE
 *    for this ticket. `07b-arcaai-clinical-content.ts` is a byte-exact,
 *    sha256-checksummed port of the RUNNING v1 production deployment
 *    (`packages/database/src/__tests__/v1-clinical-prompt-checksums.fixture.ts`
 *    + `v1-clinical-prompt-fidelity.test.ts`), which explicitly requires
 *    "explicit clinical/product sign-off" — a business decision, not an
 *    engineering one — before its pinned hashes may change. It is also
 *    functionally a NEVER-hand-edited historical snapshot (its own header:
 *    "GENERATED, DO NOT HAND-EDIT"), the same category as exception 1 above.
 *    v2 and v3 (the version this ticket actually fixed — v3 is what
 *    `ARCAAI_CLINICAL_APPROVED_VERSION` currently serves) carry no such gate
 *    and are fully clean. Rolling `ARCAAI_CLINICAL_APPROVED_VERSION` back to
 *    1 would re-expose the v1 wording; closing that gap requires a follow-up
 *    ticket with clinical/product sign-off to update the pinned fixture (see
 *    Implementation Summary / Risks).
 *
 * No other row of either kind is ever exempted.
 */

// The two deliberate, documented exceptions (see module comment above).
// Every other content string, live or historical, must be clean.
const HISTORICAL_SNAPSHOT_EXCEPTIONS = new Set<string>([
  '72000000-0000-0000-0000-000000000102', // SOAP_SUMMARY versionNumber 3 — pre-fix snapshot, preserved verbatim
]);

/**
 * ArcaAI v1 is out of scope — see exception 2 above. Checked by
 * `versionNumber === 1`, not by template id: the fixture pins ALL 23 v1
 * bodies (only 10 currently contain "ICD-10"), and the exemption reason
 * (byte-exact production port, sign-off-gated) applies uniformly to the
 * whole v1 corpus, not just the currently-affected subset.
 */
const isOutOfScopeArcaaiV1 = (versionNumber: number): boolean => versionNumber === 1;

const ICD10_PATTERN = /ICD-?10/i;

interface Violation {
  source: string;
  id: string;
  field: string;
  excerpt: string;
}

const findIcd10 = (source: string, id: string, field: string, value: string | null | undefined, violations: Violation[]) => {
  if (!value) return;
  const match = ICD10_PATTERN.exec(value);
  if (match) {
    const start = Math.max(0, match.index - 40);
    const end = Math.min(value.length, match.index + match[0].length + 40);
    violations.push({ source, id, field, excerpt: value.slice(start, end) });
  }
};

describe('ICD-10 prompt containment (TASK-702)', () => {
  it('never instructs the model to free-write an ICD-10 code, in any seeded prompt, live or historical', () => {
    const violations: Violation[] = [];

    // Base catalog — live template content.
    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      findIcd10('DEFAULT_PROMPT_TEMPLATES', template.id, 'content', template.content, violations);
    }
    for (const template of CUSTOMER_PROMPT_TEMPLATES) {
      findIcd10('CUSTOMER_PROMPT_TEMPLATES', template.id, 'content', template.content, violations);
    }

    // Base catalog — every historical PromptVersion snapshot (excluding the
    // one documented exception).
    for (const version of DEFAULT_PROMPT_VERSIONS) {
      findIcd10('DEFAULT_PROMPT_VERSIONS', version.id, 'content', version.content, violations);
    }
    for (const version of EXTRA_PROMPT_VERSIONS) {
      if (HISTORICAL_SNAPSHOT_EXCEPTIONS.has(version.id)) continue;
      findIcd10('EXTRA_PROMPT_VERSIONS', version.id, 'content', version.content, violations);
    }
    for (const version of CUSTOMER_PROMPT_VERSIONS) {
      findIcd10('CUSTOMER_PROMPT_VERSIONS', version.id, 'content', version.content, violations);
    }

    // Structured-output JSON-schema field descriptions (SOAP).
    for (const [field, schema] of Object.entries(SOAP_OUTPUT_SCHEMA.properties)) {
      findIcd10('SOAP_OUTPUT_SCHEMA', 'assessment-schema', `properties.${field}.description`, schema.description, violations);
    }

    // ArcaAI clinical library — live templates + all seeded versions (v1/v2/v3).
    for (const template of ARCAAI_CLINICAL_TEMPLATES) {
      findIcd10('ARCAAI_CLINICAL_TEMPLATES', template.id, 'content', template.content, violations);
    }
    for (const version of ARCAAI_CLINICAL_VERSIONS) {
      if (isOutOfScopeArcaaiV1(version.versionNumber)) continue;
      findIcd10('ARCAAI_CLINICAL_VERSIONS', `${version.promptTemplateId}@v${version.versionNumber}`, 'content', version.content, violations);
    }

    if (violations.length > 0) {
      const report = violations
        .map((v, i) => `${i + 1}. [${v.source}] id=${v.id} field=${v.field}\n   …${v.excerpt}…`)
        .join('\n');
      // eslint-disable-next-line no-console
      console.error(`ICD-10 prompt-containment violations (${violations.length}):\n${report}`);
    }

    expect(violations).toEqual([]);
  });

  it('documents exactly one historical-snapshot exception, and it still contains the pre-fix ICD-10 clause', () => {
    const exempted = EXTRA_PROMPT_VERSIONS.filter((v) => HISTORICAL_SNAPSHOT_EXCEPTIONS.has(v.id));
    expect(exempted).toHaveLength(1);
    expect(exempted[0]?.content).toMatch(ICD10_PATTERN);
  });

  it('documents the ArcaAI v1 out-of-scope exception: v1 still carries the pre-fix wording, v2/v3 do not', () => {
    const v1WithIcd10 = ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === 1 && ICD10_PATTERN.test(v.content));
    // The v1 corpus is a byte-exact production port with 23 seeded bodies;
    // 10 of them currently contain "ICD-10" (see module comment exception 2).
    expect(v1WithIcd10.length).toBe(10);

    const nonV1WithIcd10 = ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber !== 1 && ICD10_PATTERN.test(v.content));
    expect(nonV1WithIcd10).toEqual([]);
  });
});
