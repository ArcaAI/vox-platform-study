/**
 * TASK-635 Lane D3 — conformance regression suite (COMPAT / API layer).
 *
 * Locks the §2.0 conformance scorecard of
 * `docs/implementation/TASK-635-Summarization-Agent-Conformance/README.md`
 * as executable checks. Each `describe`/`it` is named after the requirement it
 * locks so a failure names the broken contract, not just the broken code.
 *
 * Scope of THIS file: the v1-compat surface (`apps/api/src/modules/smr-compat`).
 * Sibling (main) file — everything NOT compat-controller-specific (R-T1/R-T2
 * DTO contract, F-01 closure complement, R-C3(i) at the resolver level, RF-2,
 * B-12):
 *   packages/applications/src/services/consultation/prompt/__tests__/task-635-conformance.test.ts
 *
 * | Requirement | Scorecard row | Covered here |
 * |---|---|---|
 * | R-C1 | "no live summarization loop on compat" | route inventory (§1) |
 * | R-C2 | "agent by department AND visit type; tenant-admin LLM" | §2 |
 * | R-C3 (i) | "pre-summary resolution ignores department" | §3 |
 * | R-C3 (ii) | NON-CONFORMING BY DESIGN until Lane D2 | §4 — characterization |
 *
 * DELIBERATELY NOT DUPLICATED (asserted elsewhere; referenced so a reader can
 * find the lock rather than re-adding it here):
 *   - agent-tier vs legacy-column resolution equality for the 7 ArcaAI
 *     departments × 2 visit types →
 *     `packages/database/.../seed/__tests__/arcaai-agent-column-equality.test.ts`
 *   - "an agent with ALL-NULL capability bindings resolves its base
 *     `promptTemplateId`" (the pre-C2 behaviour) → C2-T7 in
 *     `packages/applications/.../prompt/__tests__/prompt-resolution.capability-bindings.test.ts`
 *   - RF-5 resolver-side ineligibility of the agent tier without a
 *     `departmentId` → same file, "is INELIGIBLE without a departmentId".
 *     §3 below locks the COMPLEMENTARY property: the compat CALL PATH is the
 *     one that supplies no department.
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_DEFAULTS } from '@arcaai/applications';

import { SmrCompatController } from '../smr-compat.controller';
import { SmrCompatTemplateService } from '../smr-compat-template.service';
// `PRE_SUMMARY_TEMPLATE_VARIABLES` originates in `@arcaai/applications` and is
// re-exported by the builder; importing it from there keeps this file on the
// same module the compat path itself consumes.
import {
  PRE_SUMMARY_TEMPLATE_VARIABLES,
  renderPreSummaryTemplate,
  V1_PRE_SUMMARY_SYSTEM_PROMPT,
  V1_PRE_SUMMARY_TEMPLATE,
} from '../summary-prompt.builder';
import { PRE_SUMMARY_DISPLAY_TITLES } from '../summary-response.mapper';

// ---------------------------------------------------------------------------
// §1 — R-C1: the compat surface carries NO live/streaming summarization route
// ---------------------------------------------------------------------------

/**
 * Structural (metadata) assertion rather than a source-text grep: Nest's route
 * table IS the wire contract, so reading `PATH_METADATA`/`METHOD_METADATA`/
 * `SSE_METADATA` off the controller prototype asserts exactly what the HTTP
 * surface exposes. A source-level regex would pass on a route declared through
 * a helper and fail on a comment — the metadata cannot lie.
 */
const routeInventory = (proto: object): { name: string; path: string; method: string; sse: boolean }[] => {
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (proto as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return null;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) return null;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      return {
        name,
        path,
        method: RequestMethod[method ?? RequestMethod.GET],
        sse: Reflect.getMetadata(SSE_METADATA, handler) === true,
      };
    })
    .filter((r): r is { name: string; path: string; method: string; sse: boolean } => r !== null);
};

