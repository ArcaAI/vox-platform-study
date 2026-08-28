/**
 * Conformance regression suite (APPLICATIONS layer).
 *
 * Locks the conformance scorecard of
 * `docs/implementation/TASK-635-Summarization-Agent-Conformance/README.md`.
 * Sibling file (COMPAT / API layer — R-C1/R-C2/R-C3):
 *   apps/api/src/modules/text-compat/__tests__/task-635-conformance.test.ts
 *
 * | Requirement | Scorecard row | Covered here |
 * |---|---|---|
 * | R-T1 | "tenant admin can test any prompt template with predefined OR given example data" | |
 * | R-T2 | "tenant admin can select the LLM provider for the test run" | |
 *
 * F-01 / R-C3(i) / RF-2 / B-12 (resolver-level) are locked in the SAME
 * directory's `prompt-resolution.capability-bindings.test.ts` (C2's own suite,
 * already RED→GREEN per evidence table) — referenced rather than
 * duplicated:
 *   - F-01 closure complement ("an agent with ALL-NULL bindings resolves
 *     exactly as pre-C2") → describe('C2-T7 — an agent with NULL visit
 *     bindings resolves its base template (DR-1a)')
 *   - R-C3(i) (pre-summary chain never consults the agent tier without a
 *     departmentId) → it('is INELIGIBLE without a departmentId — the compat
 *     signature can never reach it (RF-5)')
 *   - RF-2 (per-(tenant, surface-tag) single candidate query shape) →
 *     describe('RF-2 — the tenant tier filters by surface tag')
 *   - B-12 closure (SYSTEM pre-summary default resolvable for a tenant that
 *     owns no row of its own) → it('falls back to the SYSTEM v1 default
 *     (…040) when the tenant has no row, instead of 503 (B-12)')
 *   The DB-side half of B-12 (PromptTemplate/PromptVersion actually being in
 *   `SYSTEM_SHARED_READ_MODELS`, i.e. the Prisma extension really widens the
 *   read) is `packages/database/src/extensions/__tests__/tenant-scope.test.ts`
 *   — this service's mocks bypass the Prisma extension entirely, so a
 *   resolver-level test alone cannot prove that half.
 *
 * DELIBERATELY NOT DUPLICATED — Wave 1 (Lane B) already locks the BEHAVIOUR;
 * this file locks only the DTO CONTRACT SURFACE, which is the cheap thing that
 * silently regresses (the global pipe runs `whitelist + forbidNonWhitelisted`,
 * so a field that loses its class-validator decorator is not merely
 * undocumented — it is STRIPPED from every request, and the capability
 * silently reverts to its previous behaviour with no test failing):
 *   - per-field validation semantics (types, ranges, UUID) →
 *     `prompt-management/__tests__/test-prompt-template.request.test.ts`
 *   - caller-supplied provider/model forwarded verbatim + the
 *     `text.test` → `text.finalize` cascade → `prompt-management/__tests__/text-test-routing.test.ts`
 *   - dry-run persistence/OCC neutrality, `versionNumber` snapshot targeting,
 *     `goldenCaseId` XOR/404 → `prompt-management/__tests__/prompt-management.service.test.ts`
 *     and the e2e spec `apps/api/tests/e2e/task-635-prompt-test-bench.spec.ts`
 */

import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';

import { TestPromptTemplateRequest } from '../../../prompt-management/dto/test-prompt-template.request';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

/** Every property of the DTO that class-validator will actually validate. */
const validatedProperties = (target: object): Set<string> =>
  new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(target as never, '', false, false)
      .map((m) => m.propertyName),
  );

