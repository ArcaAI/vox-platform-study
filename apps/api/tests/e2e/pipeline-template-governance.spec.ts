/**
 * Pipeline template governance, end to end.
 *
 * What it proves that the unit suites cannot:
 *  - the LOCK survives the full HTTP stack (guards, pipes, interceptors), not
 *    just the service method — including that the 403 body carries the
 *    actionable guidance text a user is meant to read;
 *  - the whitelist pipe really does reject an attempt to flip `templateLocked`
 *    over the wire (unit tests exercise the service, not the global pipe);
 *  - a clone is genuinely editable afterwards — the round trip the whole
 *    feature exists to enable;
 *  - resync is idempotent against a REAL database, where the version-history
 *    consistency check actually reads rows.
 *
 * Live-stack requirement: the dev stack (`pnpm test:api:up`) plus the seed. The
 * seeded tenant catalogs are locked template copies (`asTemplateCopies` in
 * `seed/06-stt.ts`), which is what these probes rely on.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

// Every test in this file reads/mutates the SAME seeded
// template-copy row (`TEMPLATE_SLUG`); under `fullyParallel: true` the toggle
// test's disabled window made concurrent slug reads return empty bodies. Run
// strictly in order.
test.describe.configure({ mode: 'serial' });

/** The refusal text is a product surface — the console renders it verbatim. */
const LOCK_MESSAGE = 'Template copies are read-only — clone to customize';

/**
 * PATCH the house way: the `If-Match` header AND the body's `expectedVersion`.
 *
 * `UpdatePipelineRequest.expectedVersion` is a REQUIRED field, so the global
 * validation pipe rejects a header-only body with 400 BEFORE the controller
 * folds `If-Match` over it — the request never reaches the service, and the
 * lock guard never runs. The admin console's client already sends both
 * (`updatePipeline` in the console api client); a header-only PATCH is simply
 * malformed, so these specs must send both to test what they claim to test.
 */
function patchBody<T extends Record<string, unknown>>(body: T, version: number) {
  return { ...body, expectedVersion: version };
}

/** Seeded SYSTEM template slug every tenant holds a locked copy of. */
const TEMPLATE_SLUG = 'production-whisper-large-v3-turbo-gguf';

async function adminToken(request: Parameters<typeof loginUser>[0]) {
  const session = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(session, 'tenant_admin must be able to log in against the seeded stack').not.toBeNull();
  return session!.token;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

test.describe('locked template copies are read-only', () => {
  test('the tenant catalog exposes locked copies carrying template lineage', async ({ request }) => {
    const token = await adminToken(request);

    const response = await request.get('/api/v1/admin/audio/pipelines', { headers: auth(token) });
    expect(response.status()).toBe(200);

    const pipelines = (await response.json()) as {
      slug: string;
      templateLocked: boolean;
      sourceTemplateSlug: string | null;
    }[];

    const copy = pipelines.find((p) => p.slug === TEMPLATE_SLUG);
    expect(copy, `the seeded catalog must contain ${TEMPLATE_SLUG}`).toBeDefined();
    expect(copy!.templateLocked).toBe(true);
    expect(copy!.sourceTemplateSlug).toBe(TEMPLATE_SLUG);
  });

  test('PATCH on a locked copy is 403 with the clone guidance', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    expect(detail.status()).toBe(200);
    const pipeline = (await detail.json()) as { id: string; version: number };

    const patch = await request.patch(`/api/v1/admin/audio/pipelines/${pipeline.id}`, {
      headers: { ...auth(token), 'If-Match': `"${pipeline.version}"` },
      data: patchBody({ name: 'Renamed by a tenant admin' }, pipeline.version),
    });

    expect(patch.status()).toBe(403);
    expect(JSON.stringify(await patch.json())).toContain(LOCK_MESSAGE);
  });

  test('DELETE on a locked copy is 403 and the row survives', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    const pipeline = (await detail.json()) as { id: string };

    const removed = await request.delete(`/api/v1/admin/audio/pipelines/${pipeline.id}`, { headers: auth(token) });
    expect(removed.status()).toBe(403);

    // Still there — the refusal was not a partial delete.
    const after = await request.get(`/api/v1/admin/audio/pipelines/${pipeline.id}`, { headers: auth(token) });
    expect(after.status()).toBe(200);
  });

  // The lock is about CONTENT. A tenant still owns its copy's lifecycle.
  test('toggle and set-default still work on a locked copy', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    const pipeline = (await detail.json()) as { id: string; version: number };

    const disabled = await request.patch(`/api/v1/admin/audio/pipelines/${pipeline.id}/toggle`, {
      headers: { ...auth(token), 'If-Match': `"${pipeline.version}"` },
      data: { enabled: false },
    });
    expect(disabled.status()).toBe(200);

    // Restore: re-read for the bumped version, then flip back.
    const reread = await request.get(`/api/v1/admin/audio/pipelines/${pipeline.id}`, { headers: auth(token) });
    const current = (await reread.json()) as { version: number };
    const reEnabled = await request.patch(`/api/v1/admin/audio/pipelines/${pipeline.id}/toggle`, {
      headers: { ...auth(token), 'If-Match': `"${current.version}"` },
      data: { enabled: true },
    });
    expect(reEnabled.status()).toBe(200);

    const setDefault = await request.post(`/api/v1/admin/audio/pipelines/${pipeline.id}/set-default`, {
      headers: auth(token),
    });
    expect(setDefault.status()).toBe(200);
  });

  // The lock must not be liftable over the API: `templateLocked` is on no
  // request DTO, so the global pipe's forbidNonWhitelisted rejects it.
  test('an attempt to unlock via PATCH is rejected by the validation pipe', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    const pipeline = (await detail.json()) as { id: string; version: number };

    const patch = await request.patch(`/api/v1/admin/audio/pipelines/${pipeline.id}`, {
      // Every REQUIRED field is supplied, so the only thing wrong with this
      // body is the smuggled `templateLocked` — the 400 can therefore only be
      // the whitelist rejecting it.
      headers: { ...auth(token), 'If-Match': `"${pipeline.version}"` },
      data: patchBody({ templateLocked: false }, pipeline.version),
    });

    // 400 from the pipe (unknown field) — never 200.
    expect(patch.status()).toBe(400);
  });
});