describe('R-C1 — the compat surface exposes no live-summarization route', () => {
  const routes = routeInventory(SmrCompatController.prototype);

  it('exposes EXACTLY the two v1 generation routes (POST summary/sync, POST presummary)', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['POST presummary', 'POST summary/sync']);
  });

  it('declares no @Sse() route — there is no live-summary subscription to attach to', () => {
    // NOTE: `stream: true` on the two POST routes is a token stream of the SAME
    // stop-recording generation (SSE deltas of one summary), NOT a recording-time
    // live-summarization loop. R-C1 forbids the latter; the assertion below is
    // about a *subscription* surface, which is what a live loop would need.
    expect(routes.filter((r) => r.sse)).toEqual([]);
  });

  it('declares no route whose path suggests a live/realtime summarization loop', () => {
    const suspicious = routes.filter((r) => /live|realtime|running|stream-summary|summary\/stream/i.test(r.path));
    expect(suspicious).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2 — R-C2: department AND visit-type aware; tenant-admin LLM default honored
// ---------------------------------------------------------------------------

const createTemplateService = (overrides?: {
  departments?: { id: string; name: string; code?: string | null }[];
  resolve?: ReturnType<typeof vi.fn>;
}) => {
  const departmentRepository = {
    findAllByTenant: vi.fn(async () => overrides?.departments ?? [{ id: 'dept-cardio', name: 'Cardiology', code: 'CARD' }]),
  };
  const promptResolutionService = {
    resolve:
      overrides?.resolve ??
      vi.fn(async () => ({ promptId: 'tpl-bound', resolvedFrom: 'agent', content: 'GOVERNED BODY', trace: {} })),
  };
  const service = new SmrCompatTemplateService(
    departmentRepository as never,
    promptResolutionService as never,
  );
  return { service, departmentRepository, promptResolutionService };
};

describe('R-C2 — compat summary activation is department AND visit-type aware', () => {
  it('maps v1 visit types onto the resolver visit-type buckets', () => {
    const { service } = createTemplateService();
    for (const newPatient of ['New referral', 'new', 'First visit', undefined, '']) {
      expect(service.toSummaryPromptType(newPatient)).toBe('new-patient');
    }
    for (const revisit of ['Follow-up', 'followup', 'Review', 'Revisit']) {
      expect(service.toSummaryPromptType(revisit)).toBe('revisit');
    }
  });

  it.each([
    ['New referral', 'new-patient'],
    ['Follow-up', 'revisit'],
  ])('a department + %s visit resolves the department-bound template as promptType %s', async (visitType, expectedPromptType) => {
    const { service, promptResolutionService } = createTemplateService();

    const content = await service.resolveGovernedInstruction('tenant-1', 'Cardiology', service.toSummaryPromptType(visitType));

    expect(content).toBe('GOVERNED BODY');
    expect(promptResolutionService.resolve).toHaveBeenCalledWith({ departmentId: 'dept-cardio', promptType: expectedPromptType });
  });

  it('the two visit types are routed to DIFFERENT resolver calls (no visit-type collapse — F-01)', async () => {
    const { service, promptResolutionService } = createTemplateService();
    await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'new-patient');
    await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'revisit');

    const promptTypes = promptResolutionService.resolve.mock.calls.map((c) => (c[0] as { promptType: string }).promptType);
    expect(promptTypes).toEqual(['new-patient', 'revisit']);
  });
});

