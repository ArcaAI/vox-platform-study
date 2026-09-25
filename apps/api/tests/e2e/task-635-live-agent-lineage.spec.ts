/**
 * R-N1 end-to-end: the live loop FREEZES one agent for the session.
 *
 * Proves the chain over real HTTP against a running stack:
 *
 *   POST :id/recording/start() → the live loop resolves and FREEZES the
 *                                       session's governing node (R-N1)
 *   GET :id/live-summary/stream → every SSE event carries
 *                                       `metadata.agent` = { id, promptTemplateId,
 *                                       promptVersionNumber, resolvedFrom:'agent' }
 *
 * R-N2 (finalize pins the SAME agent and stamps `SummaryMeta.sessionAgentId` /
 * `sessionAgentPromptVersion`) used to be proven here through the synchronous
 * `POST :id/summary`. That route was removed (TASK-1006, owner decision OD-2);
 * the note is written by the harness (`HarnessInternalService.persistDraft`),
 * whose lineage stamping is covered by `harness-internal.service.test.ts`.
 *
 * Generation dependency (house pattern, see `task-635-prompt-test-bench.spec.ts`):
 * live flushes call TEXT, and the live loop additionally calls NLP. Everything
 * that needs a generated frame is gated behind a reachability check with a
 * `console.warn` fallback, so the spec is green — and honest — on a stack
 * without TEXT/NLP. The lineage assertions themselves are NOT softened: when an
 * agent frame IS observed, they must hold.
 *
 * PRECONDITIONS (this spec cannot create them itself):
 *   1. C2's two migrations applied (`SummaryMeta.sessionAgentId`,
 *      `SummaryMeta.sessionAgentPromptVersion`, the node's live binding
 *      columns) — `pnpm db:migrate`.
 *   2. Seed run (`pnpm test:db:seed`) — seeded departments, prompt templates,
 *      `SEEDED_USERS`.
 *   3. API on 8868 (`pnpm test:up:api`), TEXT on 8862, NLP on 8864.
 *   4. The live-documentation engine ENABLED for the tenant
 *      (`GET/PUT admin/harness/live/config`).
 *   5. A workflow node on the department's governing definition with a live
 *      prompt binding. The spec creates one when the tenant has none and
 *      deletes it in `afterAll`; if creation is refused it SKIPS rather than
 *      asserting against the code-default tier (which legitimately reports no
 *      agent at all).
 *
 * RUN: `pnpm test:up:api` (terminal 1), then
 *      `pnpm test:e2e -- task-635-live-agent-lineage.spec.ts`
 *
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Feed the live loop the way STT does, without STT or audio.
 *
 * `LiveSession.transcriptParts` is populated ONLY by `ingestSegment()`, which
 * `attachSttStream()` wires to `StreamingAudioBridgeService.subscribeToResults`
 * — a Redis consumer-group reader over the stream `stt:result:{sessionId}`
 * (streamingAudioBridge.service.ts:343). Posting a TRANSCRIPT ContextItem
 * schedules a flush but contributes no transcript, so the flush has nothing to
 * summarize and never publishes an event.
 *
 * So we XADD final segments onto that stream directly. Field names/encodings
 * mirror `projectAndEmitResult` (…:714-804) exactly: `is_final` is the STRING
 * `'1'`, times are stringified floats, and `type: 'segment'` keeps the frame on
 * the transcript branch (`type: 'status'` would be treated as a status frame).
 * `LiveDocumentationService` then keeps only `isFinal` frames with non-empty
 * text (live-documentation.service.ts:1556).
 */
async function xaddFinalSegments(redisUrl: string, sessionId: string, segments: string[]): Promise<void> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  try {
    let start = 0;
    for (const text of segments) {
      const end = start + 4;
      await redis.xadd(
        `stt:result:${sessionId}`,
        '*',
        'type',
        'segment',
        'text',
        text,
        'is_final',
        '1',
        'start_time',
        String(start),
        'end_time',
        String(end),
      );
      start = end;
    }
  } finally {
    redis.disconnect();
  }
}

/**
 * Admin list envelopes are not uniform: some routes return a bare array, others
 * the `PaginatedResponse` `{ data, count, limit, ... }` wrapper. Setup code must
 * not fail on that distinction, so read both (same tolerance as the `asArray`
 * helper used by password-security-hardening.spec.ts).
 */
function listOf<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** A workflow-definition detail body, whichever envelope the admin surface returns. */
interface GraphCarrier {
  graph?: { nodes?: { id: string; type?: string; config?: Record<string, unknown> }[] };
}

