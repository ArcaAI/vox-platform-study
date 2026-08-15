/**
 * Agentic policy governance (Phase 7 E2E, Agentic SOTA).
 *
 * Probes the agentic policy control plane across three real gateway surfaces,
 * following the governance/OCC pattern:
 *
 *  A. HarnessPolicy loop-knob writes — `PATCH /api/v1/admin/harness/policy`
 *     (`HarnessAdminController.updatePolicy`, `@RequiresIfMatch()`):
 *       - missing `If-Match` → 428; stale `If-Match: "999"` → 412; a correct
 *         `If-Match: "<version>"` succeeds and BUMPS `version` (the `agentic.*`
 *         loop knobs live on this same policy row).
 *  B. SUPER_ADMIN-only writes — `PATCH /api/v1/admin/harness/policy/global`
 *     (SYSTEM GLOBAL-DEFAULT): a tenant admin → 403 (deliberate privilege wall,
 *     `assertPlatform`), even with a valid `If-Match` (so the 403 is the
 *     privilege verdict, not the 428 header gate).
 *  C. Prompt governance approval — `POST /api/v1/admin/prompt-templates/:id/approve`
 * (`PromptManagementController.approve`, Phase 3A, SUPER_ADMIN-only,
 *     `@RequiresIfMatch()`):
 *       - a tenant admin → 403 (service `isSuperAdmin` privilege check);
 *       - missing `If-Match` → 428; stale `If-Match: "999"` → 412;
 *       - a SUPER_ADMIN with a correct `If-Match` flips a DRAFT template to
 *         `status = APPROVED` (the status the prompt-resolution gate requires).
 *  D. DRAFT-prompt resolution skip — `GET /api/v1/admin/agentic/instructions`
 *     (`AgenticAdminController`, the effective-instruction resolution/read plane):
 *       a freshly-created DRAFT template is NEVER the resolved `promptTier.promptId`
 *       (non-APPROVED templates are skipped at resolution time).
 *
 * Cross-tenant hygiene: the throwaway prompt template is created in the tenant
 * admin's OWN tenant (`__GLOBAL__`) so the approve-403 is unambiguously the
 * privilege wall and not the 404-over-403 tenancy posture.
 *
 * Live-stack requirement: dev/test stack + seed (owner-run via
 * `pnpm test:api:up` + `pnpm test:e2e`). All mutations target a throwaway
 * template (soft-deleted in `afterAll`) and idempotent policy-knob toggles — no
 * seed rows are destroyed.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const HARNESS_POLICY = '/api/v1/admin/harness/policy';
const PROMPT_TEMPLATES = '/api/v1/admin/prompt-templates';
const AGENTIC_INSTRUCTIONS = '/api/v1/admin/agentic/instructions';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface HarnessPolicy {
  version: number;
  maxRegen: number;
  source: string;
}
interface PromptTemplate {
  id: string;
  status: string;
  version?: number;
}
interface AgenticInstructions {
  tenantId: string;
  promptTier: { promptId: string; template: string; resolvedFrom: string; promptType: string };
}

test.describe('agentic policy governance (OCC + SUPER_ADMIN privilege walls)', () => {
  /** SUPER_ADMIN acting on tenant __GLOBAL__ (same tenant as the tenant admin, so 403s are privilege verdicts). */
  let globalAdminToken: string;
  let tenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(ga, `global admin login (${DEFAULT_TENANT_KEY}) failed — is the stack seeded?`).toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  // ─────────────── A. HarnessPolicy loop-knob OCC ───────────────

  async function readPolicy(request: APIRequestContext, token: string): Promise<HarnessPolicy> {
    const resp = await request.get(HARNESS_POLICY, { headers: bearer(token) });
    expect(resp.status(), 'GET harness policy').toBe(200);
    return (await resp.json()) as HarnessPolicy;
  }

  test('A: PATCH harness policy without If-Match → 428', async ({ request }) => {
    const resp = await request.patch(HARNESS_POLICY, {
      headers: bearer(globalAdminToken),
      data: { maxRegen: 2 },
    });
    expect(resp.status()).toBe(428);
  });

  test('A: PATCH harness policy with a stale If-Match → 412', async ({ request }) => {
    const resp = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(globalAdminToken), 'If-Match': '"999"' },
      data: { maxRegen: 2 },
    });
    expect(resp.status()).toBe(412);
  });

  test('A: PATCH harness policy with the current If-Match succeeds and bumps version', async ({ request }) => {
    // On a fresh seed the FIRST edit CREATES the tenant row — the caller's
    // validator is the inherited SYSTEM default's version and the created
    // row starts at version 1, so "bumps version" cannot hold on that edit.
    // Edit once to guarantee the row exists, then assert the OCC
    // version bump on a SECOND edit against the materialized row.
    const before = await readPolicy(request, globalAdminToken);
    const firstMaxRegen = before.maxRegen === 2 ? 3 : 2;
    const first = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${before.version}"` },
      data: { maxRegen: firstMaxRegen, reason: `e2e ${Date.now()}` },
    });
    expect(first.status()).toBe(200);
    expect(((await first.json()) as HarnessPolicy).maxRegen).toBe(firstMaxRegen);

    const mid = await readPolicy(request, globalAdminToken);
    expect(mid.source).toBe('tenant');
    const secondMaxRegen = mid.maxRegen === 2 ? 3 : 2;
    const second = await request.patch(HARNESS_POLICY, {
      headers: { ...bearer(globalAdminToken), 'If-Match': `"${mid.version}"` },
      data: { maxRegen: secondMaxRegen, reason: `e2e ${Date.now()}` },
    });
    expect(second.status()).toBe(200);
    const after = (await second.json()) as HarnessPolicy;
    expect(after.maxRegen).toBe(secondMaxRegen);
    expect(after.version).toBeGreaterThan(mid.version);
  });

  // ─────────────── B. SUPER_ADMIN-only global policy ───────────────

  test('B: a tenant admin cannot PATCH the SYSTEM global-default policy → 403 (privilege wall, not the 428 gate)', async ({ request }) => {
    const resp = await request.patch(`${HARNESS_POLICY}/global`, {
      // Supply a valid If-Match so the 428 header gate is bypassed and the 403
      // verdict is unambiguously the SUPER_ADMIN privilege check.
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
      data: { maxRegen: 2 },
    });
    expect(resp.status()).toBe(403);
  });

  // ─────────────── C + D. Prompt approval governance + DRAFT resolution skip ───────────────

  test.describe.serial('C/D — prompt approval + DRAFT resolution skip', () => {
    let templateId: string;
    const unique = Date.now();

    test.beforeAll(async ({ request }) => {
      const create = await request.post(PROMPT_TEMPLATES, {
        headers: bearer(globalAdminToken),
        data: {
          name: `t511 approve ${unique}`,
          content: 'Summarize the visit for {{patient}}.',
          category: 'CUSTOM',
          variables: ['patient'],
          status: 'DRAFT',
        },
      });
      expect(create.status(), 'create DRAFT template').toBeLessThan(300);
      templateId = ((await create.json()) as PromptTemplate).id;
      expect(templateId).toBeTruthy();
    });

    test.afterAll(async ({ request }) => {
      if (templateId) {
        await request.delete(`${PROMPT_TEMPLATES}/${templateId}`, { headers: bearer(globalAdminToken) }).catch(() => undefined);
      }
    });

    test('C: a tenant admin CAN approve their own tenant-owned template (OD-3 split gate)', async ({ request }) => {
      // Uses its OWN throwaway template rather than the shared `templateId`
      // from beforeAll: approveTemplate is idempotent once status===APPROVED
      // (prompt-management.service.ts:462, short-circuits BEFORE any version
      // check), so mutating the shared template here would silently break
      // every downstream OCC assertion in this serial block (test D, and the
      // 428 / 412 / "flips to APPROVED" tests below, which all still need it
      // in DRAFT).
      const create = await request.post(PROMPT_TEMPLATES, {
        headers: bearer(globalAdminToken),
        data: {
          name: `t511 tenant-approve ${unique}`,
          content: 'Summarize the visit for {{patient}}.',
          category: 'CUSTOM',
          variables: ['patient'],
          status: 'DRAFT',
        },
      });
      expect(create.status(), 'create DRAFT template for the tenant-approve check').toBeLessThan(300);
      const tenantOwnedId = ((await create.json()) as PromptTemplate).id;

      // This template is created under the global admin's own (non-SYSTEM)
      // tenant, so approval exercises the tenant-owned branch of
      // assertCanApprove: a caller holding manage:PromptTemplate for that
      // tenant may approve it. Only SYSTEM/library templates (tenantId =
      // SYSTEM) stay SUPER_ADMIN-only — see test B for that privilege wall,
      // and .claude/rules/05-nestjs-api.md's Imperative Privilege Checks table.
      const resp = await request.post(`${PROMPT_TEMPLATES}/${tenantOwnedId}/approve`, {
        headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
        data: {},
      });
      expect(resp.status()).toBe(200);
      const approved = (await resp.json()) as PromptTemplate;
      expect(approved.status).toBe('APPROVED');

      await request.delete(`${PROMPT_TEMPLATES}/${tenantOwnedId}`, { headers: bearer(globalAdminToken) }).catch(() => undefined);
    });

    test('D: a DRAFT template is NEVER the resolved prompt tier (resolution skips non-APPROVED)', async ({ request }) => {
      const resp = await request.get(`${AGENTIC_INSTRUCTIONS}?promptType=new-patient`, { headers: bearer(globalAdminToken) });
      expect(resp.status(), 'GET agentic instructions').toBe(200);
      const body = (await resp.json()) as AgenticInstructions;
      expect(body.promptTier, 'instructions carry a resolved prompt tier').toBeTruthy();
      expect(body.promptTier.promptId, 'the DRAFT template is skipped at resolution time').not.toBe(templateId);
    });

    test('C: approve without If-Match → 428', async ({ request }) => {
      const resp = await request.post(`${PROMPT_TEMPLATES}/${templateId}/approve`, {
        headers: bearer(globalAdminToken),
        data: {},
      });
      expect(resp.status()).toBe(428);
    });

    test('C: approve with a stale If-Match → 412', async ({ request }) => {
      const resp = await request.post(`${PROMPT_TEMPLATES}/${templateId}/approve`, {
        headers: { ...bearer(globalAdminToken), 'If-Match': '"999"' },
        data: {},
      });
      expect(resp.status()).toBe(412);
    });

    test('C: a SUPER_ADMIN with the current If-Match flips the template to APPROVED', async ({ request }) => {
      const get = await request.get(`${PROMPT_TEMPLATES}/${templateId}`, { headers: bearer(globalAdminToken) });
      expect(get.status()).toBe(200);
      const current = (await get.json()) as PromptTemplate;
      const etag = get.headers()['etag'];
      const ifMatch = etag ?? `"${current.version ?? 1}"`;

      const resp = await request.post(`${PROMPT_TEMPLATES}/${templateId}/approve`, {
        headers: { ...bearer(globalAdminToken), 'If-Match': ifMatch },
        data: { reason: 'e2e approval' },
      });
      expect(resp.status()).toBe(200);
      const approved = (await resp.json()) as PromptTemplate;
      expect(approved.status).toBe('APPROVED');
    });
  });
});
