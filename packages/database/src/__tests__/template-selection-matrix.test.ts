/**
 * Department x visit-type template-selection matrix guard.
 *
 * Why this exists: template selection for the ArcaAI
 * tenant is BELIEVED correct — all 11 departments wired, all APPROVED — but
 * nothing LOCKS it. Tier-1b (the legacy `newPatientPromptId` /
 * `revisitPromptId` department columns,
 * `prompt-resolution.service.ts:491`) silently SKIPS a resolved template that
 * is not `status: 'APPROVED'`, so a seed edit that flips one row's status, or
 * that quietly collapses new-patient and revisit onto the same template id,
 * would downgrade that department to the generic CATCHALL fallback with no
 * error anywhere. This test locks the matrix so that class of seed edit fails
 * loudly, here, instead of silently in production.
 *
 * Pure data/consistency test over the seed constants — no database. Reads the seed
 * constants directly.
 *
 * Lives in `packages/database` (not `apps/api`, where filed it):
 * that package exports only `.` and `./client`, so an apps/api home would
 * need a relative import ACROSS the package boundary — which Vitest tolerates
 * (esbuild strips types) but `tsc` rejects with TS6059 'not under rootDir'.
 * The assertions are purely about seed data, so this is also where they belong.
 */
import { describe, expect, it } from 'vitest';

import { ARCAAI_ALL_CLINICAL_DEPARTMENTS } from '../prisma/db_main/seed/04-department';
import {
  ARCAAI_CLINICAL_TEMPLATE_IDS,
  ARCAAI_CLINICAL_TEMPLATES,
} from '../prisma/db_main/seed/07b-arcaai-clinical-templates';

// Build once: every template id this seed produces, plus its governance state.
const templatesById = new Map(ARCAAI_CLINICAL_TEMPLATES.map((template) => [template.id, template]));

describe('ArcaAI department x visit-type template-selection matrix', () => {
  it('covers all eleven ArcaAI clinical departments (v1 parity — no more, no fewer)', () => {
    // Guards against the matrix silently shrinking or growing without this
    // test's per-department assertions below being updated deliberately.
    expect(ARCAAI_ALL_CLINICAL_DEPARTMENTS).toHaveLength(11);
    const codes = ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((dept) => dept.code);
    expect(new Set(codes).size).toBe(11);
  });

  it('the template catalogue used below is non-trivial (22 summary + 1 pre-summary)', () => {
    expect(ARCAAI_CLINICAL_TEMPLATES).toHaveLength(23);
  });

  it.each(ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((dept) => [dept.code, dept] as const))(
    '%s — both visit-type columns are set, point at real APPROVED templates, and differ from each other',
    (_code, dept) => {
      // Both columns set — a null column is exactly how a department silently
      // downgrades to the department-agnostic CATCHALL fallback.
      expect(dept.newPatientPromptId, `${dept.code}.newPatientPromptId is not set`).toBeTruthy();
      expect(dept.revisitPromptId, `${dept.code}.revisitPromptId is not set`).toBeTruthy();

      // No dangling ids — every id the department column names must exist in
      // the template catalogue this seed actually writes.
      const newPatientTemplate = templatesById.get(dept.newPatientPromptId as string);
      const revisitTemplate = templatesById.get(dept.revisitPromptId as string);
      expect(newPatientTemplate, `${dept.code}.newPatientPromptId (${dept.newPatientPromptId}) has no matching ARCAAI_CLINICAL_TEMPLATES row`).toBeDefined();
      expect(revisitTemplate, `${dept.code}.revisitPromptId (${dept.revisitPromptId}) has no matching ARCAAI_CLINICAL_TEMPLATES row`).toBeDefined();

      // APPROVED + a pinned approvedVersionNumber — tier-1b silently skips
      // anything else (prompt-resolution.service.ts:491), so a status drift
      // here is a silent downgrade to the generic fallback, not an error.
      expect(newPatientTemplate!.status, `${dept.code} new-patient template is not APPROVED`).toBe('APPROVED');
      expect(revisitTemplate!.status, `${dept.code} revisit template is not APPROVED`).toBe('APPROVED');
      expect(newPatientTemplate!.approvedVersionNumber, `${dept.code} new-patient template has no approvedVersionNumber`).not.toBeNull();
      expect(revisitTemplate!.approvedVersionNumber, `${dept.code} new-patient template has no approvedVersionNumber`).not.toBeUndefined();
      expect(revisitTemplate!.approvedVersionNumber, `${dept.code} revisit template has no approvedVersionNumber`).not.toBeNull();
      expect(revisitTemplate!.approvedVersionNumber, `${dept.code} revisit template has no approvedVersionNumber`).not.toBeUndefined();

      // Each referenced template is department-bound to THIS department, not
      // borrowed from another one or left department-agnostic.
      expect(newPatientTemplate!.departmentId, `${dept.code} new-patient template is not bound to a department`).not.toBeNull();
      expect(revisitTemplate!.departmentId, `${dept.code} revisit template is not bound to a department`).not.toBeNull();

      // New-patient and revisit must resolve to DIFFERENT templates — a
      // visit-type collapse is exactly the shipped-once failure mode this
      // matrix exists to prevent.
      expect(dept.revisitPromptId, `${dept.code} new-patient and revisit collapse onto the same template id`).not.toBe(
        dept.newPatientPromptId,
      );
    },
  );

  it('no two departments share a new-patient or a revisit template id (no cross-department aliasing)', () => {
    const newPatientIds = ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((dept) => dept.newPatientPromptId);
    const revisitIds = ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((dept) => dept.revisitPromptId);
    expect(new Set(newPatientIds).size).toBe(newPatientIds.length);
    expect(new Set(revisitIds).size).toBe(revisitIds.length);
  });

  it('every id referenced by a department column exists in ARCAAI_CLINICAL_TEMPLATE_IDS (no dangling ids, both directions)', () => {
    const knownTemplateIds = new Set(Object.values(ARCAAI_CLINICAL_TEMPLATE_IDS));
    for (const dept of ARCAAI_ALL_CLINICAL_DEPARTMENTS) {
      expect(knownTemplateIds.has(dept.newPatientPromptId as string), `${dept.code}.newPatientPromptId is not a known ArcaAI template id`).toBe(
        true,
      );
      expect(knownTemplateIds.has(dept.revisitPromptId as string), `${dept.code}.revisitPromptId is not a known ArcaAI template id`).toBe(true);
    }
  });

  it('no ArcaAI clinical department sets a department-scoped preSummaryPromptId (pre-summary has no department axis —)', () => {
    // Deliberate v1 behaviour, not an oversight (see this seed's own header
    // and): every ArcaAI department must be
    // `preSummaryPromptId: null`. Locking it here means a future edit that
    // adds one is a conscious, reviewed change, not a silent divergence from
    // the documented cascade.
    for (const dept of ARCAAI_ALL_CLINICAL_DEPARTMENTS) {
      expect(dept.preSummaryPromptId, `${dept.code}.preSummaryPromptId should be null`).toBeNull();
    }
  });
});
