/**
 * TASK-389 — Agents backend backlog (Group D) backend contract.
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`, or a dev stack via
 * `SKIP_DB_PRECHECK=true API_URL=http://localhost:8868/api/v1`). Mirrors the
 * harness of task-388-users-backend-backlog.spec.ts (seeded `super_admin` bound
 * to `__GLOBAL__` = admin operator with tenant context; `doctor` = RBAC negative).
 *
 * Coverage (ticket §Items #14–15):
 *   #14 server diff · a NEW server-side field-level version-diff endpoint
 *        (`GET /admin/prompt-templates/:id/versions/:from/diff/:to`) returns the
 *        combined `changes[]`/`patch`/`stats` (what the SDK `compareVersions`
 *        now consumes) plus the per-field breakdown. 404 for an unknown id;
 *        403 for a plain doctor.
 *   #15 test metrics · SDK-ONLY shape change (map `PromptTestMetrics` →
 *        `PromptTestResult.metrics`). No backend contract changed, so it is
 *        covered by the SDK unit tests (usePrompts / promptMetrics) rather than
 *        an API E2E — noted here for traceability.
 *
 * All mutations target a throwaway template (created + soft-deleted in the block)
 * — no seed rows are mutated.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface PromptDto {
  id: string;
  version?: number;
}
interface VersionDto {
  versionNumber: number;
}
interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}
interface DiffResponse {
  promptTemplateId: string;
  fromVersion: number;
  toVersion: number;
  fields: Array<{ field: string; changed: boolean; changes: DiffChange[]; stats: { additions: number; deletions: number; unchanged: number } }>;
  changes: DiffChange[];
  patch: string;
  stats: { additions: number; deletions: number; unchanged: number };
}

let saGlobalToken: string;
let doctorToken: string;
const UNIQUE = Date.now();

function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: T[] }).data)) return (raw as { data: T[] }).data;
  return [];
}

test.beforeAll(async ({ request }) => {
  const [saG, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(saG, 'super_admin (__GLOBAL__) login failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login failed — is the stack seeded?').toBeTruthy();
  saGlobalToken = saG!.token;
  doctorToken = doc!.token;
});

// =============================================================================
// #14 — server-side prompt version diff
// =============================================================================
test.describe.serial('TASK-389 #14 — server-side prompt version diff', () => {
  let templateId: string;
  let fromVersion: number;
  let toVersion: number;

  test.beforeAll(async ({ request }) => {
    // v1: create the template.
    const create = await request.post('/api/v1/admin/prompt-templates', {
      headers: bearer(saGlobalToken),
      data: {
        name: `t389 diff ${UNIQUE}`,
        content: 'Summarize the encounter for {{patient}}.\nUse a formal tone.',
        category: 'CUSTOM',
        variables: ['patient'],
        status: 'PUBLISHED',
      },
    });
    expect(create.status(), 'admin create template').toBeLessThan(300);
    templateId = ((await create.json()) as PromptDto).id;

    // v2: PATCH the content (OCC — If-Match from the single-object GET ETag).
    const get = await request.get(`/api/v1/admin/prompt-templates/${templateId}`, { headers: bearer(saGlobalToken) });
    expect(get.status()).toBe(200);
    const etag = get.headers()['etag'];
    expect(etag, 'single-object GET emits an ETag for OCC').toBeTruthy();

    const patch = await request.patch(`/api/v1/admin/prompt-templates/${templateId}`, {
      headers: { ...bearer(saGlobalToken), 'If-Match': etag },
      data: { content: 'Summarize the visit for {{patient}}.\nUse a concise, friendly tone.\nInclude next steps.', changeReason: 'e2e v2' },
    });
    expect(patch.status(), 'admin PATCH content → new version').toBeLessThan(300);

    const versionsRes = await request.get(`/api/v1/admin/prompt-templates/${templateId}/versions`, { headers: bearer(saGlobalToken) });
    expect(versionsRes.status()).toBe(200);
    const versions = asArray<VersionDto>(await versionsRes.json())
      .map((v) => v.versionNumber)
      .sort((a, b) => a - b);
    expect(versions.length, 'template has at least two versions to diff').toBeGreaterThanOrEqual(2);
    fromVersion = versions[0];
    toVersion = versions[versions.length - 1];
  });

  test.afterAll(async ({ request }) => {
    if (templateId) {
      await request.delete(`/api/v1/admin/prompt-templates/${templateId}`, { headers: bearer(saGlobalToken) }).catch(() => undefined);
    }
  });

  test('#14 returns a structured field-level + combined diff between two versions', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/prompt-templates/${templateId}/versions/${fromVersion}/diff/${toVersion}`, {
      headers: bearer(saGlobalToken),
    });
    expect(res.status(), 'server diff → 200').toBe(200);
    const body = (await res.json()) as DiffResponse;

    expect(body.promptTemplateId).toBe(templateId);
    expect(body.fromVersion).toBe(fromVersion);
    expect(body.toVersion).toBe(toVersion);

    // Combined diff (what the SDK maps into DiffResult).
    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.changes.some((c) => c.added), 'a content change appears as an addition').toBe(true);
    expect(body.changes.some((c) => c.removed), 'a content change appears as a removal').toBe(true);
    expect(typeof body.patch).toBe('string');
    expect(body.stats.additions + body.stats.deletions, 'the diff registered real edits').toBeGreaterThan(0);

    // Per-field breakdown carries a changed `content` field.
    const contentField = body.fields.find((f) => f.field === 'content');
    expect(contentField, 'a content field diff is present').toBeTruthy();
    expect(contentField!.changed).toBe(true);
  });

  test('#14 an unknown template id is 404', async ({ request }) => {
    const res = await request.get('/api/v1/admin/prompt-templates/00000000-0000-0000-0000-0000000389ff/versions/1/diff/2', {
      headers: bearer(saGlobalToken),
    });
    expect(res.status()).toBe(404);
  });

  test('#14 RBAC: a plain doctor cannot diff versions on the admin plane (403)', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/prompt-templates/${templateId}/versions/${fromVersion}/diff/${toVersion}`, {
      headers: bearer(doctorToken),
    });
    expect(res.status()).toBe(403);
  });
});
