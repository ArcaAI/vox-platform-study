/**
 * Cross-tenant probes against `GET /admin/consultations/:id/telemetry`
 * (TASK-999, `ConsultationTelemetryController`).
 *
 * The route aggregates a consultation's AI activity — token counts, models,
 * durations, entity counts and case-note volume. None of that is the
 * consultation's clinical text, but the SHAPE of it is still a disclosure: how
 * many notes a clinician wrote, how long a visit ran, whether a summary was
 * generated at all. A by-id admin read of one tenant's consultation from
 * another tenant's context must therefore answer 404, not 403 and certainly
 * not 200 — the house 404-over-403 posture (`.claude/rules/05-nestjs-api.md`),
 * which hides existence rather than confirming it.
 *
 * Genuine probe, not a synthetic-id probe: a random uuid would only prove the
 * "not found" branch fires when nothing matches, which it would even if the
 * tenant check were missing entirely. This spec probes a consultation that
 * REALLY EXISTS and is owned by another tenant, and keeps the synthetic-id
 * case alongside it purely to prove the two are indistinguishable on the wire.
 *
 * Live-stack requirement: the test API on 8968 plus the seeded test database
 * (`pnpm infra:test:up`, schema push, `RUN_SEED=all` seed).
 */
import { expect, test } from '@playwright/test';

import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Seeded `GEN_COMPLETED` consultation — tenant `__GLOBAL__`
 * (`SEED_CONSULTATION_IDS.GEN_COMPLETED`, `seed/00-constants.ts`).
 */
const GLOBAL_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';

/** uuidv7-shaped id no tenant has ever held — the 404 SHAPE baseline. */
const SYNTHETIC_CONSULTATION_ID = '018f0000-0000-7000-8000-000000000999';

const telemetryPath = (id: string): string => `/api/v1/admin/consultations/${id}/telemetry`;

test.describe('TASK-999 — consultation telemetry cross-tenant probe', () => {
  let globalSuperAdminToken: string;
  let arcaaiSuperAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const globalLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(globalLogin, 'super_admin login (__GLOBAL__) failed').toBeTruthy();
    globalSuperAdminToken = globalLogin!.token;

    // The SAME human, re-logged bound to tenant ARCAAI. Using one identity for
    // both sides is deliberate: it isolates the TENANT as the only variable, so
    // a 404 below cannot be explained away as "that user lacks the ability".
    const arcaaiLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiSuperAdminToken = arcaaiLogin!.token;
  });

  test('the owning tenant resolves the telemetry — sanity for the cross-tenant assertion', async ({ request }) => {
    const response = await request.get(telemetryPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${globalSuperAdminToken}` },
    });

    expect(response.status(), `owning-tenant telemetry read — body: ${await response.text()}`).toBe(200);
    const body = (await response.json()) as { consultationId: string; session: { available: boolean } };
    expect(body.consultationId).toBe(GLOBAL_CONSULTATION_ID);
    // `session` is derived from the consultation row itself, so it is available
    // for any real consultation — a cheap proof this is the genuine resource
    // and not an empty envelope.
    expect(body.session.available).toBe(true);
  });

  test('a different tenant gets 404 — never 403, never 200', async ({ request }) => {
    const response = await request.get(telemetryPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });

    expect(response.status(), `cross-tenant telemetry probe — body: ${await response.text()}`).toBe(404);
  });

  test('a cross-tenant id and an unknown id are indistinguishable on the wire (no existence leak)', async ({ request }) => {
    const crossTenant = await request.get(telemetryPath(GLOBAL_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    const synthetic = await request.get(telemetryPath(SYNTHETIC_CONSULTATION_ID), {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });

    expect(crossTenant.status()).toBe(404);
    expect(synthetic.status()).toBe(404);

    // Same status is not enough: a body that says "not yours" for one and "no
    // such consultation" for the other still discloses which ids exist. Both
    // messages DO echo the requested id — that is not a leak, since it is the
    // caller's own input — so the id is normalised out before comparing and
    // everything else must be identical.
    const shapeOf = async (r: typeof crossTenant, id: string): Promise<unknown> => {
      const body = (await r.json()) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message.split(id).join('<id>') : body.message;
      return { code: body.code, message, statusCode: body.statusCode };
    };
    expect(await shapeOf(crossTenant, GLOBAL_CONSULTATION_ID)).toEqual(await shapeOf(synthetic, SYNTHETIC_CONSULTATION_ID));
  });

  test('an unauthenticated request is rejected before any tenant logic runs', async ({ request }) => {
    const response = await request.get(telemetryPath(GLOBAL_CONSULTATION_ID));

    expect(response.status()).toBe(401);
  });
});
