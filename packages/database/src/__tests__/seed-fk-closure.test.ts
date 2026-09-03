/**
 * Whole-graph referential closure for the seed.
 *
 * `PromptTemplate.departmentId` and the DepartmentAgent bindings are REAL
 * Postgres foreign keys (prompt-template.prisma), so a seed row that names an id
 * nothing else defines is a failed migration, not a stale reference. The
 * per-file seed tests each check their own slice; this one walks the three
 * catalogs together (Global generic + ArcaAI clinical + SYSTEM golden) and
 * proves every cross-reference in the graph resolves.
 *
 * Added with, which retired 18 departments and 22 templates and
 * re-homed three more — exactly the change shape that leaves dangling FKs
 * behind, and the one where four hardcoded literals slipped past both `tsc` and
 * the per-file tests because they carried the id as a raw string.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEPARTMENTS, ARCAAI_ALL_CLINICAL_DEPARTMENTS } from '../prisma/db_main/seed/04-department';
import { DEFAULT_PROMPT_TEMPLATES, DEFAULT_PROMPT_VERSIONS } from '../prisma/db_main/seed/07-prompt-template';
import { GOLDEN_DEPARTMENTS, GOLDEN_PROMPT_TEMPLATES } from '../prisma/db_main/seed/07a-agent-golden-library';
import { ARCAAI_CLINICAL_TEMPLATES } from '../prisma/db_main/seed/07b-arcaai-clinical-templates';

describe('seed FK closure (whole graph)', () => {
  const deptIds = new Set([...DEFAULT_DEPARTMENTS, ...ARCAAI_ALL_CLINICAL_DEPARTMENTS, ...GOLDEN_DEPARTMENTS].map((d) => d.id));
  const tplIds = new Set([...DEFAULT_PROMPT_TEMPLATES, ...GOLDEN_PROMPT_TEMPLATES, ...ARCAAI_CLINICAL_TEMPLATES].map((t: any) => t.id));

  it('every template.departmentId resolves', () => {
    for (const t of [...DEFAULT_PROMPT_TEMPLATES, ...GOLDEN_PROMPT_TEMPLATES, ...ARCAAI_CLINICAL_TEMPLATES] as any[]) {
      if (t.departmentId) expect(deptIds.has(t.departmentId), `${t.name} -> ${t.departmentId}`).toBe(true);
    }
  });
  it('every department prompt column resolves', () => {
    for (const d of [...DEFAULT_DEPARTMENTS, ...ARCAAI_ALL_CLINICAL_DEPARTMENTS, ...GOLDEN_DEPARTMENTS] as any[]) {
      for (const col of ['preSummaryPromptId', 'newPatientPromptId', 'revisitPromptId']) {
        if (d[col]) expect(tplIds.has(d[col]), `${d.code}.${col} -> ${d[col]}`).toBe(true);
      }
    }
  });
  it('no version row has an undefined id and every one points at a real template', () => {
    for (const v of DEFAULT_PROMPT_VERSIONS as any[]) {
      expect(v.id, `version for ${v.promptTemplateId} has no id`).toBeTruthy();
      expect(tplIds.has(v.promptTemplateId)).toBe(true);
    }
    const ids = DEFAULT_PROMPT_VERSIONS.map((v: any) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('department ids and codes are unique per tenant', () => {
    const seen = new Set<string>();
    for (const d of [...DEFAULT_DEPARTMENTS, ...ARCAAI_ALL_CLINICAL_DEPARTMENTS, ...GOLDEN_DEPARTMENTS] as any[]) {
      const key = `${d.tenantId}::${d.code}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
    const allIds = [...DEFAULT_DEPARTMENTS, ...ARCAAI_ALL_CLINICAL_DEPARTMENTS, ...GOLDEN_DEPARTMENTS].map((d) => d.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
