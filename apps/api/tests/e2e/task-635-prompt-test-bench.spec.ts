/**
 * TASK-635 Lane B5 — extended prompt-template test-bench E2E
 * (`POST /admin/prompt-templates/:id/test`).
 *
 * Backend contract under test (`prompt-management.service.ts#testPromptTemplate`,
 * `dto/test-prompt-template.request.ts`):
 *   - `dryRun` (B2): score/generate WITHOUT persisting `lastTest*` or bumping
 *     the row `_version` — the response `version` and a subsequent GET's
 *     `ETag`/`version` must be byte-identical to before the call.
 *   - `dryRun` omitted (default `false`): the run IS an OCC write — it
 *     persists `lastTest*` and bumps `_version` by exactly 1, mirroring PATCH.
 *   - `provider`/`model` (B1): caller-selected pair, forwarded to SMR
 *     verbatim; validated against the ENABLED `AiModel` TEXT_GENERATION /
 *     SUMMARIZATION registry BEFORE the SMR call — an unknown/disabled pair
 *     is a deterministic `400`, independent of SMR reachability.
 *   - `versionNumber` (B2): tests the immutable pinned `PromptVersion`
 *     snapshot instead of the mutable draft; an out-of-range number is a
 *     deterministic `404` (the version lookup happens before the SMR call).
 *   - `goldenCaseId` (B3): mutually exclusive with `sampleInput` (`400` if
 *     both); a missing OR cross-tenant id is `404` — `loadGoldenCaseSampleInput`
 *     uses the SAME `!goldenCase || goldenCase.tenantId !== tenantId` branch
 *     for both cases (404-over-403), so a synthetic nonexistent id exercises
 *     the identical code path a genuine cross-tenant id would.
 *   - `@RequiresIfMatch()`: missing `If-Match` → `428` on every call
 *     (including dry runs); the header is checked before the handler body
 *     runs, so it never depends on SMR.
 *
 * SMR dependency (house pattern from `agent-management-contract.spec.ts`,
 * frame-33 test). Every SUCCESS branch of `testPromptTemplate` calls
 * `callSmrGenerate` UNCONDITIONALLY — `dryRun` only skips the persistence
 * step, generation always runs — so any assertion that needs a `200/201`
 * body is generation-dependent. Deterministic gates (`400`/`404`/`428`, all
 * thrown BEFORE `callSmrGenerate`) are asserted unconditionally; the
 * generation-dependent assertions are gated behind a `[200, 201]` check with
 * a `console.warn` fallback when the stack's SMR/text-generation service is
 * unreachable, so the spec stays green without a live LLM backend while
 * still proving the contract when one is available.
 *
 * Golden-case happy path (B3) — NOT exercised. No `GoldenCase` row is
 * seeded anywhere in `packages/database/src/prisma/db_main/seed/` (grepped
 * clean); a live one could be minted via
 * `POST /admin/harness/golden-sets` + `.../cases` (see
 * `admin-golden-sets-webhooks.spec.ts`), but that pulls in a second CASL
 * surface (`read:HarnessEval`) purely to stand up fixture data this spec
 * doesn't otherwise need. The two failure branches of the `goldenCaseId`
 * contract — mutual exclusivity (`400`) and tenant-scoped lookup (`404`,
 * covering BOTH "missing" and "cross-tenant" per the note above) — give
 * full negative-space coverage of the code path without it.
 *
 * Operator: `tenant_admin` (`__GLOBAL__` tenant, `manage:PromptTemplate`)
 * owns a throwaway `SUMMARY` template created in `beforeAll` and soft-deleted
 * in `afterAll` — mirrors `agent-management-contract.spec.ts` so this spec
 * never touches seeded rows. Cross-tenant probe reuses `super_admin` scoped
 * to the `ARCAAI` tenant (the task-307 cross-tenant pattern, per
 * `ai-task-defaults-cross-tenant.spec.ts`).
 *
 * @see apps/api/src/modules/prompt-management/prompt-management.controller.ts
 * @see packages/applications/src/services/prompt-management/prompt-management.service.ts
 * @see docs/implementation/TASK-635-Summarization-Agent-Conformance/README.md §4.3 (B5)
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const PROMPTS = '/api/v1/admin/prompt-templates';

/** A seeded ENABLED `AiModel` TEXT_GENERATION row (`packages/database/src/prisma/db_main/seed/ai-models/llm.ts`) — the platform default text/summarization model. */
const KNOWN_PROVIDER = 'lm-studio';
const KNOWN_MODEL = 'gemma-4-e2b-it-qat';

