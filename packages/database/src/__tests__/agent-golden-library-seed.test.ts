/**
 * Golden Prompt Library inventory locks.
 *
 * The SYSTEM tenant owns the platform-curated day-1 catalog: departments +
 * APPROVED prompt templates + their v1 version snapshots. These locks mirror the
 * ASR-pipeline inventory locks in `seed.test.ts` ("SYSTEM catalog has exactly 9
 * base pipelines…").
 *
 * The suite used to carry two more sections — golden `DepartmentAgent` rows and
 * the locked clone set the fixture tenants got from them. Both went with
 * `DepartmentAgent`; a prompt template's binding to a workflow lives
 * on the NODE that references it now, so there is no per-department agent row to
 * lock an inventory on.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_DEPARTMENTS } from '../prisma/db_main/seed/04-department';
import { DEFAULT_PROMPT_TEMPLATES } from '../prisma/db_main/seed/07-prompt-template';
import {
  GOLDEN_DEPARTMENTS,
  GOLDEN_PROMPT_TEMPLATES,
  GOLDEN_PROMPT_VERSIONS,
  GOLDEN_TEMPLATE_SOURCE_BY_CODE,
} from '../prisma/db_main/seed/07a-agent-golden-library';
import { SYSTEM_TENANT_ID } from '../prisma/db_main/seed/00-constants';

const fixtureTemplateById = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
const goldenTemplateById = new Map(GOLDEN_PROMPT_TEMPLATES.map((t) => [t.id, t]));
const goldenDepartmentById = new Map(GOLDEN_DEPARTMENTS.map((d) => [d.id, d]));

describe('Agent Golden Library seed', () => {
  describe('SYSTEM golden departments', () => {
    it('promotes the full 8-department care-setting catalog to the SYSTEM tenant', () => {
      // Eight CARE SETTINGS, not a specialty roster. The count
      // is pinned deliberately: this array is cloned into every newly-provisioned
      // tenant, so growing it silently hands every future customer more
      // departments than they asked for.
      expect(GOLDEN_DEPARTMENTS).toHaveLength(8);
      expect(GOLDEN_DEPARTMENTS.map((d) => d.code).sort()).toEqual(['BEH', 'ER', 'IPD', 'LAB', 'OPD', 'PEDS', 'PERI', 'RAD']);
      expect(GOLDEN_DEPARTMENTS.map((d) => d.code).sort()).toEqual(DEFAULT_DEPARTMENTS.map((d) => d.code).sort());
      GOLDEN_DEPARTMENTS.forEach((dept) => {
        expect(dept.tenantId).toBe(SYSTEM_TENANT_ID);
        // Legacy prompt pointers reference tenant-owned templates — the
        // golden rows carry the agent binding instead.
        expect(dept.preSummaryPromptId).toBeNull();
        expect(dept.newPatientPromptId).toBeNull();
        expect(dept.revisitPromptId).toBeNull();
      });
    });

    it('carries the fixture promptConfig forward per code', () => {
      for (const dept of GOLDEN_DEPARTMENTS) {
        const fixture = DEFAULT_DEPARTMENTS.find((d) => d.code === dept.code);
        expect(fixture).toBeDefined();
        expect(dept.promptConfig).toEqual(fixture?.promptConfig);
        expect(dept.defaultSummaryTemplate).toBe(fixture?.defaultSummaryTemplate);
      }
    });
  });

  describe('the golden catalog stays platform-generic', () => {
    // The regression this whole change exists to prevent: the golden library IS
    // what every new tenant is provisioned with, so a specialty code leaking back
    // into it re-ships one hospital's roster as the platform default.
    const ARCAAI_SPECIALTY_CODES = ['GEN', 'MED', 'SURG', 'NEUR', 'ORTH', 'DERM', 'BREN', 'RHEUM', 'HEME', 'DIET', 'NEPH', 'SONC'];

    it('contains none of the ArcaAI/BCMCH specialty department codes', () => {
      const codes = new Set(GOLDEN_DEPARTMENTS.map((d) => d.code));
      const leaked = ARCAAI_SPECIALTY_CODES.filter((c) => codes.has(c));
      expect(leaked, `specialty codes leaked into the golden catalog: ${leaked.join(', ')}`).toEqual([]);
    });

    it('carries no BCMCH house section vocabulary in any promptConfig', () => {
      // These strings are BCMCH v1 artifacts, not general clinical convention.
      const HOUSE_VOCAB = ['BIODATA', 'Fitness for Surgery', 'MDT Plan', 'style_DNA_doctor_department_'];
      for (const dept of GOLDEN_DEPARTMENTS) {
        const blob = JSON.stringify(dept.promptConfig ?? {});
        for (const token of HOUSE_VOCAB) {
          expect(blob, `${dept.code} promptConfig carries BCMCH vocabulary '${token}'`).not.toContain(token);
        }
      }
    });
  });

  describe('SYSTEM golden prompt templates', () => {
    it('has exactly 8 APPROVED SYSTEM templates — one generic body per care setting', () => {
      // One golden template per golden department: GOLDEN_TEMPLATE_SOURCE_BY_CODE
      // maps each care setting to its own NEW-encounter generic body, so unlike
      // the retired specialty catalog (where six departments shared a catch-all)
      // there is no deduplication and the counts match exactly.
      expect(GOLDEN_PROMPT_TEMPLATES).toHaveLength(8);
      GOLDEN_PROMPT_TEMPLATES.forEach((tpl) => {
        expect(tpl.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(tpl.status).toBe('APPROVED');
        expect(tpl.currentVersionNumber).toBe(1);
      });
    });

    // TASK-890 J7-1: there is nothing to content-match any more. The golden set
    // used to be a byte COPY of the Global-tenant fixture rows under fresh ids,
    // so "does the copy still match its source" was a real question. Those eight
    // bodies are now authored on SYSTEM in `07-prompt-template.ts` and this
    // export is a VIEW over them — identity, not a copy — which is exactly what
    // this asserts instead.
    it('IS the seeded SYSTEM rows rather than a second copy of them', () => {
      const sourceIds = new Set(Object.values(GOLDEN_TEMPLATE_SOURCE_BY_CODE));
      expect(sourceIds.size).toBe(GOLDEN_PROMPT_TEMPLATES.length);
      GOLDEN_PROMPT_TEMPLATES.forEach((tpl) => {
        expect(sourceIds.has(tpl.id), `${tpl.name} is not one of the mapped source templates`).toBe(true);
        expect(fixtureTemplateById.get(tpl.id), `${tpl.name} is not a seeded template`).toBe(tpl);
      });
    });

    it('writes one v1 PromptVersion snapshot per golden template', () => {
      expect(GOLDEN_PROMPT_VERSIONS).toHaveLength(GOLDEN_PROMPT_TEMPLATES.length);
      GOLDEN_PROMPT_VERSIONS.forEach((version) => {
        expect(version.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(version.versionNumber).toBe(1);
        const tpl = goldenTemplateById.get(version.promptTemplateId);
        expect(tpl).toBeDefined();
        expect(version.content).toBe(tpl?.content);
      });
    });
  });
});
