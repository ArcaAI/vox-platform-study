/**
 * TASK-930 §8.3 / §8.6 — the `general-medicine-consultation-summary` template (Global authors,
 * SYSTEM is the promoted copy) and the removal of the four orphaned customer templates (§8.1).
 */
import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_PROMPT_TEMPLATES,
  GENERAL_MEDICINE_SUMMARY_TEMPLATES,
  GENERAL_MEDICINE_SUMMARY_VERSIONS,
  GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES,
  SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID,
  TEMPLATE_IDS,
} from '../07-prompt-template';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';

const BARE_REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|[^}]*)?\}\}/g;

describe('TASK-930 — general-medicine-consultation-summary', () => {
  const global = GENERAL_MEDICINE_SUMMARY_TEMPLATES.find((row) => row.tenantId === SEED_TENANT_ID)!;
  const system = GENERAL_MEDICINE_SUMMARY_TEMPLATES.find((row) => row.tenantId === SYSTEM_TENANT_ID)!;

  it('exists once for Global and once for SYSTEM, APPROVED and pinned at v1, with the SYSTEM row tracing to its Global source', () => {
    expect(GENERAL_MEDICINE_SUMMARY_TEMPLATES).toHaveLength(2);
    expect(global.id).toBe(TEMPLATE_IDS.GENERAL_MEDICINE_CONSULTATION_SUMMARY);
    expect(system.id).toBe(SYSTEM_GENERAL_MEDICINE_SUMMARY_TEMPLATE_ID);
    for (const row of [global, system]) {
      expect(row).toMatchObject({ status: 'APPROVED', approvedVersionNumber: 1, currentVersionNumber: 1, category: 'SUMMARY', scope: 'TENANT_DEFAULT', departmentId: null });
      expect(row.tags).toContain('slug:general-medicine-consultation-summary');
    }
    expect(system.sourceTemplateId).toBe(global.id);
    expect(global.sourceTemplateId).toBeNull();
    expect(system.content).toBe(global.content);
    expect(GENERAL_MEDICINE_SUMMARY_VERSIONS.map((version) => [version.promptTemplateId, version.versionNumber, version.tenantId])).toEqual([
      [global.id, 1, SEED_TENANT_ID],
      [system.id, 1, SYSTEM_TENANT_ID],
    ]);
  });

  it('declares every variable its body references, and references every variable it declares (F6)', () => {
    const declared = (global.variables as Array<{ name: string; type: string; required: boolean }>).map((variable) => variable.name);
    expect(declared).toEqual(GENERAL_MEDICINE_SUMMARY_VARIABLE_NAMES);
    // the §8.2 fields …
    for (const name of ['visit_type', 'current_department', 'language', 'safe_age', 'safe_dob', 'safe_gender', 'formatted_previous_visits', 'formatted_vitals', 'chief_complaint']) {
      expect(declared).toContain(name);
    }
    // … and the two document-template heading lists (no document-template binding kind exists on an agent).
    expect(declared).toContain('new_visit_headings');
    expect(declared).toContain('revisit_headings');
    const referenced = new Set([...global.content.matchAll(BARE_REFERENCE)].map((match) => match[1]!));
    expect([...referenced].sort()).toEqual([...declared].sort());
  });

  it('the four orphaned customer templates are gone', () => {
    expect(CUSTOMER_PROMPT_TEMPLATES).toEqual([]);
  });
});