test.describe('clone is the customization path', () => {
  test('cloning a locked copy yields an editable pipeline with lineage and a v1 snapshot', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    expect(detail.status(), 'seeded template copy must be readable by slug').toBe(200);
    const source = (await detail.json()) as { id: string; configYaml: string };

    const slug = `task-531-clone-${Date.now()}`;
    const created = await request.post(`/api/v1/admin/audio/pipelines/${source.id}/clone`, {
      headers: auth(token),
      data: { name: 'TASK-531 clone', slug },
    });
    expect(created.status()).toBe(201);

    const clone = (await created.json()) as {
      id: string;
      slug: string;
      configYaml: string;
      templateLocked: boolean;
      sourceTemplateSlug: string | null;
      version: number;
    };
    expect(clone.templateLocked).toBe(false);
    expect(clone.sourceTemplateSlug).toBe(TEMPLATE_SLUG);
    expect(clone.configYaml).toBe(source.configYaml);

    // The clone starts with its own v1 history.
    const versions = await request.get(`/api/v1/admin/audio/pipelines/${clone.id}/versions`, { headers: auth(token) });
    expect(versions.status()).toBe(200);
    expect(((await versions.json()) as unknown[]).length).toBeGreaterThanOrEqual(1);

    // And — the whole point — it is editable.
    const edited = await request.patch(`/api/v1/admin/audio/pipelines/${clone.id}`, {
      headers: { ...auth(token), 'If-Match': `"${clone.version}"` },
      data: patchBody({ name: 'TASK-531 clone (edited)' }, clone.version),
    });
    expect(edited.status()).toBe(200);

    // Cleanup: an unlocked row deletes normally.
    const removed = await request.delete(`/api/v1/admin/audio/pipelines/${clone.id}`, { headers: auth(token) });
    expect(removed.status()).toBe(200);
  });

  test('a duplicate slug is rejected with 400', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    expect(detail.status(), 'seeded template copy must be readable by slug').toBe(200);
    const source = (await detail.json()) as { id: string; slug: string };

    const conflict = await request.post(`/api/v1/admin/audio/pipelines/${source.id}/clone`, {
      headers: auth(token),
      data: { name: 'Duplicate', slug: source.slug },
    });
    expect(conflict.status()).toBe(400);
  });

  test('the clone body is whitelist-only', async ({ request }) => {
    const token = await adminToken(request);

    const detail = await request.get(`/api/v1/admin/audio/pipelines/slug/${TEMPLATE_SLUG}`, { headers: auth(token) });
    const source = (await detail.json()) as { id: string };

    const rejected = await request.post(`/api/v1/admin/audio/pipelines/${source.id}/clone`, {
      headers: auth(token),
      data: { name: 'X', slug: `task-531-reject-${Date.now()}`, templateLocked: true },
    });
    expect(rejected.status()).toBe(400);
  });
});

test.describe('resync reconciles an existing tenant', () => {
  test('a super admin can resync, and re-running is a no-op', async ({ request }) => {
    const session = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(session).not.toBeNull();
    const token = session!.token;

    const tenants = await request.get('/api/v1/admin/tenants', { headers: auth(token) });
    expect(tenants.status()).toBe(200);
    const body = (await tenants.json()) as { data: { id: string; key: string }[] };
    const target = body.data.find((t) => t.key === DEFAULT_TENANT_KEY);
    expect(target, 'the seeded global tenant must exist').toBeDefined();

    const first = await request.post(`/api/v1/admin/tenants/${target!.id}/pipelines/resync`, { headers: auth(token) });
    expect(first.status()).toBe(200);
    const firstSummary = (await first.json()) as { added: number; fastForwarded: number; skipped: number };
    expect(firstSummary).toMatchObject({
      added: expect.any(Number),
      fastForwarded: expect.any(Number),
      skipped: expect.any(Number),
    });

    // Idempotency: the second run changes nothing.
    const second = await request.post(`/api/v1/admin/tenants/${target!.id}/pipelines/resync`, { headers: auth(token) });
    expect(second.status()).toBe(200);
    const secondSummary = (await second.json()) as { added: number; fastForwarded: number };
    expect(secondSummary.added).toBe(0);
    expect(secondSummary.fastForwarded).toBe(0);
  });

  test('a tenant admin cannot resync (manage:Tenant is super-admin only)', async ({ request }) => {
    const token = await adminToken(request);

    const denied = await request.post('/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000/pipelines/resync', {
      headers: auth(token),
    });
    expect([401, 403, 404]).toContain(denied.status());
  });
});
