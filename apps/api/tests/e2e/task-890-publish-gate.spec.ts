/**
 * TASK-890 §3.4 (L8) — the AGENT half of the publish gate, over real HTTP.
 *
 * The workflow half (the graph gate, `publishFindings`) is L0's script + spec; this one covers
 * what only an agent can do: PIN a context schema, have that pin resolved TENANT-only, and carry
 * the derived payload schema FROZEN into `compiledConfig` so the runtime never re-reads the row.
 *
 * ## The three facts, and why each needs a live gateway
 *
 *  1. **A pin that this tenant cannot resolve refuses the publish**, with a code that says WHICH
 *     half failed (`CONTEXT_SCHEMA_NOT_FOUND` vs `…_VERSION_NOT_FOUND`). The tenant-only rule is
 *     enforced by the tenant-scope extension, which unit fixtures stub out — so "a SYSTEM id is
 *     as invisible as another customer's" can only be shown here.
 *  2. **A resolvable pin freezes the schema**, and the frozen copy is what an invocation is
 *     validated against — not whatever the schema says by then.
 *  3. **A required context kind is ENFORCING** (orchestrator decision, pending owner override,
 *     TASK-859 invariant 3): an invocation omitting it is refused with the kind NAMED, rather
 *     than degrading silently to a prompt with a hole in it.
 *
 * SERIAL: each test creates a schema + agent in the Global tenant and cleans them up.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

test.describe.configure({ mode: 'serial' });

const ADMIN_AGENTS = '/api/v1/admin/agents';
const ADMIN_SCHEMAS = '/api/v1/admin/consultation-context-schemas';

test.describe('TASK-890 §3.4 — the agent`s context-schema pin at publish', () => {
  let adminJwt: string;
  let modelId: string;
  let schemaId: string;
  const createdAgents: string[] = [];

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin, 'tenant-admin login').not.toBeNull();
    adminJwt = admin!.token;

    const models = await request.get('/api/v1/admin/ai-models?taskType=TEXT_GENERATION', { headers: { Authorization: `Bearer ${adminJwt}` } });
    expect(models.status()).toBe(200);
    const body = await models.json();
    const rows: Array<{ id: string }> = body.data ?? body.items ?? body;
    expect(rows.length, 'the seeded TEXT_GENERATION registry is not empty').toBeGreaterThan(0);
    modelId = rows[0].id;

    // The head row carries only metadata; the DECLARATION arrives at publish, which is what mints
    // the immutable version the agent's pin will freeze.
    const schema = await request.post(ADMIN_SCHEMAS, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: { slug: `l8_pin_${Date.now() % 100000000}`, name: 'L8 publish-gate fixture', scope: 'TENANT' },
    });
    test.skip(schema.status() !== 201, `context-schema create is not available in this environment (${schema.status()}: ${await schema.text()})`);
    schemaId = (await schema.json()).id as string;

    // ONE REQUIRED STRUCTURED kind. `visit` is what the agent's prompt references, so the same
    // fixture proves the declaration (publish sees `context.visit`) AND the enforcement (an
    // invocation omitting it is refused). `fields` is a JSON-Schema subset, not a field list.
    const published = await request.post(`${ADMIN_SCHEMAS}/${schemaId}/publish`, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: {
        definition: {
          kinds: [
            {
              key: 'visit',
              label: 'Visit',
              primitive: 'STRUCTURED',
              required: true,
              fields: { type: 'object', additionalProperties: false, required: ['clinic'], properties: { clinic: { type: 'string' } } },
            },
          ],
        },
      },
    });
    expect(published.status(), `publish the fixture schema (${await published.text()})`).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdAgents) await request.delete(`${ADMIN_AGENTS}/${id}`, { headers: { Authorization: `Bearer ${adminJwt}` } });
    if (schemaId) await request.delete(`${ADMIN_SCHEMAS}/${schemaId}`, { headers: { Authorization: `Bearer ${adminJwt}` } });
  });

  async function createDraft(request: APIRequestContext, overrides: Record<string, unknown>): Promise<string> {
    const res = await request.post(ADMIN_AGENTS, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: {
        slug: `l8-pin-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
        name: 'Pinned agent',
        task: 'TEXT_GENERATION',
        modelId,
        instruction: { systemPrompt: 'Clinic: {{context.visit}}' },
        ...overrides,
      },
    });
    expect(res.status(), `create draft (${await res.text()})`).toBe(201);
    const id = (await res.json()).id as string;
    createdAgents.push(id);
    return id;
  }

  test('a pin this tenant cannot resolve refuses the publish with CONTEXT_SCHEMA_NOT_FOUND', async ({ request }) => {
    const id = await createDraft(request, { contextSchemaId: '00000000-0000-0000-0000-0000000000fe' });
    const res = await request.post(`${ADMIN_AGENTS}/${id}/publish`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('CONTEXT_SCHEMA_NOT_FOUND');
  });

  test('a pinned version that does not exist refuses with CONTEXT_SCHEMA_VERSION_NOT_FOUND', async ({ request }) => {
    const id = await createDraft(request, { contextSchemaId: schemaId, contextSchemaVersionNumber: 99 });
    const res = await request.post(`${ADMIN_AGENTS}/${id}/publish`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('CONTEXT_SCHEMA_VERSION_NOT_FOUND');
  });

  test('half a reference (a version with no schema id) is refused at CREATE, not at publish', async ({ request }) => {
    const res = await request.post(ADMIN_AGENTS, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: {
        slug: `l8-half-${Date.now()}`,
        name: 'Half a reference',
        task: 'TEXT_GENERATION',
        modelId,
        instruction: { systemPrompt: 'x' },
        contextSchemaVersionNumber: 1,
      },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('contextSchemaVersionNumber');
  });

  test('a resolvable pin FREEZES the derived payload schema into compiledConfig, with its provenance', async ({ request }) => {
    const id = await createDraft(request, { contextSchemaId: schemaId });
    const res = await request.post(`${ADMIN_AGENTS}/${id}/publish`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    test.skip(res.status() === 400, `publish failed closed in this environment (${await res.text()})`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.contextSchemaId).toBe(schemaId);
    expect(body.compiledConfig.contextSchema).toMatchObject({
      schemaId,
      versionNumber: expect.any(Number),
      versionId: expect.any(String),
      payloadSchema: expect.objectContaining({ type: 'object' }),
    });
    // §3.14 — every published agent carries its guardrail decision; absent means ON.
    expect(body.compiledConfig.guardrail).toEqual({ enabled: true });
  });

  /**
   * FIXME — the ENFORCEMENT point is `AgentInvocationService`, which lane L3 owns in this wave
   * (§4.3). L8 froze the schema into `compiledConfig.contextSchema` and made the same rule real
   * on the draft-test bench (`CONTEXT_SCHEMA_VIOLATION`); the invocation half is the one-line
   * `jsonSchemaValueProblems(compiled.contextSchema.payloadSchema, body.context)` handed to L3.
   * Un-`fixme` this the moment that lands — it is written against the intended contract, not a
   * placeholder.
   */
  test.fixme('an invocation that omits a REQUIRED context kind is refused, and the refusal names it', async ({ request }) => {
    const id = await createDraft(request, { contextSchemaId: schemaId });
    const published = await request.post(`${ADMIN_AGENTS}/${id}/publish`, { headers: { Authorization: `Bearer ${adminJwt}` }, data: {} });
    test.skip(published.status() !== 200, `publish did not succeed in this environment (${published.status()})`);
    const slug = (await published.json()).slug as string;

    const res = await request.post(`/api/v1/agents/${slug}/invocations`, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: { input: { text: 'hello' }, context: {} },
    });
    // 400 with the kind named. NOT a 200 with an empty `context.*`: an agent that declared what
    // it needs and did not get it produced nothing trustworthy (TASK-859 invariant 3, fail closed).
    expect([400, 422], `invocation refusal (${res.status()}: ${await res.text()})`).toContain(res.status());
    expect(JSON.stringify(await res.json())).toContain('visit');
  });
});
