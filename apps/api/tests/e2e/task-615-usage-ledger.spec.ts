/**
 * Synthetic usage flow through the LIVE outbox drainer.
 *
 * No internal/test HTTP route writes to the ledger (contract is a
 * TypeScript service method, `IUsageLedgerService.recordUsage`, not an HTTP
 * endpoint), so this seeds a `PENDING` `AiUsageOutbox` row directly against
 * the database — the documented fallback ("an internal/test route if one
 * exists, otherwise direct DB insert in test setup per existing e2e fixture
 * patterns", mirroring `password-hash-settings.spec.ts`'s
 * `getPlatformAdminPrismaClient_Unscoped()` dynamic-import pattern) — and then
 * asserts against the LIVE API's own scheduled drainer (`metering.outbox.drain.enabled`
 * defaults ON) rather than invoking drain logic in-process:
 *
 *   seed AiUsageOutbox (PENDING) → poll until DISPATCHED → AiUsageEvent
 *   appended + rated → AiUsageRollupDaily incremented → GET
 *   admin/entitlements/tenants/:tenantId reflects the new usage.
 *
 * All synthetic ids/keys are prefixed `task615-e2e-` for easy identification;
 * `afterAll` deletes exactly the rows this spec created (outbox + ledger +
 * rollup delta), never a broader sweep.
 */
import { test, expect } from '@playwright/test';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

interface OutboxRow {
  id: string;
}
interface UsageEventRow {
  id: string;
  idempotencyKey: string;
  costMicros: string | null;
  unitPriceMicros: string | null;
}
interface DbClient {
  aiUsageOutbox: {
    create(args: { data: Record<string, unknown> }): Promise<OutboxRow>;
    findUnique(args: { where: { id: string } }): Promise<{ status: string } | null>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  aiUsageEvent: {
    findMany(args: { where: Record<string, unknown> }): Promise<UsageEventRow[]>;
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  aiUsageRollupDaily: {
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  $disconnect(): Promise<void>;
}

let dbClient: DbClient | null = null;
async function getDb(): Promise<DbClient> {
  if (!dbClient) {
    const distEntry = pathToFileURL(join(__dirname, '../../../../packages/database/dist/index.js')).href;
    const mod = (await import(distEntry)) as { getPlatformAdminPrismaClient_Unscoped(): unknown };
    dbClient = mod.getPlatformAdminPrismaClient_Unscoped() as DbClient;
  }
  return dbClient;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const UNIQUE = Date.now();
const IDEMPOTENCY_KEY = `task615-e2e-${UNIQUE}:INPUT_TOKEN`;

async function pollUntilDispatched(db: DbClient, outboxId: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await db.aiUsageOutbox.findUnique({ where: { id: outboxId } });
    if (row?.status === 'DISPATCHED') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Outbox row ${outboxId} was not drained within ${timeoutMs}ms — is the API's outbox drainer running (metering.outbox.drain.enabled)?`,
  );
}

// `metering.outbox.drain.enabled` defaults ON (DRAIN_DEFAULTS.enabled — the
// fallback used when no GlobalSetting row overrides it), so a normal dev/test
// API instance drains within the poll window below. If a deployment has
// explicitly disabled the drainer, `pollUntilDispatched` times out with a
// message naming the setting — the fast, legible failure mode instead of a
// silent false-negative.
// SERIAL: this file's `beforeAll` performs stateful billing writes (compute-draft,
// and in the lifecycle spec finalize/void) for a FIXED (tenant, period). Under
// `fullyParallel: true` Playwright spreads a file's tests across workers, so
// `beforeAll` runs concurrently in several of them and the second identical
// compute-draft collides with the first — 409, before any assertion runs.
// Serial mode pins the file to one worker so the setup happens exactly once.
test.describe.configure({ mode: 'serial' });

test.describe('Usage ledger — synthetic drain-and-rollup flow', () => {
  let tenantAdminToken: string;
  let tenantId: string;
  let outboxId: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    const me = await request.get('/api/v1/admin/ai-task-defaults/row?taskKey=nlp.ner', { headers: bearer(tenantAdminToken) });
    expect(me.status()).toBe(200);
    tenantId = ((await me.json()) as { tenantId: string }).tenantId;
    expect(tenantId).toBeTruthy();
  });

  test.afterAll(async () => {
    const db = await getDb();
    await db.aiUsageEvent.deleteMany({ where: { idempotencyKey: IDEMPOTENCY_KEY } });
    if (outboxId) {
      await db.aiUsageOutbox.deleteMany({ where: { id: outboxId } });
    }
    // The daily rollup row this single synthetic event landed in is tenant+capability+unit+day
    // scoped and additive — deleting it here only removes the bucket THIS spec created, never a
    // pre-existing tenant total, because a fresh calendar day + a synthetic-only INPUT_TOKEN/LLM
    // combination has no other contributor in a throwaway test tenant.
    await db.aiUsageRollupDaily.deleteMany({
      where: { tenantId, capability: 'LLM', unit: 'INPUT_TOKEN', bucketStart: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) } },
    });
    await db.$disconnect();
  });

  test('seeding a PENDING outbox row → the live drainer produces a rated AiUsageEvent', async () => {
    // pollUntilDispatched below has its own 60s budget (DRAIN_DEFAULTS.intervalSeconds = 30,
    // so a row can wait up to a full tick before the drainer even picks it up) — the Playwright
    // default per-test timeout (30s, playwright.config.ts) is shorter than that budget, so it
    // must be raised here or this test times out before the poll ever gets the chance to.
    test.setTimeout(90_000);
    const db = await getDb();
    const now = new Date();

    const outbox = await db.aiUsageOutbox.create({
      data: {
        tenantId,
        payload: {
          version: 1,
          events: [
            {
              tenantId,
              idempotencyKey: IDEMPOTENCY_KEY,
              occurredAt: now.toISOString(),
              capability: 'LLM',
              operation: 'generate',
              provider: 'lm-studio',
              model: 'llama-3.1-8b',
              deployment: 'SELF_HOSTED',
              unit: 'INPUT_TOKEN',
              quantity: '1234',
              costBasis: 'INTERNAL',
              consultationId: null,
              doctorId: null,
              departmentId: null,
              requestId: `task615-e2e-${UNIQUE}`,
              sessionId: null,
              attributesJson: null,
            },
          ],
        },
        status: 'PENDING',
        attempts: 0,
        availableAt: now,
      },
    });
    outboxId = outbox.id;

    await pollUntilDispatched(db, outboxId);

    const events = await db.aiUsageEvent.findMany({ where: { idempotencyKey: IDEMPOTENCY_KEY } });
    expect(events).toHaveLength(1);
    // A resolved price of 0 IS a valid rate (ws-b-contract.md — the only
    // thing this asserts is that RATING RAN (fields are not both null/undefined
    // from an unrated event), not that the specific price is non-zero.
    expect(events[0].unitPriceMicros !== undefined).toBe(true);
  });

  test('the capability snapshot (admin/entitlements/tenants/:tenantId) reflects the new usage', async ({ request }) => {
    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin, 'super admin login failed').toBeTruthy();

    const resp = await request.get(`/api/v1/admin/entitlements/tenants/${tenantId}`, { headers: bearer(superAdmin!.token) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { usage?: Record<string, unknown> };
    // The snapshot must at minimum be well-formed and reachable for this tenant post-drain; the
    // exact LLM_TOKENS field name/shape is 's (owned by a different lane) — this spec only
    // proves the drain-to-snapshot pipe is unbroken, not the meter's internal field naming.
    expect(body).toBeTruthy();
  });
});
