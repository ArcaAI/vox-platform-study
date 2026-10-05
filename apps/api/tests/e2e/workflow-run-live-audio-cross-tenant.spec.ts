/**
 * TASK-1042 (owner decision OD-37) — a live STT session bound to a STANDALONE workflow run on the
 * business plane: `POST /workflows/:slug/runs` with `input.<audioField>.sttSessionId`.
 *
 * Wire-visible contract (ticket README §3.5, C1 / C3 / C8):
 *  - the session must be the STARTING CREDENTIAL's (OD-2 / OD-35 principal): another key bound to
 *    the SAME human, or a session of another tenant, answers the house 404 — the same body as an
 *    unknown session (404-over-403);
 *  - an ended session is 409 `RUN_AUDIO_SESSION_NOT_LIVE`; a session already bound to another run
 *    is 409 `RUN_AUDIO_SESSION_BOUND_ELSEWHERE`; a retry with the same Idempotency-Key joins the run
 *    it already bound (no second binding);
 *  - `sttSessionId` on a non-stream key is 400 `RUN_AUDIO_INPUT_UNDECLARED`; a workflow whose
 *    settings lack `socket` is 400 `LIVE_AUDIO_UNSUPPORTED`;
 *  - session create refuses `workflowSlug` + `consultationId` together (400
 *    `STREAM_SESSION_TARGET_CONFLICT`).
 *
 * Fixture: the spec AUTHORS its own context schema (a stream-audio `mic` kind and a text `note`
 * kind) and two workflows in the seeded default tenant — `socket` on and off — each a
 * trigger → `realtime-transcription` STT agent → output chain. Cases that need a live session SKIP
 * with an explicit reason when the STT service is unavailable (the `stt-session-cross-tenant`
 * convention). Prerequisites: API on the test DB (`pnpm test:up:api`), seeded.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  DEFAULT_TENANT_KEY,
  SEEDED_SERVICE_ACCOUNT_CLIENT_ID,
  SEEDED_SERVICE_ACCOUNT_CLIENT_SECRET,
  SEEDED_USERS,
  loginUser,
} from '../../../../tests/helpers';

const STT_AGENT_SLUG = 'realtime-transcription';
const SYNTHETIC_SESSION_ID = '018f0000-0000-7450-8000-0000000010a2';
const SESSION_ROUTE = '/api/v1/audio/transcription-jobs/stream/session';
const RUN_SCOPES = ['workflow:definition:read', 'workflow:run:write', 'workflow:run:read', 'stt:transcription:write'];

interface CreatedApiKey {
  id: string;
  rawKey: string;
}

const stamp = () => randomUUID().replace(/-/g, '').slice(0, 16);

/** `connections: null` = a LEGACY graph with no `settings` (publish then only WARNS on WF-SET-003/005). */
function chainGraph(schemaId: string, connections: string[] | null) {
  return {
    version: 1,
    ...(connections ? { settings: { connections, sources: [], contextSchema: { contextSchemaId: schemaId, versionNumber: null } } } : {}),
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'], contextSchema: { contextSchemaId: schemaId } } },
      {
        id: 'n_asr',
        type: 'core.agent',
        config: { agentRef: { slug: STT_AGENT_SLUG }, inputs: { audio: { from: 'context.mic' } }, onError: 'degrade' },
      },
      { id: 'n_out', type: 'core.output', config: { protocols: ['http'] } },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_asr', toPort: 'after' },
      { id: 'e2', from: 'n_asr', fromPort: 'next', to: 'n_out', toPort: 'after' },
    ],
  };
}