describe('R-T1 / R-T2 — the prompt-template test route accepts the full test-bench contract', () => {
  const properties = validatedProperties(TestPromptTemplateRequest);

  it.each([
    ['provider', 'R-T2 — caller-selected LLM provider'],
    ['model', 'R-T2 — caller-selected LLM model'],
    ['dryRun', 'R-T1/B-11 — test without mutating the template under OCC'],
    ['versionNumber', 'R-T1/B-11 — test an immutable PromptVersion, not the mutable draft'],
    ['goldenCaseId', 'R-T1 — PREDEFINED example data (golden case)'],
    ['sampleInput', 'R-T1 — GIVEN example data (pasted sample)'],
    ['variables', 'R-T1 — template variable values for the run'],
  ])('declares a validated `%s` field (%s)', (field) => {
    // A field that loses its class-validator decoration is stripped by the
    // global `whitelist + forbidNonWhitelisted` pipe — this is a wire-contract
    // assertion, not a style check.
    expect(properties.has(field)).toBe(true);
  });

  it('keeps the OCC predicate (`expectedVersion`) on the DTO', () => {
    expect(properties.has('expectedVersion')).toBe(true);
  });

  it('adds no undeclared field beyond the documented test-bench contract', () => {
    expect([...properties].sort()).toEqual(
      ['dryRun', 'expectedVersion', 'goldenCaseId', 'model', 'provider', 'sampleInput', 'variables', 'versionNumber'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// R-C3 (ii) flip: `preSummaryVariant: 'dept-free'` resolves the D2 fork
// ---------------------------------------------------------------------------

describe("R-C3 (ii) flip — preSummaryVariant: 'dept-free' resolves the seeded SYSTEM fork (D2)", () => {
  const mockDepartmentRepository = { findById: vi.fn() };
  const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
  const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

  // A stand-in for the D2 fork's actual seeded body — this file asserts the
  // RESOLUTION MECHANISM (which id/tier the variant targets), not the fork's
  // literal bytes: the content itself is authored + sha256-locked in
  // `packages/database` (`07d-dept-free-pre-summary-default.ts` +
  // `system-dept-free-pre-summary-default-checksum.test.ts`), which this
  // package does not import (dependency direction: applications → database is
  // client/type-only, not seed source).
  const DEPT_FREE_STAND_IN_BODY = '## Pre-Summary\n\n- Demographics: {safe_age}\n- FORMAT: Investigations (Latest Note):';

  function makeService() {
    vi.clearAllMocks();
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
      id,
      status: [SYSTEM_DEFAULTS.deptFreePreSummaryPromptId, SYSTEM_DEFAULTS.preSummaryPromptId].includes(id) ? 'APPROVED' : 'DRAFT',
      approvedVersionNumber: 1,
    }));
    mockPromptTemplateRepository.findAll.mockResolvedValue([]);
    mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
      content: templateId === SYSTEM_DEFAULTS.deptFreePreSummaryPromptId ? DEPT_FREE_STAND_IN_BODY : `content-of-${templateId}`,
      versionNumber,
    }));

    // TASK-815: no tier-1a resolvers are wired here on purpose — this suite is
    // about the pre-summary SYSTEM defaults, which the node tier never touches.
    return new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
    );
  }

  it("targets SYSTEM_DEFAULTS.deptFreePreSummaryPromptId when preSummaryVariant is 'dept-free'", async () => {
    const service = makeService();

    const result = await service.resolve({ tenantId: 'tenant-no-own-row', promptType: 'pre-summary', preSummaryVariant: 'dept-free' });

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId);
    expect(result.promptId).not.toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
    expect(result.content).toContain('(Latest Note)');
    expect(result.content).not.toContain('{current_department}');
    expect(result.content).not.toContain('{visit_type}');
  });

  it("defaults to the v1 SYSTEM default (…040) when preSummaryVariant is omitted (RF-1 default)", async () => {
    const service = makeService();

    const result = await service.resolve({ tenantId: 'tenant-no-own-row', promptType: 'pre-summary' });

    expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
    expect(result.promptId).not.toBe(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId);
  });
});

// ---------------------------------------------------------------------------
// PENDING — assertions to add when C3 / C5 land
// ---------------------------------------------------------------------------
//
// * R-N1 (live agent configurability) — after C3: assert
//   `PromptResolutionParams.promptType` admits `'live'` and that the live chain
//   is agent `livePromptTemplateId` → SYSTEM live-default → in-code constant
//   (the documented fail-open exception). Not writable today: the union
//   widening and the live chain are C3's in-flight change.
// * R-N2 (same-agent lineage) — after C5: assert `resolve({ pinnedAgentId })`
//   pins the summary chain to the session's live agent, outranking a changed
//   department default (tier-0 doctor-preferred still wins, per DR-2).
