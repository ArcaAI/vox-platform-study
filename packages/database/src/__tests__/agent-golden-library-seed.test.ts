/**
 * Agent Golden Library inventory locks.
 *
 * The SYSTEM tenant owns the platform-curated day-1 catalog (departments +
 * default agents + APPROVED prompt templates). Every fixture-tenant agent row
 * is a LOCKED clone with lineage back to a golden agent, exactly the contract
 * `provisionTenantAgentCatalog` / `AgentTemplateResyncService` produce for real
 * tenants. These locks mirror the ASR-pipeline inventory locks in
 * `seed.test.ts` ("SYSTEM catalog has exactly 9 base pipelines…").
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_DEPARTMENTS } from '../prisma/db_main/seed/04-department';
import { DEFAULT_PROMPT_TEMPLATES } from '../prisma/db_main/seed/07-prompt-template';
import {
  GLOBAL_TENANT_AGENTS,
  GOLDEN_AGENTS,
  GOLDEN_DEPARTMENTS,
  GOLDEN_PROMPT_TEMPLATES,
  GOLDEN_PROMPT_VERSIONS,
  GOLDEN_TEMPLATE_SOURCE_BY_CODE,
} from '../prisma/db_main/seed/07a-agent-golden-library';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../prisma/db_main/seed/00-constants';

const fixtureTemplateById = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
const goldenTemplateById = new Map(GOLDEN_PROMPT_TEMPLATES.map((t) => [t.id, t]));
const goldenDepartmentById = new Map(GOLDEN_DEPARTMENTS.map((d) => [d.id, d]));

describe('Agent Golden Library seed', () => {
  describe('SYSTEM golden departments', () => {
    it('promotes the full 18-department catalog to the SYSTEM tenant', () => {
      expect(GOLDEN_DEPARTMENTS).toHaveLength(18);
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

  describe('SYSTEM golden prompt templates', () => {
    it('has exactly 13 APPROVED SYSTEM templates (11 dept-specific + catch-all + cardiology)', () => {
      expect(GOLDEN_PROMPT_TEMPLATES).toHaveLength(13);
      GOLDEN_PROMPT_TEMPLATES.forEach((tpl) => {
        expect(tpl.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(tpl.status).toBe('APPROVED');
        expect(tpl.currentVersionNumber).toBe(1);
      });
    });

    it('every golden template content-matches its fixture source verbatim', () => {
      const sourceIds = new Set(Object.values(GOLDEN_TEMPLATE_SOURCE_BY_CODE));
      expect(sourceIds.size).toBe(GOLDEN_PROMPT_TEMPLATES.length);
      GOLDEN_PROMPT_TEMPLATES.forEach((tpl) => {
        const source = fixtureTemplateById.get(tpl.sourceFixtureTemplateId);
        expect(source).toBeDefined();
        expect(tpl.content).toBe(source?.content);
        expect(tpl.name).toBe(source?.name);
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

  describe('SYSTEM golden agents', () => {
    it('ships exactly one default agent per golden department', () => {
      expect(GOLDEN_AGENTS).toHaveLength(18);
      const deptIds = GOLDEN_AGENTS.map((a) => a.departmentId);
      expect(new Set(deptIds).size).toBe(18);
      GOLDEN_AGENTS.forEach((agent) => {
        expect(agent.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(agent.isDefault).toBe(true);
        const dept = goldenDepartmentById.get(agent.departmentId);
        expect(dept).toBeDefined();
        expect(agent.slug).toBe(`${dept?.code.toLowerCase()}-default`);
      });
    });

    it('golden agents are never locked and carry no lineage (they ARE the templates)', () => {
      GOLDEN_AGENTS.forEach((agent) => {
        expect(agent.templateLocked).toBe(false);
        expect(agent.sourceAgentTemplateSlug).toBeNull();
      });
    });

    it('every golden agent binds the golden template mapped for its department code', () => {
      GOLDEN_AGENTS.forEach((agent) => {
        const dept = goldenDepartmentById.get(agent.departmentId);
        const tpl = goldenTemplateById.get(agent.promptTemplateId);
        expect(tpl).toBeDefined();
        expect(tpl?.sourceFixtureTemplateId).toBe(GOLDEN_TEMPLATE_SOURCE_BY_CODE[dept?.code as keyof typeof GOLDEN_TEMPLATE_SOURCE_BY_CODE]);
      });
    });
  });

  describe('fixture tenants expressed as clones (asAgentTemplateCopies)', () => {
    it('Global tenant gets 18 locked clones with lineage + pristine version stamp', () => {
      expect(GLOBAL_TENANT_AGENTS).toHaveLength(18);
      const goldenSlugs = new Set(GOLDEN_AGENTS.map((a) => a.slug));
      GLOBAL_TENANT_AGENTS.forEach((agent) => {
        expect(agent.tenantId).toBe(SEED_TENANT_ID);
        expect(agent.templateLocked).toBe(true);
        expect(agent.sourceAgentTemplateSlug).toBe(agent.slug);
        expect(goldenSlugs).toContain(agent.slug);
        expect(agent.metaData).toEqual({ sourceTemplateVersionNumber: 1 });
      });
    });

    it('Global-tenant clones bind the tenant-owned fixture template whose content equals the golden source', () => {
      GLOBAL_TENANT_AGENTS.forEach((agent) => {
        const fixtureDept = DEFAULT_DEPARTMENTS.find((d) => d.id === agent.departmentId);
        expect(fixtureDept).toBeDefined();
        const expectedSourceId = GOLDEN_TEMPLATE_SOURCE_BY_CODE[fixtureDept?.code as keyof typeof GOLDEN_TEMPLATE_SOURCE_BY_CODE];
        expect(agent.promptTemplateId).toBe(expectedSourceId);
      });
    });

    // The ArcaAI fixture tenant no longer receives
    // seeded default agents (its clinical departments resolve via the
    // visit-type-faithful legacy prompt-id columns), so the golden library only
    // clones into the Global fixture tenant now.

    it('every seeded tenant keeps exactly one default agent per department', () => {
      const all = [...GOLDEN_AGENTS, ...GLOBAL_TENANT_AGENTS];
      const defaultsByDept = new Map<string, number>();
      all.forEach((agent) => {
        if (!agent.isDefault) return;
        const key = `${agent.tenantId}::${agent.departmentId}`;
        defaultsByDept.set(key, (defaultsByDept.get(key) ?? 0) + 1);
      });
      // Every department that has agents has exactly one default.
      const deptKeys = new Set(all.map((a) => `${a.tenantId}::${a.departmentId}`));
      expect(defaultsByDept.size).toBe(deptKeys.size);
      for (const count of defaultsByDept.values()) {
        expect(count).toBe(1);
      }
    });

    it('agent ids are unique and use the reserved 78… block', () => {
      const all = [...GOLDEN_AGENTS, ...GLOBAL_TENANT_AGENTS];
      const ids = all.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id) => expect(id.startsWith('78000000-')).toBe(true));
    });
  });
});