test.describe('TASK-1042 — live audio bound to a standalone workflow run', () => {
  // ONE fixture (schema + two workflows) for the whole file: `beforeAll` runs per worker otherwise.
  test.describe.configure({ mode: 'serial' });

  let adminToken: string;
  let schemaId: string | null = null;
  let socketSlug: string | null = null;
  let noSocketSlug: string | null = null;
  let fixtureProblem = '';
  const definitionIds: string[] = [];
  const keyIds: string[] = [];
  const sessions: Array<{ id: string; headers: Record<string, string> }> = [];

  const admin = () => ({ Authorization: `Bearer ${adminToken}` });

  async function key(request: APIRequestContext, name: string): Promise<CreatedApiKey> {
    const response = await request.post('/api/v1/admin/api-keys', {
      headers: admin(),
      data: { keyName: `t1042-${name}-${Date.now()}`, keyType: 'SDK', scopes: RUN_SCOPES },
    });
    expect(response.status(), `API key creation failed for ${name}: ${await response.text()}`).toBe(201);
    const body = await response.json();
    keyIds.push(body.apiKey.id);
    return { id: body.apiKey.id, rawKey: body.rawKey };
  }

  async function publishWorkflow(request: APIRequestContext, connections: string[] | null): Promise<string | null> {
    const slug = `t1042_${connections ? connections.join('_') : 'legacy'}_${stamp()}`;
    const created = await request.post('/api/v1/admin/workflow-definitions', {
      headers: admin(),
      data: {
        slug,
        name: `TASK-1042 ${connections ? connections.join('+') : 'legacy'}`,
        paletteKey: 'core',
        graph: chainGraph(schemaId as string, connections),
      },
    });
    if (created.status() !== 201) {
      fixtureProblem = `workflow create ${created.status()}: ${(await created.text()).slice(0, 300)}`;
      return null;
    }
    const id = (await created.json()).id as string;
    definitionIds.push(id);
    const published = await request.post(`/api/v1/admin/workflow-definitions/${id}/publish`, { headers: admin(), data: {} });
    if (published.status() !== 200) {
      fixtureProblem = `workflow publish ${published.status()}: ${(await published.text()).slice(0, 300)}`;
      return null;
    }
    return slug;
  }

  /** A live STT session owned by `headers`' credential, bound to `workflowSlug`; null when STT is down. */
  async function openSession(
    request: APIRequestContext,
    headers: Record<string, string>,
    workflowSlug: string,
  ): Promise<{ id: string | null; why: string }> {
    const response = await request.post(SESSION_ROUTE, { headers, data: { workflowSlug } });
    if (response.status() !== 201) return { id: null, why: `POST stream/session → ${response.status()}: ${(await response.text()).slice(0, 200)}` };
    const id = (await response.json()).sessionId as string;
    sessions.push({ id, headers });
    return { id, why: '' };
  }

  function startRun(
    request: APIRequestContext,
    slug: string,
    headers: Record<string, string>,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return request.post(`/api/v1/workflows/${slug}/runs`, {
      headers: { ...headers, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      data: { input },
    });
  }

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(login?.token, 'tenant admin login failed').toBeTruthy();
    adminToken = login!.token as string;

    const agents = await request.get('/api/v1/admin/agents?task=SPEECH_TO_TEXT', { headers: admin() });
    if (agents.status() !== 200 || !(await agents.text()).includes(STT_AGENT_SLUG)) {
      fixtureProblem = `no published '${STT_AGENT_SLUG}' agent in the default tenant (${agents.status()})`;
      return;
    }

    const schema = await request.post('/api/v1/admin/consultation-context-schemas', {
      headers: admin(),
      data: { slug: `t1042_audio_${stamp()}`, name: 'TASK-1042 live audio fixture', scope: 'TENANT' },
    });
    if (schema.status() !== 201) {
      fixtureProblem = `context-schema create ${schema.status()}: ${(await schema.text()).slice(0, 300)}`;
      return;
    }
    schemaId = (await schema.json()).id as string;
    const published = await request.post(`/api/v1/admin/consultation-context-schemas/${schemaId}/publish`, {
      headers: admin(),
      data: {
        definition: {
          schemaVersion: '1.0',
          kinds: [
            {
              key: 'mic',
              label: 'Mic',
              primitive: 'STREAM_AUDIO',
              delivery: 'stream',
              phiClass: 'PHI',
              cardinality: 'ONE',
              lifecycle: 'DURING',
              producedBy: ['CLIENT'],
            },
            { key: 'note', label: 'Note', primitive: 'TEXT', phiClass: 'PHI', cardinality: 'ONE', lifecycle: 'PRE', producedBy: ['CLIENT'] },
          ],
        },
      },
    });
    if (![200, 201].includes(published.status())) {
      fixtureProblem = `context-schema publish ${published.status()}: ${(await published.text()).slice(0, 300)}`;
      return;
    }
    socketSlug = await publishWorkflow(request, ['api', 'socket']);
    // A workflow that DECLARES settings without `socket` cannot publish a stream-audio Input (WF-SET-003
    // ERROR), so the refusal is reached through a legacy definition with no settings at all.
    if (socketSlug) noSocketSlug = await publishWorkflow(request, null);
  });

  test.afterAll(async ({ request }) => {
    for (const session of sessions) {
      await request.delete(`${SESSION_ROUTE}/${session.id}`, { headers: session.headers }).catch(() => {});
    }
    for (const id of definitionIds) {
      await request.delete(`/api/v1/admin/workflow-definitions/${id}`, { headers: admin() }).catch(() => {});
    }
    if (schemaId) await request.delete(`/api/v1/admin/consultation-context-schemas/${schemaId}`, { headers: admin() }).catch(() => {});
    for (const id of keyIds) {
      await request.delete(`/api/v1/admin/api-keys/${id}`, { headers: admin() }).catch(() => {});
    }
  });

  test.describe('without a live STT service', () => {
    test('an unknown session is the house 404', async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'unknown');
      const response = await startRun(request, socketSlug!, { 'X-API-Key': keyA.rawKey }, { mic: { sttSessionId: SYNTHETIC_SESSION_ID } });
      expect(response.status(), await response.text()).toBe(404);
    });

    test('sttSessionId on a non-stream key is 400 RUN_AUDIO_INPUT_UNDECLARED', async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'undeclared');
      const response = await startRun(request, socketSlug!, { 'X-API-Key': keyA.rawKey }, { note: { sttSessionId: SYNTHETIC_SESSION_ID } });
      expect(response.status(), await response.text()).toBe(400);
      expect((await response.json()).code).toBe('RUN_AUDIO_INPUT_UNDECLARED');
    });

    test('a legacy workflow (no settings, so no socket connection) is 400 LIVE_AUDIO_UNSUPPORTED', async ({ request }) => {
      test.skip(!noSocketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'nosocket');
      const response = await startRun(request, noSocketSlug!, { 'X-API-Key': keyA.rawKey }, { mic: { sttSessionId: SYNTHETIC_SESSION_ID } });
      expect(response.status(), await response.text()).toBe(400);
      expect((await response.json()).code).toBe('LIVE_AUDIO_UNSUPPORTED');
    });

    test('session create refuses workflowSlug together with consultationId (400 STREAM_SESSION_TARGET_CONFLICT)', async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'conflict');
      const response = await request.post(SESSION_ROUTE, {
        headers: { 'X-API-Key': keyA.rawKey },
        data: { workflowSlug: socketSlug, consultationId: '018f0000-0000-7450-8000-0000000010a3' },
      });
      expect(response.status(), await response.text()).toBe(400);
      expect((await response.json()).code).toBe('STREAM_SESSION_TARGET_CONFLICT');
    });
  });

  test.describe('with a live STT session', () => {
    test('another key of the SAME human gets the 404 an unknown session gets', async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'owner');
      const keyB = await key(request, 'colleague');
      const session = await openSession(request, { 'X-API-Key': keyA.rawKey }, socketSlug!);
      test.skip(!session.id, `streaming session unavailable (is STT running?): ${session.why}`);

      const asB = await startRun(request, socketSlug!, { 'X-API-Key': keyB.rawKey }, { mic: { sttSessionId: session.id } });
      const unknown = await startRun(request, socketSlug!, { 'X-API-Key': keyB.rawKey }, { mic: { sttSessionId: SYNTHETIC_SESSION_ID } });
      expect(asB.status(), await asB.text()).toBe(404);
      expect((await asB.json()).message, 'indistinguishable from an unknown session').toBe((await unknown.json()).message);
    });

    test("another tenant's session is 404", async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const exchanged = await request.post('/api/v1/auth/service-token', {
        data: { clientId: SEEDED_SERVICE_ACCOUNT_CLIENT_ID, clientSecret: SEEDED_SERVICE_ACCOUNT_CLIENT_SECRET },
      });
      test.skip(exchanged.status() !== 200, `service-account exchange unavailable (${exchanged.status()})`);
      const saHeaders = { 'X-Service-Account-Token': (await exchanged.json()).accessToken as string };
      // The service account is bound to the ArcaAI tenant; its session is opened with no workflow.
      const response = await request.post(SESSION_ROUTE, { headers: saHeaders, data: {} });
      test.skip(response.status() !== 201, `streaming session unavailable (is STT running?): ${response.status()}`);
      const foreignSessionId = (await response.json()).sessionId as string;
      sessions.push({ id: foreignSessionId, headers: saHeaders });

      const keyA = await key(request, 'xtenant');
      const asA = await startRun(request, socketSlug!, { 'X-API-Key': keyA.rawKey }, { mic: { sttSessionId: foreignSessionId } });
      expect(asA.status(), await asA.text()).toBe(404);
    });

    test('the owner binds once: a retry joins the same run; a second run is 409 RUN_AUDIO_SESSION_BOUND_ELSEWHERE', async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'bind');
      const headers = { 'X-API-Key': keyA.rawKey };
      const session = await openSession(request, headers, socketSlug!);
      test.skip(!session.id, `streaming session unavailable (is STT running?): ${session.why}`);

      const idem = `t1042-${stamp()}`;
      const first = await startRun(request, socketSlug!, headers, { mic: { sttSessionId: session.id } }, idem);
      expect(first.status(), await first.text()).toBe(202);
      const { runId } = (await first.json()) as { runId: string };

      const retry = await startRun(request, socketSlug!, headers, { mic: { sttSessionId: session.id } }, idem);
      expect([200, 202]).toContain(retry.status());
      expect(((await retry.json()) as { runId: string }).runId, 'the retry joins the bound run').toBe(runId);

      const second = await startRun(request, socketSlug!, headers, { mic: { sttSessionId: session.id } }, `${idem}-other`);
      expect(second.status(), await second.text()).toBe(409);
      expect((await second.json()).code).toBe('RUN_AUDIO_SESSION_BOUND_ELSEWHERE');

      // Ending the audio never cancels the run: after close, the run is still readable by its starter.
      await request.delete(`${SESSION_ROUTE}/${session.id}`, { headers });
      expect((await request.get(`/api/v1/workflows/${socketSlug}/runs/${runId}`, { headers })).status()).toBe(200);
    });

    test('an ended session is 409 RUN_AUDIO_SESSION_NOT_LIVE', async ({ request }) => {
      test.skip(!socketSlug, `fixture unavailable: ${fixtureProblem}`);
      const keyA = await key(request, 'ended');
      const headers = { 'X-API-Key': keyA.rawKey };
      const session = await openSession(request, headers, socketSlug!);
      test.skip(!session.id, `streaming session unavailable (is STT running?): ${session.why}`);
      const closed = await request.delete(`${SESSION_ROUTE}/${session.id}`, { headers });
      expect([200, 202, 204]).toContain(closed.status());

      const response = await startRun(request, socketSlug!, headers, { mic: { sttSessionId: session.id } });
      expect(response.status(), await response.text()).toBe(409);
      expect((await response.json()).code).toBe('RUN_AUDIO_SESSION_NOT_LIVE');
    });
  });
});
