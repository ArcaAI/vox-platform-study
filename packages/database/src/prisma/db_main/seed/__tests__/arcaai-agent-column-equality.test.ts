/**
 * -T3 (RF-3) — ArcaAI agent bindings === the legacy Department columns.
 *
 * REPLACES `arcaai-zero-department-agents.test.ts`, which asserted the OPPOSITE
 * invariant ("ArcaAI must have ZERO DepartmentAgent rows") and is deleted in this
 * change. That invariant existed only because a DepartmentAgent used to be a
 * single prompt pointer: the resolver's tier-1a consulted `promptTemplateId`
 * regardless of visit type, so giving ArcaAI a default agent would have collapsed
 * v1's new-referral vs follow-up split (F-01). gives the agent a
 * VISIT-TYPE AXIS (`newPatientTemplateId` / `revisitTemplateId`, DR-1), so the
 * right move per RF-3 is to RETIRE the zero-agent invariant rather than guard it:
 * ArcaAI now gets 7 default agents whose per-visit-type bindings point at exactly
 * the same 14 templates the legacy columns point at.
 *
 * This test proves that equality at the ID level, which is what the seed package
 * can see. The RESOLUTION-level equality (same promptId, same versionNumber, same
 * content bytes through `PromptResolutionService.resolve()`, with only
 * `resolvedFrom` flipping 'department' → 'agent') is C2-T2 and lives in
 * packages/applications — the resolver is not importable from here.
 */

import { describe, it, expect } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import { ARCAAI_CLINICAL_DEPARTMENTS } from '../04-department';
import { ARCAAI_TENANT_AGENTS, GOLDEN_AGENTS, GLOBAL_TENANT_AGENTS } from '../07a-agent-golden-library';

const ARCAAI_TENANT_ID = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

describe('ArcaAI DepartmentAgents mirror the legacy Department columns', () => {
  it('seeds exactly one default agent per ArcaAI clinical department', () => {
    expect(ARCAAI_TENANT_AGENTS).toHaveLength(ARCAAI_CLINICAL_DEPARTMENTS.length);
    expect(ARCAAI_TENANT_AGENTS.every((agent) => agent.tenantId === ARCAAI_TENANT_ID)).toBe(true);
    expect(ARCAAI_TENANT_AGENTS.every((agent) => agent.isDefault)).toBe(true);

    const departmentIds = new Set(ARCAAI_TENANT_AGENTS.map((agent) => agent.departmentId));
    expect(departmentIds.size).toBe(ARCAAI_CLINICAL_DEPARTMENTS.length);
  });

  it.each(ARCAAI_CLINICAL_DEPARTMENTS.map((dept) => [dept.code, dept] as const))(
    '%s — newPatientTemplateId and revisitTemplateId equal the department columns',
    (_code, dept) => {
      const agent = ARCAAI_TENANT_AGENTS.find((a) => a.departmentId === dept.id);
      expect(agent, `no ArcaAI agent seeded for department ${dept.code}`).toBeDefined();

      // The 7 × 2 cells. Equality here is what makes the agent tier
      // behaviour-identical to the legacy tier-1b columns it now preempts.
      expect(agent!.newPatientTemplateId).toBe(dept.newPatientPromptId);
      expect(agent!.revisitTemplateId).toBe(dept.revisitPromptId);

      // The NOT-NULL base binding doubles as the within-tier fallback, so it
      // must be a real template — the new-referral one, matching the tier-1a
      // `visitBinding ?? promptTemplateId` read for an unknown visit type.
      expect(agent!.promptTemplateId).toBe(dept.newPatientPromptId);
    },
  );

  it('leaves pre-summary, live, tool and LLM configuration on the platform defaults', () => {
    // RF-3 restores ONLY the summary axis. Pre-summary keeps resolving through
    // the tenant TENANT_DEFAULT row (…024), live keeps the SYSTEM default, and
    // tools/LLM keep platform behaviour — so nothing outside the summary chain
    // changes for ArcaAI in C2.
    for (const agent of ARCAAI_TENANT_AGENTS) {
      expect(agent.preSummaryTemplateId).toBeNull();
      expect(agent.livePromptTemplateId).toBeNull();
      expect(agent.toolConfig).toBeNull();
      expect(agent.llmOverrides).toBeNull();
      // The 14 templates are seeded `approvedVersionNumber: 1`, so the APPROVAL
      // pin IS the governance pin — no admin pin column is needed (DR-1b).
      expect(agent.pinnedVersionNumber).toBeNull();
    }
  });

  it('uses the GOLDEN slugs so the resync sweep is a structural no-op', () => {
    // Rule (i) of AgentTemplateResyncService clones a golden agent into a tenant
    // only when its SLUG is absent there. Matching slugs make the sweep add
    // nothing; rule (iii) then protects these unlocked, tenant-owned rows
    // forever. This closes the "sweep silently re-adds an agent and collapses
    // visit types" hazard STRUCTURALLY rather than with a kill-switch.
    const goldenSlugs = new Set(GOLDEN_AGENTS.map((agent) => agent.slug));
    for (const agent of ARCAAI_TENANT_AGENTS) {
      expect(goldenSlugs.has(agent.slug), `ArcaAI agent slug '${agent.slug}' is not a golden slug`).toBe(true);
    }
  });

  it('is tenant-owned wiring, not a locked golden clone', () => {
    for (const agent of ARCAAI_TENANT_AGENTS) {
      expect(agent.templateLocked).toBe(false);
      expect(agent.sourceAgentTemplateSlug).toBeNull();
      // `goldenSetId` is deliberately not a seed-row field at all — the DB
      // default (null) applies, so no eval corpus is attached and the promotion
      // gate records "proceeded ungated" on approve (existing semantics).
      expect('goldenSetId' in agent).toBe(false);
    }
  });

  it('reuses the retired ArcaAI id block so stale dev rows self-heal on upsert', () => {
    for (const agent of ARCAAI_TENANT_AGENTS) {
      expect(agent.id).toMatch(/^78000000-0000-0000-0001-\d{12}$/);
    }
  });

  it('does not disturb the SYSTEM golden library or the Global clones', () => {
    expect(GOLDEN_AGENTS.some((agent) => agent.tenantId === ARCAAI_TENANT_ID)).toBe(false);
    expect(GLOBAL_TENANT_AGENTS.some((agent) => agent.tenantId === ARCAAI_TENANT_ID)).toBe(false);
  });
});