describe('R-C2 — the LLM is the default set by the tenant admin', () => {
  /**
   * The conformance property is the SELECTION SEAM, not the HTTP round trip
   * (which `smr-compat.controller.test.ts` already exercises end-to-end):
   * compat must ask the tenant-scoped policy resolver with an EXPLICIT tenant id
   * — never let it re-derive one from ambient CLS (B-04's failure mode, the
   * "silent SYSTEM default" leak) — and must route on the finalize task.
   */
  let harnessPolicyService: {
    resolveSmrSelection: ReturnType<typeof vi.fn>;
    resolveSmrFallbackSelection: ReturnType<typeof vi.fn>;
  };
  let controller: SmrCompatController;

  beforeEach(() => {
    harnessPolicyService = {
      resolveSmrSelection: vi.fn(async () => ({ provider: 'lm-studio', model: 'tenant-default-model' })),
      resolveSmrFallbackSelection: vi.fn(async () => null),
    };
    controller = new SmrCompatController(
      { axiosRef: { post: vi.fn(), get: vi.fn() } } as never,
      { getConfigValue: vi.fn(() => 'http://localhost:8862') } as never,
      { get: vi.fn(() => undefined), getId: vi.fn(() => 'req-1') } as never,
      harnessPolicyService as never,
      { toSummaryPromptType: vi.fn(() => 'new-patient'), resolveGovernedInstruction: vi.fn(async () => undefined) } as never,
    );
  });

  it('resolves the model through the tenant-scoped policy with an EXPLICIT tenant id', async () => {
    const request: { provider?: string; model?: string } = {};
    // `applySmrModelSelection` is the single seam every compat generation path
    // funnels through (summary sync/stream, pre-summary sync/stream).
    await (controller as unknown as { applySmrModelSelection: (r: object, t: string) => Promise<void> }).applySmrModelSelection(
      request,
      'tenant-1',
    );

    expect(harnessPolicyService.resolveSmrSelection).toHaveBeenCalledTimes(1);
    const [tenantArg, taskArg] = harnessPolicyService.resolveSmrSelection.mock.calls[0];
    expect(tenantArg).toBe('tenant-1');
    // `HarnessPolicyService.resolveSmrSelection(tenantId?, task: SmrRoutingTask = 'finalize')`
    // — compat relies on the default, so either spelling is conformant. What is
    // NOT conformant is 'live' or 'test'.
    expect(taskArg === undefined || taskArg === 'finalize').toBe(true);
    expect(request.model).toBe('tenant-default-model');
  });

  it('never resolves the model without a tenant (no SYSTEM-default leak)', () => {
    // `requireTenantId` is the guard; with no CLS tenant, no api key and no user
    // it must reject rather than let the policy resolver fall back to SYSTEM.
    expect(() => (controller as unknown as { requireTenantId: (r?: object) => string }).requireTenantId(undefined)).toThrow();
    expect(harnessPolicyService.resolveSmrSelection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — R-C3 (i): pre-summary resolution ignores department (RF-5)
// ---------------------------------------------------------------------------

describe('R-C3 (i) — the compat pre-summary call path supplies no department', () => {
  it('asks the resolver for the tenant pre-summary WITHOUT a departmentId, even when the request carries a department name', async () => {
    const { service, departmentRepository, promptResolutionService } = createTemplateService({
      resolve: vi.fn(async () => ({ promptId: 'tpl-presummary', resolvedFrom: 'tenant', content: 'PRE-SUMMARY BODY', trace: {} })),
    });

    const content = await service.resolveGovernedInstruction('tenant-1', 'Cardiology', 'pre-summary');

    expect(content).toBe('PRE-SUMMARY BODY');
    // The department name is present in the request and deliberately ignored:
    // no department matching happens at all.
    expect(departmentRepository.findAllByTenant).not.toHaveBeenCalled();

    const params = promptResolutionService.resolve.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual({ tenantId: 'tenant-1', promptType: 'pre-summary' });
    // Explicit: not merely undefined — the key is absent, which is what makes
    // the agent tier (RF-5, signature-derived eligibility) unreachable.
    expect(Object.keys(params)).not.toContain('departmentId');
    // Nor does compat opt into the department-free template family (D2): it
    // takes the default `preSummaryVariant: 'v1'`, per RF-1's wire contract.
    expect(Object.keys(params)).not.toContain('preSummaryVariant');
  });

  it('resolves identically when the request carries NO department at all', async () => {
    const { service, promptResolutionService } = createTemplateService({
      resolve: vi.fn(async () => ({ promptId: 'tpl-presummary', resolvedFrom: 'tenant', content: 'PRE-SUMMARY BODY', trace: {} })),
    });

    await service.resolveGovernedInstruction('tenant-1', undefined, 'pre-summary');

    expect(promptResolutionService.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', promptType: 'pre-summary' });
  });
});

// ---------------------------------------------------------------------------
// §4 — R-C3 (ii): CHARACTERIZATION — non-conforming by design (until D2)
// ---------------------------------------------------------------------------

describe('R-C3 (ii) — CHARACTERIZATION: the compat pre-summary BODY still carries department/visit-type', () => {
  /**
   * This block documents today's DELIBERATE non-conformance and must FAIL LOUDLY
   * if anyone "fixes" it by stripping the placeholders from the compat path.
   *
   * Per OD-1(b) + RF-1 the fix is a NATIVE-ONLY dept-free FORK (Lane D2, a new
   * template id + its own SYSTEM default); compat KEEPS the v1 body because the
   * wire contract binds it: `summary-response.mapper.ts` title-matches the five
   * v1 FORMAT headings, three of which literally read "(Latest Dept Note)".
   * Renaming or removing them returns `structured_data.sections: []` to every
   * v1 client. The TASK-634 byte-exact fidelity checksum gate locks the same
   * bytes from the seed side.
   *
   * When D2 lands, R-C3 flips to CONFORMING for the NATIVE surface only; this
   * block stays green unchanged (see the PENDING list at the bottom of the file).
   */
  it('the v1 template interpolates {current_department} and {visit_type}', () => {
    expect(V1_PRE_SUMMARY_TEMPLATE).toContain('- **Department:** {current_department}');
    expect(V1_PRE_SUMMARY_TEMPLATE).toContain('- **Visit Type:** {visit_type}');
    expect(V1_PRE_SUMMARY_TEMPLATE).toContain('- Notes from {current_department}');
    expect(PRE_SUMMARY_TEMPLATE_VARIABLES).toEqual(expect.arrayContaining(['current_department', 'visit_type']));
  });

  it("the system prompt still describes the capability as 'department-aware'", () => {
    expect(V1_PRE_SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('department-aware');
  });

  it("substitutes 'General' / 'Medical examination' when the request omits both — the LLM ALWAYS receives a department", () => {
    const rendered = renderPreSummaryTemplate(V1_PRE_SUMMARY_TEMPLATE, {} as never);

    expect(rendered).toContain('- **Department:** General');
    expect(rendered).toContain('- **Visit Type:** Medical examination');
    // No un-substituted single-brace placeholder may reach the LLM.
    expect(rendered).not.toContain('{current_department}');
    expect(rendered).not.toContain('{visit_type}');
  });

  it('WIRE CONTRACT (RF-1): the mapper title-matches three "(Latest Department Note)" headings that the template emits verbatim', () => {
    const deptNoteTitles = PRE_SUMMARY_DISPLAY_TITLES.filter((t) => t.includes('(Latest Department Note)'));
    expect(deptNoteTitles).toHaveLength(3);
    for (const title of PRE_SUMMARY_DISPLAY_TITLES) {
      expect(V1_PRE_SUMMARY_TEMPLATE).toContain(`- ${title}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// §5 — R-C3 (ii) flip: the NATIVE surface now conforms; compat (§4) is unchanged
// ---------------------------------------------------------------------------

describe('R-C3 (ii) flip — the NATIVE dept-free fork is a DISTINCT pointer from the v1 compat default (D2)', () => {
  /**
   * RF-1's wire contract, proven from the compat side: compat's resolver call
   * (§3 above) never carries `preSummaryVariant`, so it always defaults to
   * `'v1'` and can only ever reach `SYSTEM_DEFAULTS.preSummaryPromptId` — the
   * SAME body §4 characterizes as still carrying `{current_department}` /
   * `{visit_type}`. The dept-free fork D2 seeds
   * (`packages/database/.../07d-dept-free-pre-summary-default.ts`, locked by
   * its own checksum test and by
   * `packages/applications/.../task-635-conformance.test.ts`'s
   * "targets SYSTEM_DEFAULTS.deptFreePreSummaryPromptId" case) lives at a
   * DIFFERENT id, so compat is structurally unable to reach it even by
   * accident.
   */
  it('SYSTEM_DEFAULTS carries two DISTINCT pre-summary pointers: the v1 default (compat-reachable) and the dept-free fork (native-only)', () => {
    expect(SYSTEM_DEFAULTS.preSummaryPromptId).not.toBe(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId);
    expect(typeof SYSTEM_DEFAULTS.deptFreePreSummaryPromptId).toBe('string');
    expect(SYSTEM_DEFAULTS.deptFreePreSummaryPromptId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PENDING — assertions to add when C3 / C5 land
// ---------------------------------------------------------------------------
//
// * R-N1 (live agent configurability) — after C3: assert the live SSE
//   `LiveSummaryEventDto.metadata.agent` block is present and carries
//   `{ id, name, versionId }`, and that the live system prompt comes from the
//   governed SYSTEM live-default template rather than the in-code constant.
//   Cannot be written today: the `'live'` promptType and the live chain are
//   C3's in-flight change (this file must not depend on them).
// * R-N2 (same-agent lineage) — after C5: assert the agent id/version stamped on
//   the `LIVE_SOAP_SNAPSHOT` metaData is the one `SummaryService` pins at
//   finalize, and that `SummaryMeta.sessionAgentId` records it.