/** uuidv7-shaped id that exists in no environment (DEF-C3 probe, mirrors admin-golden-sets-webhooks.spec.ts). */
const SYNTHETIC_GOLDEN_CASE_ID = '018f0000-0000-7419-8000-000000000635';

const GENERATION_SUCCESS_STATUSES = [200, 201];

interface PromptTemplateRow {
  id: string;
  tenantId?: string;
  version: number;
}

interface PromptTestResult {
  id: string;
  score: number;
  output: string;
  testedAt: string;
  version: number;
  metrics?: Record<string, unknown>;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
/** RFC 7232 strong validator the OCC route requires. */
const ifMatch = (token: string, version: number) => ({ ...auth(token), 'If-Match': `"${version}"` });

/**
 * `callSmrGenerate` runs unconditionally on every non-error path, so a
 * `[200, 201]` response is the only proof the SMR/text-generation service
 * answered. Anything else in a test stack without a live LLM backend is
 * treated as "generation unavailable" — logged, not failed — so the spec's
 * deterministic gates (asserted separately, before this call) stay the
 * source of truth.
 */
function loggedGenerationAvailable(status: number, label: string): boolean {
  if (GENERATION_SUCCESS_STATUSES.includes(status)) return true;
  console.warn(
    `[task-635] ${label} returned ${status} — SMR/text-generation likely unavailable in this stack; skipping generation-dependent assertions.`,
  );
  return false;
}

test.describe.serial('prompt-template test bench (TASK-635 Lane B · tenant_admin · __GLOBAL__)', () => {
  let tenantAdminToken: string;
  /** super_admin scoped to the ARCAAI tenant — foreign to the __GLOBAL__ throwaway template below. */
  let crossTenantToken: string;
  let promptId: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login (__GLOBAL__) failed — is the stack seeded? (pnpm test:db:seed)').toBeTruthy();
    tenantAdminToken = ta!.token;

    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(sa, 'super_admin login (ARCAAI) failed').toBeTruthy();
    crossTenantToken = sa!.token;

    const stamp = Date.now().toString(36);
    const created = await request.post(PROMPTS, {
      headers: auth(tenantAdminToken),
      data: {
        name: `TASK-635 test-bench ${stamp}`,
        content: 'Generate a {{department}} clinical summary from the following notes.',
        category: 'SUMMARY',
        status: 'PUBLISHED',
        variables: { department: { type: 'string', required: true } },
      },
    });
    expect([200, 201], `create throwaway template → ${created.status()}`).toContain(created.status());
    const template = (await created.json()) as PromptTemplateRow;
    promptId = template.id;
    expect(promptId).toBeTruthy();
    expect(template.version, 'freshly created row starts at _version 1').toBe(1);
  });

