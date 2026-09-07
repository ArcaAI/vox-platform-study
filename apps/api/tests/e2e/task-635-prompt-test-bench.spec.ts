/**
 * Extended prompt-template test-bench E2E
 * (`POST /admin/prompt-templates/:id/test`).
 *
 * Backend contract under test (`prompt-management.service.ts#testPromptTemplate`,
 * `dto/test-prompt-template.request.ts`):
 *   - `dryRun` (B2): score/generate WITHOUT persisting `lastTest*` or bumping
 *     the row `_version` — the response `version` and a subsequent GET's
 *     `ETag`/`version` must be byte-identical to before the call.
 *   - `dryRun` omitted (default `false`): the run IS an OCC write — it
 *     persists `lastTest*` and bumps `_version` by exactly 1, mirroring PATCH.
 *   - `provider`/`model` (B1): caller-selected pair, forwarded to TEXT
 *     verbatim; validated against the ENABLED `AiModel` TEXT_GENERATION /
 *     SUMMARIZATION registry BEFORE the TEXT call — an unknown/disabled pair
 *     is a deterministic `400`, independent of TEXT reachability.
 *   - `versionNumber` (B2): tests the immutable pinned `PromptVersion`
 *     snapshot instead of the mutable draft; an out-of-range number is a
 *     deterministic `404` (the version lookup happens before the TEXT call).
 *   - `goldenCaseId` (B3): mutually exclusive with `sampleInput` (`400` if
 *     both); a missing OR cross-tenant id is `404` — `loadGoldenCaseSampleInput`
 *     uses the SAME `!goldenCase || goldenCase.tenantId !== tenantId` branch
 *     for both cases (404-over-403), so a synthetic nonexistent id exercises
 *     the identical code path a genuine cross-tenant id would.
 *   - BUG-018: `POST :id/test` is now a SUBMIT that returns a
 *     `PromptTestAckResponse` (`mode`, `provider`, `model`, `assembledPrompt`,
 *     and `taskId`/`streamUrl` in stream mode) WITHOUT awaiting the LLM. It no
 *     longer writes, so `@RequiresIfMatch()` moved to the new
 *     `POST :id/test/finalize`, where the OCC write lives. `dryRun: true` makes
 *     no TEXT call at all, so it is fully deterministic now.
 *
 * TEXT dependency (house pattern from `agent-management-contract.spec.ts`,
 * frame-33 test). Every SUCCESS branch of `testPromptTemplate` calls
 * `callTextGenerate` UNCONDITIONALLY — `dryRun` only skips the persistence
 * step, generation always runs — so any assertion that needs a `200/201`
 * body is generation-dependent. Deterministic gates (`400`/`404`/`428`, all
 * thrown BEFORE `callTextGenerate`) are asserted unconditionally; the
 * generation-dependent assertions are gated behind a `[200, 201]` check with
 * a `console.warn` fallback when the stack's TEXT/text-generation service is
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
 * to the `ARCAAI` tenant (the cross-tenant pattern, per
 * `ai-task-defaults-cross-tenant.spec.ts`).
 *
 * @see apps/api/src/modules/prompt-management/prompt-management.controller.ts
 * @see packages/applications/src/services/prompt-management/prompt-management.service.ts
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

interface PromptTestAck {
  mode: 'stream' | 'dry-run';
  provider: string;
  model: string;
  assembledPrompt: string;
  taskId?: string;
  streamUrl?: string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
/** RFC 7232 strong validator the OCC route requires. */
const ifMatch = (token: string, version: number) => ({ ...auth(token), 'If-Match': `"${version}"` });

/**
 * `callTextGenerate` runs unconditionally on every non-error path, so a
 * `[200, 201]` response is the only proof the TEXT/text-generation service
 * answered. Anything else in a test stack without a live LLM backend is
 * treated as "generation unavailable" — logged, not failed — so the spec's
 * deterministic gates (asserted separately, before this call) stay the
 * source of truth.
 */