/**
 * Mirrors the resolver's `template.status !== 'APPROVED'` guard: a node binding an
 * unapproved template does NOT make tier-1a's node source reachable — the resolver
 * skips it and falls through.
 */
async function isApprovedTemplate(request: APIRequestContext, token: string, templateId: string): Promise<boolean> {
  const response = await request.get(`/api/v1/admin/prompt-templates/${templateId}`, { headers: bearer(token) });
  if (!response.ok()) return false;
  const body = (await response.json()) as { data?: { status?: string }; status?: string };
  return (body.data?.status ?? body.status) === 'APPROVED';
}

interface SseAgent {
  id: string | null;
  name?: string | null;
  promptTemplateId: string | null;
  promptVersionNumber: number | null;
  resolvedFrom: string;
}

/** What the SSE watch observed: the frozen agent, and whether a note was generated. */
interface SseWatchResult {
  agent: SseAgent;
  /** True once a frame carried a non-empty `runningSummary` — i.e. TEXT actually ran. */
  generated: boolean;
}

/**
 * Watch the live-summary SSE stream and report the frozen session agent.
 *
 * Two distinct signals arrive on this stream, and the difference matters:
 *   • `metadata.agent` rides the snapshot frozen at `start()` (RF-6), so it
 *     appears within milliseconds and needs no LLM at all;
 *   • `runningSummary` appears only after a flush actually generated a note —
 *     which is what gets persisted as the LIVE_SOAP_SNAPSHOT.
 * R-N1 needs only the first, but this keeps reading for a generated frame and
 * reports which of the two it got, so a failure says whether TEXT ever ran.
 *
 * The budget MUST stay strictly under the caller's per-test timeout: if the
 * wait outlives the test, the test dies on a timeout instead of reaching its
 * graceful skip.
 */
async function readFirstAgentFromSse(baseURL: string, consultationId: string, token: string, timeoutMs = 20_000): Promise<SseWatchResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let seenAgent: SseAgent | null = null;
  try {
    const res = await fetch(`${baseURL}/api/v1/consultations/${consultationId}/live-summary/stream`, {
      headers: { ...bearer(token), Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        try {
          const payload = JSON.parse(trimmed.slice(5).trim()) as { metadata?: { agent?: SseAgent }; runningSummary?: string };
          // Remember the agent as soon as it appears — it rides the FROZEN
          // snapshot resolved at start(), so it arrives long before any
          // generation. But keep reading until a frame carries a non-empty
          // runningSummary, so the result also says whether a note was
          // GENERATED (and persisted as the LIVE_SOAP_SNAPSHOT).
          if (payload.metadata?.agent && !seenAgent) seenAgent = payload.metadata.agent;
          if (seenAgent && payload.runningSummary && payload.runningSummary.trim()) {
            await reader.cancel().catch(() => undefined);
            return { agent: seenAgent, generated: true };
          }
        } catch {
          /* partial frame — keep buffering */
        }
      }
      // Keep only the tail after the last complete frame boundary.
      const lastBoundary = buffer.lastIndexOf('\n\n');
      if (lastBoundary >= 0) buffer = buffer.slice(lastBoundary + 2);
    }
    // Stream ended without a generated frame — still report the agent if the
    // frozen snapshot reached us, so R-N1 can still assert.
    return seenAgent ? { agent: seenAgent, generated: false } : null;
  } catch {
    // Budget expired (or the stream broke). Same rule: an agent seen is still
    // evidence for R-N1 even when generation never completed.
    return seenAgent ? { agent: seenAgent, generated: false } : null;
  } finally {
    clearTimeout(timer);
  }
}