  test.afterAll(async ({ request }) => {
    if (!promptId) return;
    const del = await request.delete(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    if (![200, 204].includes(del.status())) console.warn(`[task-635] template cleanup ${del.status()}`);
  });

  // ── B2 — dry-run: score/generate WITHOUT touching the resource ─────────

  test('dry-run: 200 with output+score; a follow-up GET proves ETag/_version are UNCHANGED', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    expect(before.status()).toBe(200);
    const beforeRow = (await before.json()) as PromptTemplateRow;
    const beforeEtag = before.headers()['etag'];
    expect(beforeEtag, 'GET stamps an ETag from the row version').toBe(`"${beforeRow.version}"`);

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'Patient reports 3 days of dry cough, no fever.', variables: { department: 'General Medicine' }, dryRun: true },
    });
    // Deterministic gate: If-Match was present and correct, so the OCC/tenant
    // checks all pass regardless of whether SMR itself answers.
    expect(res.status(), 'If-Match present + owned template ⇒ never 428/404').not.toBe(428);
    expect(res.status()).not.toBe(404);

    if (loggedGenerationAvailable(res.status(), 'dry-run test')) {
      const result = (await res.json()) as PromptTestResult;
      expect(typeof result.output).toBe('string');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.version, 'dry-run response echoes the UNCHANGED row version').toBe(beforeRow.version);

      const after = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
      expect(after.status()).toBe(200);
      const afterRow = (await after.json()) as PromptTemplateRow;
      expect(afterRow.version, 'dry-run never bumps _version').toBe(beforeRow.version);
      expect(after.headers()['etag'], 'dry-run never moves the ETag').toBe(beforeEtag);
    }
  });

  // ── B2 — non-dry-run (default): the run IS an OCC write ────────────────

  test('non-dry-run (dryRun omitted): persists lastTest* and bumps _version by exactly 1', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'Patient reports 3 days of dry cough, no fever.', variables: { department: 'General Medicine' } },
    });
    expect(res.status(), 'If-Match present + owned template ⇒ never 428/404').not.toBe(428);
    expect(res.status()).not.toBe(404);

    if (loggedGenerationAvailable(res.status(), 'non-dry-run test')) {
      const result = (await res.json()) as PromptTestResult;
      expect(result.version, 'persisted run bumps _version by exactly 1').toBe(beforeRow.version + 1);

      const after = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
      const afterRow = (await after.json()) as PromptTemplateRow;
      expect(afterRow.version).toBe(beforeRow.version + 1);
      expect(after.headers()['etag']).toBe(`"${beforeRow.version + 1}"`);
    }
  });

  // ── B1 — explicit provider/model ────────────────────────────────────────

  test('explicit provider/model: a known ENABLED pair is accepted (dry-run, 200 when SMR is up)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'Patient reports 3 days of dry cough, no fever.', provider: KNOWN_PROVIDER, model: KNOWN_MODEL, dryRun: true },
    });
    expect(res.status(), 'If-Match present + owned template ⇒ never 428/404').not.toBe(428);
    expect(res.status()).not.toBe(404);

    if (loggedGenerationAvailable(res.status(), 'known provider/model test')) {
      const result = (await res.json()) as PromptTestResult;
      expect(typeof result.output).toBe('string');
    } else if (res.status() === 400) {
      // `callSmrGenerate` wraps ANY axios failure (incl. SMR unreachable) as a
      // 400 too, so a bare status check can't tell "known pair wrongly
      // rejected" apart from "SMR is down in this stack". Read the message:
      // `assertKnownSmrModel` throws a distinct "Unknown or disabled
      // provider/model pair" ArgumentInvalidException BEFORE the SMR call —
      // if we see that instead of the SMR-call wrapper, the pair really was
      // rejected and this is a genuine contract failure.
      const body = await res.text().catch(() => '');
      expect(body, `a KNOWN pair (${KNOWN_PROVIDER}/${KNOWN_MODEL}) must not be rejected as unknown/disabled`).toMatch(/Failed to call SMR service/i);
    }
  });

  test('explicit provider/model: an unknown/disabled pair → 400 (validated before the SMR call, deterministic)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'x', provider: 'no-such-provider', model: 'no-such-model', dryRun: true },
    });
    expect(res.status()).toBe(400);
  });

  // ── B2 — versionNumber: pinned PromptVersion snapshot ───────────────────

  test('versionNumber: an out-of-range version → 404 (checked before the SMR call, deterministic)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'x', versionNumber: 9999, dryRun: true },
    });
    expect(res.status()).toBe(404);
  });

  test('versionNumber: the seeded v1 snapshot resolves (dry-run, 200 when SMR is up)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'x', variables: { department: 'General Medicine' }, versionNumber: 1, dryRun: true },
    });
    // Deterministic gate: v1 exists (created alongside the template in
    // beforeAll), so the lookup itself never 404s regardless of SMR.
    expect(res.status()).not.toBe(404);
    expect(res.status()).not.toBe(428);

    if (loggedGenerationAvailable(res.status(), 'versionNumber=1 test')) {
      const result = (await res.json()) as PromptTestResult;
      expect(typeof result.output).toBe('string');
    }
  });

  // ── B3 — goldenCaseId (negative-space only; see file header) ────────────

  test('goldenCaseId: both sampleInput AND goldenCaseId → 400 (mutually exclusive, checked before any lookup)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { sampleInput: 'x', goldenCaseId: SYNTHETIC_GOLDEN_CASE_ID, dryRun: true },
    });
    expect(res.status()).toBe(400);
  });

  test('goldenCaseId: a nonexistent id → 404 (identical branch a cross-tenant id would take — see file header)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { goldenCaseId: SYNTHETIC_GOLDEN_CASE_ID, dryRun: true },
    });
    expect(res.status()).toBe(404);
  });

  // ── If-Match gate ────────────────────────────────────────────────────────

  test('missing If-Match → 428 (checked before the handler body, even for a dry run)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'x', dryRun: true },
    });
    expect(res.status()).toBe(428);
  });

  // ── Cross-tenant (404-over-403, task-307 pattern) ───────────────────────

  test('cross-tenant: super_admin scoped to ARCAAI cannot test this __GLOBAL__ template (404, never 403/200)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: ifMatch(crossTenantToken, 1),
      data: { sampleInput: 'x', dryRun: true },
    });
    expect(res.status(), 'cross-tenant test run is 404, never 403 (no existence disclosure)').toBe(404);
  });
});
