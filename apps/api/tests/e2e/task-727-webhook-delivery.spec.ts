/**
 * TASK-727 — end-to-end webhook delivery against a real receiver.
 *
 * Exercises the full path this ticket built, live: `Webhook` create
 * (server-generated secret) → a real mutation (`POST admin/departments`)
 * fires a `SysEvent` → `WebhookDeliveryProcessor` (`@Processor(JobQueue.SysEvent)`)
 * matches the subscription → `WebhookDeliveryDispatchProcessor`
 * (`@Processor(JobQueue.WebhookDelivery)`) signs and POSTs to this spec's own
 * in-process HTTP receiver → the attempt lands in `WebhookRunHistory`,
 * readable via the pre-existing `GET admin/webhooks/:id/deliveries`.
 *
 * Asserts, per the assignment:
 *   (a) the receiver got exactly one POST for the triggering mutation;
 *   (b) the `X-Hope-Webhook-Signature` header verifies against the RAW
 *       secret returned once at creation time (never the stored/encrypted
 *       form — proves the platform can actually recover and sign with it);
 *   (c) the payload carries no PHI/resource content — only ids + `fetchUrl`
 *       (the reference-not-content contract, §3 of the ticket);
 *   (d) calling `fetchUrl` with the test's own bearer token returns the real
 *       resource — proves the reference is actually usable, not just
 *       theoretically safe.
 *
 * In-process receiver pattern follows `byo-llm-credentials.spec.ts`
 * (`http.createServer`), simplified: unlike that spec's `TEXT_URL` (resolved
 * ONCE at gateway bootstrap, so it needs an env-gated fixed port), a
 * `Webhook.url` is read fresh on every delivery attempt, so this spec can
 * bind an ephemeral port with no env gating and no gateway restart.
 *
 * NOT YET EXECUTED — see the ticket README §7: `pnpm test:e2e`'s
 * `globalSetup` runs `prisma db push --force-reset`, which Prisma's CLI
 * refuses when invoked by an AI agent in this environment. This spec is
 * authored and Playwright-listable; it has not been run.
 */
import { test, expect } from '@playwright/test';
import * as http from 'node:http';
import { createHmac } from 'node:crypto';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const WEBHOOKS = '/api/v1/admin/webhooks';
const DEPARTMENTS = '/api/v1/admin/departments';

interface ReceivedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface CreateWebhookResponse {
  webhook: { id: string; url: string; version: number; hasSecret: boolean; [key: string]: unknown };
  rawSecret: string;
}

interface DeliveryRow {
  id: string;
  status: 'SUCCESS' | 'FAILED' | 'DEAD_LETTERED';
  responeStatusCode: number | null;
  response: Record<string, unknown> | null;
}

// SERIAL: this file's `beforeAll` performs stateful writes (opening consultations,
// generating summaries, registering rows) that later tests read back by id.
// Under `fullyParallel: true` Playwright spreads one file's tests across workers,
// so `beforeAll` re-runs concurrently and those setups race each other — the
// symptom is failures that vanish under `--workers=1`. Pin the file to one worker.
test.describe.configure({ mode: 'serial' });

test.describe('webhook delivery — end to end (TASK-727)', () => {
  let token: string;
  let receiver: http.Server;
  let receiverPort: number;
  const received: ReceivedRequest[] = [];

  let webhookId: string;
  let rawSecret: string;
  let deptId: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant_admin login failed — is the stack seeded?').toBeTruthy();
    token = admin!.token;

    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      // Ephemeral port — this receiver's address is passed directly as
      // `Webhook.url`, never resolved by the gateway at its own bootstrap.
      receiver.listen(0, '127.0.0.1', () => resolve());
    });
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('receiver failed to bind a port');
    receiverPort = address.port;
  });

  test.afterAll(async ({ request }) => {
    if (deptId) {
      const del = await request.delete(`${DEPARTMENTS}/${deptId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (![200, 204].includes(del.status())) console.warn(`[task-727] department cleanup ${del.status()}`);
    }
    if (webhookId) {
      const del = await request.delete(`${WEBHOOKS}/${webhookId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (![200, 204].includes(del.status())) console.warn(`[task-727] webhook cleanup ${del.status()}`);
    }
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  test('a Department create fires a signed, reference-only POST to the subscribed webhook', async ({ request }) => {
    // 1. Subscribe to Department mutations, pointed at this spec's receiver.
    const create = await request.post(WEBHOOKS, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `e2e-727-webhook-${Date.now()}`,
        url: `http://127.0.0.1:${receiverPort}/hook`,
        resourceTypeName: 'Department',
      },
    });
    expect(create.status(), 'webhook create').toBe(201);
    const createBody = (await create.json()) as CreateWebhookResponse;
    webhookId = createBody.webhook.id;
    rawSecret = createBody.rawSecret;
    expect(rawSecret).toMatch(/^[0-9a-f]{64}$/);

    // 2. Trigger the mutation — the cheapest resource to create for this fixture set.
    const stamp = Date.now().toString(36);
    const deptCreate = await request.post(DEPARTMENTS, {
      headers: { Authorization: `Bearer ${token}` },
      data: { code: `T727-${stamp}`.slice(0, 20), name: `TASK-727 Dept ${stamp}`, defaultSummaryTemplate: 'SOAP' },
    });
    expect([200, 201], `department create → ${deptCreate.status()}`).toContain(deptCreate.status());
    const dept = (await deptCreate.json()) as { id: string };
    deptId = dept.id;

    // 3. Poll the delivery log until a SUCCESS row lands (async BullMQ fan-out + dispatch).
    let delivery: DeliveryRow | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !delivery) {
      const list = await request.get(`${WEBHOOKS}/${webhookId}/deliveries`, { headers: { Authorization: `Bearer ${token}` } });
      expect(list.status()).toBe(200);
      const body = (await list.json()) as { data: DeliveryRow[] };
      delivery = body.data.find((row) => row.status === 'SUCCESS');
      if (!delivery) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(delivery, 'no SUCCESS delivery row appeared within 20s').toBeTruthy();
    expect(delivery!.responeStatusCode).toBe(200);

    // (a) the receiver got exactly one POST.
    expect(received.length, 'receiver POST count').toBe(1);
    const [req] = received;

    // (b) the signature verifies against the RAW secret returned at creation.
    const signatureHeader = req.headers['x-hope-webhook-signature'];
    expect(signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expectedSignature = `sha256=${createHmac('sha256', rawSecret).update(req.body).digest('hex')}`;
    expect(signatureHeader).toBe(expectedSignature);

    // (c) reference-not-content: only ids + fetchUrl, never resource content.
    const payload = JSON.parse(req.body) as {
      eventType: string;
      resourceType: string;
      resourceId: string;
      tenantId: string;
      occurredAt: string;
      fetchUrl: string;
    };
    expect(payload.resourceType).toBe('Department');
    expect(payload.resourceId).toBe(deptId);
    expect(Object.keys(payload).sort()).toEqual(['eventType', 'fetchUrl', 'occurredAt', 'resourceId', 'resourceType', 'tenantId']);
    expect(payload.fetchUrl).toContain(`/departments/${deptId}`);

    // (d) fetchUrl is actually usable: the SAME bearer token resolves the real resource.
    const fetched = await request.get(payload.fetchUrl, { headers: { Authorization: `Bearer ${token}` } });
    expect(fetched.status(), 'fetchUrl round-trip').toBe(200);
    const fetchedDept = (await fetched.json()) as { id: string; name: string };
    expect(fetchedDept.id).toBe(deptId);
  });
});