function loggedGenerationAvailable(status: number, label: string): boolean {
  if (GENERATION_SUCCESS_STATUSES.includes(status)) return true;
  console.warn(
    `[task-635] ${label} returned ${status} — TEXT/text-generation likely unavailable in this stack; skipping generation-dependent assertions.`,
  );
  return false;
}

test.describe.serial('prompt-template test bench (tenant_admin · __GLOBAL__)', () => {
  let tenantAdminToken: string;
  /** super_admin scoped to the ARCAAI tenant — foreign to the __GLOBAL__ throwaway template below. */
  let crossTenantToken: string;
  let promptId: string;
  /** Unique tag stamped on the throwaway row so the `?tags=` filter has an unambiguous target. */
  let uniqueTag: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login (__GLOBAL__) failed — is the stack seeded? (pnpm test:db:seed)').toBeTruthy();
    tenantAdminToken = ta!.token;

    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(sa, 'super_admin login (ARCAAI) failed').toBeTruthy();
    crossTenantToken = sa!.token;

    const stamp = Date.now().toString(36);
    uniqueTag = `e2e-tag-${stamp}`;
    const created = await request.post(PROMPTS, {
      headers: auth(tenantAdminToken),
      data: {
        name: ` test-bench ${stamp}`,
        content: 'Generate a {{department}} clinical summary from the following notes.',
        category: 'SUMMARY',
        status: 'PUBLISHED',
        // TASK-890 §3.6 (L4) — the legacy MAP form is refused; declarations are an array.
        variables: [{ name: 'department', type: 'string', required: true }],
        tags: [uniqueTag, 'test-bench'],
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

  test('dry-run: acks with the assembled prompt and leaves ETag/_version UNCHANGED (no TEXT call at all)', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    expect(before.status()).toBe(200);
    const beforeRow = (await before.json()) as PromptTemplateRow;
    const beforeEtag = before.headers()['etag'];
    expect(beforeEtag, 'GET stamps an ETag from the row version').toBe(`"${beforeRow.version}"`);

    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'Patient reports 3 days of dry cough, no fever.', variables: { department: 'General Medicine' }, dryRun: true },
    });
    // BUG-018: fully deterministic — a dry run never touches TEXT, so this is a
    // hard assertion, not a generation-gated one. (A 400 here means no
    // `text.test` AiTaskDefault is configured in the stack — a real regression.)
    expect(GENERATION_SUCCESS_STATUSES, `dry-run submit → ${res.status()}`).toContain(res.status());
    const ack = (await res.json()) as PromptTestAck;
    expect(ack.mode).toBe('dry-run');
    expect(ack.assembledPrompt).toContain('General Medicine');
    expect(ack.assembledPrompt).toContain('dry cough');
    expect(ack.taskId, 'a dry run submits no job').toBeUndefined();
    expect(typeof ack.provider).toBe('string');
    expect(typeof ack.model).toBe('string');

    const after = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    expect(after.status()).toBe(200);
    const afterRow = (await after.json()) as PromptTemplateRow;
    expect(afterRow.version, 'the submit never bumps _version').toBe(beforeRow.version);
    expect(after.headers()['etag'], 'the submit never moves the ETag').toBe(beforeEtag);
  });

  // ── BUG-018 — the streaming submit acks immediately and does not write ──

  test('stream submit: returns { taskId, streamUrl } fast and leaves _version UNCHANGED', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    const startedAt = Date.now();
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'Patient reports 3 days of dry cough, no fever.', variables: { department: 'General Medicine' } },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(res.status(), 'owned template ⇒ never 404, and never 428 (this route no longer writes)').not.toBe(404);
    expect(res.status()).not.toBe(428);

    if (loggedGenerationAvailable(res.status(), 'stream submit')) {
      const ack = (await res.json()) as PromptTestAck;
      expect(ack.mode).toBe('stream');
      expect(ack.taskId, 'the ack carries the TEXT generation task id').toBeTruthy();
      expect(ack.streamUrl).toBe(`text/tasks/${ack.taskId}/stream`);
      // The whole point of BUG-018: no CDN in front of the gateway will hold a
      // 2-3 minute response. The submit must return long before any ceiling.
      expect(elapsedMs, 'the submit must not await the generation').toBeLessThan(30_000);
    }

    // Either way, submitting is not a write.
    const after = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const afterRow = (await after.json()) as PromptTemplateRow;
    expect(afterRow.version, 'the submit is not an OCC write').toBe(beforeRow.version);
  });

  // ── BUG-018 — finalize is where the OCC write (and the If-Match gate) lives ──

  test('finalize: missing If-Match → 428 (checked before the handler body)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test/finalize`, {
      headers: auth(tenantAdminToken),
      data: { taskId: 'no-such-task' },
    });
    expect(res.status()).toBe(428);
  });

  test('finalize: an unknown taskId → 404 or 400, never a write', async ({ request }) => {
    const before = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const beforeRow = (await before.json()) as PromptTemplateRow;

    // Is TEXT reachable in this stack? It must be a REAL submit: a dry run deliberately never
    // touches TEXT (see the `dry-run submit` test above), so a dry-run probe reports "up" even
    // when TEXT is down — which is exactly how a first attempt at this gate went wrong. A stream
    // submit is the same dependency the finalize path validates through, and it returns an ack
    // without awaiting generation, so it is cheap.
    const probe = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'Patient reports 3 days of dry cough, no fever.', variables: { department: 'General Medicine' } },
    });

    const res = await request.post(`${PROMPTS}/${promptId}/test/finalize`, {
      headers: ifMatch(tenantAdminToken, beforeRow.version),
      data: { taskId: 'no-such-task-635' },
    });
    // `finalizePromptTemplateTest` validates the taskId ONLY by calling TEXT
    // (`prompt-management.service.ts:1001` → `:1386`), so with `apps/text` down an
    // `ECONNREFUSED` becomes an honest 503 by the downstream-error design
    // (`downstream-error.ts:160`) — the service genuinely cannot tell an unknown task from an
    // unreachable validator. Every sibling test in this file already gates on TEXT availability;
    // this one did not, which is why it failed in a stack without TEXT.
    //
    // Gate rather than widen the accepted set. Simply adding 503 to the list would make the
    // test permanently unable to catch a 503 raised WHILE TEXT IS UP — the regression it is
    // best placed to notice. With TEXT up the original 400/404 invariant is asserted in full.
    if (loggedGenerationAvailable(probe.status(), 'unknown-task finalize (TEXT probe)')) {
      expect([400, 404], `unknown task finalize → ${res.status()}`).toContain(res.status());
    }

    const after = await request.get(`${PROMPTS}/${promptId}`, { headers: auth(tenantAdminToken) });
    const afterRow = (await after.json()) as PromptTemplateRow;
    expect(afterRow.version, 'a failed finalize never writes').toBe(beforeRow.version);
  });

  // ── B1 — explicit provider/model ────────────────────────────────────────

  test('explicit provider/model: a known ENABLED pair is accepted (dry-run, 200 when TEXT is up)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      // `variables` supplies the template's REQUIRED `department` declaration — since TASK-890
      // §3.6 a test-run is validated against the declarations, so omitting it is a 400 about the
      // variable rather than about the provider/model pair this case is here to assert.
      data: {
        sampleInput: 'Patient reports 3 days of dry cough, no fever.',
        variables: { department: 'General Medicine' },
        provider: KNOWN_PROVIDER,
        model: KNOWN_MODEL,
        dryRun: true,
      },
    });
    expect(res.status(), 'owned template ⇒ never 428/404').not.toBe(428);
    expect(res.status()).not.toBe(404);

    if (loggedGenerationAvailable(res.status(), 'known provider/model test')) {
      const ack = (await res.json()) as PromptTestAck;
      expect(ack.provider).toBe(KNOWN_PROVIDER);
      expect(ack.model).toBe(KNOWN_MODEL);
    } else {
      // made this branch decisive. Previously an unreachable TEXT ALSO
      // produced a 400 (`Failed to call TEXT service: connect ECONNREFUSED
      // 127.0.0.1:8862`), so a bare status check could not tell "known pair
      // wrongly rejected" apart from "TEXT is down in this stack" and the test
      // had to read the message. Now the two are different statuses: an absent
      // dependency is 503, and 400 can only mean `assertKnownTextModel` rejected
      // the pair before the TEXT call — a genuine contract failure.
      expect(res.status(), `a KNOWN pair (${KNOWN_PROVIDER}/${KNOWN_MODEL}) must not be rejected as unknown/disabled`).not.toBe(400);

      if (res.status() === 503) {
        // The dependency is absent — and it must say so without naming itself.
        const body = await res.text().catch(() => '');
        expect(body, 'a 503 must not carry the internal host:port').not.toMatch(/ECONNREFUSED|\d{1,3}(?:\.\d{1,3}){3}|:88\d{2}\b/);
        expect(res.headers()['retry-after'], 'every 503 backs the caller off').toBeTruthy();
      }
    }
  });

  test('explicit provider/model: an unknown/disabled pair → 400 (validated before the TEXT call, deterministic)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'x', provider: 'no-such-provider', model: 'no-such-model', dryRun: true },
    });
    expect(res.status()).toBe(400);
  });

  // ── B2 — versionNumber: pinned PromptVersion snapshot ───────────────────

  test('versionNumber: an out-of-range version → 404 (checked before the TEXT call, deterministic)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'x', versionNumber: 9999, dryRun: true },
    });
    expect(res.status()).toBe(404);
  });

  test('versionNumber: the seeded v1 snapshot resolves (dry-run, 200 when TEXT is up)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'x', variables: { department: 'General Medicine' }, versionNumber: 1, dryRun: true },
    });
    // Deterministic gate: v1 exists (created alongside the template in
    // beforeAll), so the lookup itself never 404s regardless of TEXT.
    expect(res.status()).not.toBe(404);
    expect(res.status()).not.toBe(428);

    if (loggedGenerationAvailable(res.status(), 'versionNumber=1 test')) {
      const ack = (await res.json()) as PromptTestAck;
      expect(ack.assembledPrompt).toContain('General Medicine');
    }
  });

  // ── B3 — goldenCaseId (negative-space only; see file header) ────────────

  test('goldenCaseId: both sampleInput AND goldenCaseId → 400 (mutually exclusive, checked before any lookup)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { sampleInput: 'x', goldenCaseId: SYNTHETIC_GOLDEN_CASE_ID, dryRun: true },
    });
    expect(res.status()).toBe(400);
  });

  test('goldenCaseId: a nonexistent id → 404 (identical branch a cross-tenant id would take — see file header)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(tenantAdminToken),
      data: { goldenCaseId: SYNTHETIC_GOLDEN_CASE_ID, dryRun: true },
    });
    expect(res.status()).toBe(404);
  });

  // ── TASK-890 J2-4 — `?tags=` narrows the admin list (`hasEvery`) ───────

  test('tags filter: `?tags=` narrows to the tagged row, and a second unmatched tag empties it (hasEvery)', async ({ request }) => {
    const list = async (tags: string) => {
      const res = await request.get(`${PROMPTS}?limit=200&tags=${encodeURIComponent(tags)}`, { headers: auth(tenantAdminToken) });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      return (Array.isArray(body) ? body : body.data) as PromptTemplateRow[];
    };

    const matched = await list(uniqueTag);
    expect(
      matched.map((row) => row.id),
      'the unique tag must select exactly the throwaway row',
    ).toEqual([promptId]);

    // `hasEvery`: adding a tag the row does not carry must empty the result, not widen it.
    expect(await list(`${uniqueTag},not-a-tag-on-this-row`)).toHaveLength(0);
  });

  // ── Cross-tenant (404-over-403, pattern) ───────────────────────

  test('cross-tenant: super_admin scoped to ARCAAI cannot test this __GLOBAL__ template (404, never 403/200)', async ({ request }) => {
    const res = await request.post(`${PROMPTS}/${promptId}/test`, {
      headers: auth(crossTenantToken),
      data: { sampleInput: 'x', dryRun: true },
    });
    expect(res.status(), 'cross-tenant test run is 404, never 403 (no existence disclosure)').toBe(404);
  });
});