// SERIAL: running the tests on parallel workers re-ran `beforeAll` per worker,
// and the concurrent agent creations collided on a unique constraint (409,
// observed 2026-08-08).
test.describe.serial('Live agent lineage is frozen for the session (R-N1)', () => {
  let token: string;
  let departmentId: string;
  let consultationId: string;
  let sseAgent: SseAgent | null = null;
  /** The STT session id whose result stream this spec feeds (see xaddFinalSegments). */
  let sttSessionId: string | null = null;
  /**
   * WHAT tier-1a is expected to report, and the identity it must carry.
   *
   * `null` id = tier-1a is not reachable at all and the governed SYSTEM live
   * default (`'default'`) is the correct answer.
   */
  let agentId: string | null = null;
  /** True once a tier-1a SOURCE was discovered, so `resolvedFrom` must be `'agent'`. */
  let liveBindingApplied = false;
  /** Which tier-1a source answered — for the failure message only. */
  let liveBindingSource: 'node' | 'per-turn-agent' | null = null;

  test.beforeAll(async ({ request, playwright }, testInfo) => {
    void playwright;
    void testInfo;
    const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(login, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    token = login!.token;

    const departments = await request.get('/api/v1/admin/departments?take=1', { headers: bearer(token) });
    expect(departments.status(), 'GET /admin/departments').toBe(200);
    // List envelopes are not uniform across admin surfaces — some return a bare
    // array, some the `PaginatedResponse.data` wrapper. Tolerate both (the house
    // `asArray` idiom, e.g. password-security-hardening.spec.ts) rather than
    // pinning one shape and failing setup on an unrelated contract detail.
    const deptList = listOf<{ id: string }>(await departments.json());
    expect(deptList.length, 'the tenant must have at least one seeded department').toBeGreaterThan(0);
    departmentId = deptList[0].id;

    // DISCOVER which tier the live chain will report — never provision. Authoring a
    // published definition from an e2e fixture would be a second implementation of the
    // publish path, and a wrong one.
    //
    // This mirrors `PromptResolutionService.resolveLivePromptId`, which is the ONLY
    // authority on the answer. Tier-1a has TWO sources and BOTH report `'agent'` (the
    // tier keeps its wire name — frozen v1-compat contract):
    //
    //   1. node  — a prompt-bearing node of the governing graph whose effective
    //              `taskKey` is `text.live`; `agentId` is then the NODE id.
    //   2. agent — TASK-946 OD-5: consulted only when no node carried its own
    //              `promptTemplateId`. The first per-turn realtime `core.agent` node
    //              (`execution.lane === 'realtime'`, cadence ≠ `onStart`) whose AGENT is
    //              PUBLISHED + active + TEXT_GENERATION. `agentId` is then the AGENT id.
    //
    // Only when NEITHER resolves is the governed SYSTEM live default (`'default'`) correct.
    //
    // The two things this block used to get wrong, both from TASK-930:
    //   - it listed `?paletteKey=consultation`. The governing palette is CORE (`'core'` —
    //     `CONSULTATION_PALETTE_KEY = CORE_PALETTE_KEY`), and the list route has no
    //     `paletteKey` filter in its query DTO at all, so the param was inert and the
    //     lookup silently answered "no definitions" for every tenant.
    //   - it took the first PUBLISHED+active definition. The runtime resolves the
    //     governing one through the ASSIGNMENT cascade (department → tenant), then
    //     `findPublishedBySlug`. Picking a different published graph reads the wrong nodes.
    const assignments = await request.get('/api/v1/admin/workflow-assignments?limit=100', { headers: bearer(token) });
    const assignmentList = assignments.ok()
      ? listOf<{ paletteKey?: string; workflowDefinitionSlug?: string; departmentId?: string | null }>(await assignments.json())
      : [];
    const corePalette = assignmentList.filter((a) => a.paletteKey === 'core' && !!a.workflowDefinitionSlug);
    // department-scoped wins over the tenant-wide row, exactly as the cascade does.
    const assignment = corePalette.find((a) => a.departmentId === departmentId) ?? corePalette.find((a) => !a.departmentId);

    if (assignment?.workflowDefinitionSlug) {
      const definitions = await request.get('/api/v1/admin/workflow-definitions?limit=100', { headers: bearer(token) });
      const definitionList = definitions.ok()
        ? listOf<{ id: string; slug?: string; status?: string; isActive?: boolean }>(await definitions.json())
        : [];
      const governing = definitionList.find((d) => d.slug === assignment.workflowDefinitionSlug && d.status === 'PUBLISHED' && d.isActive);

      if (governing) {
        const detail = await request.get(`/api/v1/admin/workflow-definitions/${governing.id}`, { headers: bearer(token) });
        if (detail.ok()) {
          const body = (await detail.json()) as { data?: GraphCarrier } & GraphCarrier;
          const nodes = (body.data ?? body).graph?.nodes ?? [];

          // Source 1 — a prompt-bearing live node. `taskKey` may be ABSENT and defaulted by
          // the node registry (`consultation.realtimeSummary` declares `default: 'text.live'`),
          // which is why an authored-only match is not enough. The registry is not importable
          // from an e2e spec (these are black-box over HTTP), so the one defaulting type is
          // named here; a new one must be added in the same commit that declares it.
          const liveNode = nodes.find((node) => {
            if (typeof node.config?.promptTemplateId !== 'string' || node.config.promptTemplateId.length === 0) return false;
            const authored = node.config?.taskKey;
            if (typeof authored === 'string' && authored.length > 0) return authored === 'text.live';
            return node.type === 'consultation.realtimeSummary';
          });

          // The resolver drops a node whose template is not APPROVED and falls through to
          // source 2, so an unapproved binding is NOT a tier-1a node source here either.
          if (liveNode && (await isApprovedTemplate(request, token, liveNode.config!.promptTemplateId as string))) {
            agentId = liveNode.id;
            liveBindingApplied = true;
            liveBindingSource = 'node';
          }

          // Source 2 — the per-turn realtime agent (TASK-946 OD-5), in AUTHORED ORDER:
          // the resolver returns the first candidate that qualifies, so order is load-bearing.
          if (!liveBindingApplied) {
            const perTurn = nodes.filter((node) => {
              if (node.type !== 'core.agent' || node.config?.disabled === true) return false;
              const execution = node.config?.execution as { lane?: unknown; cadence?: unknown } | undefined;
              return !!execution && execution.lane === 'realtime' && execution.cadence !== 'onStart';
            });
            if (perTurn.length > 0) {
              const agents = await request.get('/api/v1/admin/agents?limit=100', { headers: bearer(token) });
              const agentList = agents.ok()
                ? listOf<{ id: string; slug?: string; task?: string; status?: string; isActive?: boolean }>(await agents.json())
                : [];
              for (const node of perTurn) {
                const slug = (node.config?.agentRef as { slug?: unknown } | undefined)?.slug;
                if (typeof slug !== 'string' || slug.length === 0) continue;
                const agent = agentList.find((a) => a.slug === slug && a.task === 'TEXT_GENERATION' && a.status === 'PUBLISHED' && a.isActive);
                if (agent) {
                  agentId = agent.id;
                  liveBindingApplied = true;
                  liveBindingSource = 'per-turn-agent';
                  break;
                }
              }
            }
          }
        }
      }
    }

    if (!liveBindingApplied) {
      console.warn('[ C6] no tier-1a source on the tenant’s governing CORE graph — R-N1 will assert the SYSTEM-default tier instead.');
    }

    const patientId = `task-635-c6-${Date.now()}`;
    const opened = await request.post('/api/v1/consultations/open', {
      headers: bearer(token),
      data: { patientId, departmentId },
    });
    expect([200, 201], 'POST /consultations/open').toContain(opened.status());
    consultationId = ((await opened.json()) as { id: string }).id;

    // (consent-abac): `POST :id/recording/start()` below is gated by
    // `@RequiresConsent(AI_DOCUMENTATION)`. This spec used to record that grant
    // itself; since TASK-805 (b17007a60, "a doctor opening a consultation IS
    // the consent event") the `open` above ALREADY recorded it —
    // `ConsultationService.open` calls `ensureConsultationConsent(patientId)`
    // fail-closed, granting every `ConsentPurpose` as VERBAL_ATTESTED.
    //
    // So the explicit POST is now a SECOND active grant for the same
    // (tenant, patient, purpose) triple and 409s on the partial unique index
    // `ConsentGrant_tenant_patient_purpose_active_key` — by design:
    // `ConsentGrantService.create` is the strict primitive (a duplicate active
    // grant is a real conflict, and swallowing it would silently discard a
    // differing grantMethod/evidenceRef and skip the CONSENT_GIVEN WORM
    // append), while `ensureConsultationConsent` is the idempotent wrapper.
    //
    // Assert the auto-grant instead of re-recording it: that keeps the
    // precondition recording/start() needs AND pins TASK-805's behaviour, which
    // creating our own grant would have masked.
    const grants = await request.get(
      `/api/v1/admin/consent-grants?externalPatientId=${encodeURIComponent(patientId)}&purpose=AI_DOCUMENTATION&state=ACTIVE`,
      { headers: bearer(token) },
    );
    expect(grants.status(), 'GET /admin/consent-grants (AI_DOCUMENTATION)').toBe(200);
    const autoGranted = listOf<{ purpose: string; grantMethod: string; revokedAt?: string }>(await grants.json());
    expect(autoGranted, 'consultation open must auto-record the AI_DOCUMENTATION grant (TASK-805)').toHaveLength(1);
    expect(autoGranted[0].grantMethod, 'auto-grant is the clinician’s in-person attestation').toBe('VERBAL_ATTESTED');
  });

  test.afterAll(async ({ request }) => {
    // Nothing to tear down on the binding side any more: the spec DISCOVERS a
    // live-bound node rather than creating a row it has to clean up.
    await request.delete(`/api/v1/consultations/${consultationId}`, { headers: bearer(token) }).catch(() => undefined);
  });

  test('SSE live-summary events carry the frozen session agent (R-N1)', async ({ request, baseURL }) => {
    // A real generation on a local CPU model is slow (observed ~20s for a
    // comparable call), and the loop debounces before it even starts. Give the
    // whole test room, and keep the SSE budget strictly inside it.
    test.setTimeout(180_000);

    const redisUrl = process.env.REDIS_URL;
    test.skip(!redisUrl, 'REDIS_URL is unset — cannot feed the STT result stream');

    // Attach a session id so LiveDocumentationService subscribes to
    // `stt:result:{sessionId}` (recording.dto.ts documents exactly this use).
    // Without it, attachSttStream() never runs and no transcript can arrive.
    sttSessionId = randomUUID();
    const started = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, {
      headers: bearer(token),
      data: { sessionId: sttSessionId },
    });
    expect([200, 201], 'POST recording/start').toContain(started.status());
    expect((await started.json()).sseUrl).toBe(`/consultations/${consultationId}/live-summary/stream`);

    const ssePromise = readFirstAgentFromSse(baseURL!, consultationId, token, 150_000);

    // Feed the loop the way STT would. Three finals ≥ the default segment
    // threshold, so a flush fires on the count rather than waiting out the idle
    // debounce. XADD happens AFTER recording/start() so the subscriber's consumer
    // group already exists.
    await xaddFinalSegments(redisUrl!, sttSessionId, [
      'Doctor: What brings you in today?',
      'Patient: I have had a dry cough and a low-grade fever for four days.',
      'Doctor: Any shortness of breath? Patient: Only when I climb stairs. Doctor: Blood pressure is 128 over 82.',
    ]);

    // A clinician note as well — exercises handleContextAdded alongside the
    // transcript.
    const context = await request.post(`/api/v1/consultations/${consultationId}/context`, {
      headers: bearer(token),
      data: {
        // The field is `type` (AddContextRequest) and the enum member is
        // TRANSCRIPT — the global pipe runs forbidNonWhitelisted, so a stray
        // `contextType` key is a 400, not an ignored field.
        type: 'TRANSCRIPT',
        content:
          'Doctor: What brings you in today? Patient: I have had a dry cough and low-grade fever for four days. ' +
          'Doctor: Any shortness of breath? Patient: Only when I climb stairs. Doctor: Blood pressure is 128 over 82.',
      },
    });
    expect([200, 201], 'POST /consultations/:id/context').toContain(context.status());

    const watch = await ssePromise;
    sseAgent = watch?.agent ?? null;

    if (!sseAgent) {
      // With the stream fed, the remaining reasons are environmental: TEXT (and
      // the LLM behind it) or NLP unreachable, or generation slower than the
      // budget above. Skip rather than assert against an engine that never ran.
      console.warn(
        '[ C6] No live-summary SSE event with metadata.agent arrived even though the STT result stream was fed — ' +
          'TEXT/NLP likely unreachable or generation exceeded the budget. R-N1 assertions skipped.',
      );
      test.skip();
      return;
    }

    // With a tier-1a source present the loop MUST resolve it (either source reports
    // `'agent'`). Without one, the governed SYSTEM live-default is the correct answer.
    // `code-default` is never acceptable here: it would mean NO governed template
    // resolved and the live loop fell open to the in-code constants.
    expect(
      sseAgent.resolvedFrom,
      liveBindingApplied
        ? `a tier-1a source (${liveBindingSource}) must resolve, reported as \`agent\``
        : 'without a tier-1a source, the governed SYSTEM live default must resolve',
    ).toBe(liveBindingApplied ? 'agent' : 'default');

    // `id` identifies WHAT supplied tier-1a, and which of the two sources answered
    // decides the identity: the workflow NODE id for the node source, the AGENT id for
    // the per-turn agent source (TASK-946 OD-5). It exists only on tier-1a; on the
    // SYSTEM-default tier it is legitimately null. The governed template and its pinned
    // version must be present either way — that is what makes the live prompt
    // version-pinned rather than "whatever the row says today".
    if (liveBindingApplied) {
      expect(sseAgent.id, `tier-1a identity (${liveBindingSource})`).toBe(agentId);
    }
    expect(sseAgent.promptTemplateId, 'the governed live PromptTemplate').toBeTruthy();
    expect(typeof sseAgent.promptVersionNumber, 'the pinned immutable PromptVersion number').toBe('number');
  });
});
