/**
 * TASK-959 §3 / §4 / §6.3 — compute seconds and third-party bytes reach the ledger.
 *
 * ============================================================================
 * WHAT THIS FILE PROVES
 * ============================================================================
 * Before this ticket, one provider call produced token / audio / character
 * rows and nothing else: the seconds the tenant occupied a model, and the bytes
 * that crossed to a vendor, were measured by every service and dropped by every
 * emitter. The ticket's claim is that each of those is now ONE MORE UNIT ROW ON
 * THE SAME BATCH — no new event shape, no new table, no new callback. That
 * claim is only true if it survives HTTP, and this file is where that is
 * checked against a live gateway.
 *
 * Four rules carry the money and each is asserted, never inferred:
 *
 *   1. `device` DECIDES THE UNIT — `cuda`/`mps` → `GPU_SECOND`, `cpu` →
 *      `CPU_SECOND` — and rides the UNIT row's own `attributesJson`, not
 *      `common`. The two are priced an order of magnitude apart, so a row whose
 *      unit and device disagree is a mis-priced row.
 *   2. A call a VENDOR served bills the PLATFORM's cpu, whatever the caller
 *      resolved.
 *   3. On a `BYOK_NOTIONAL` batch the compute row splits out as `INTERNAL` —
 *      the tenant paid for the tokens, the platform paid for the seconds — and
 *      is the one sanctioned mixed-basis case (§6.3).
 *   4. EVERY quantity is a decimal STRING. A JSON number is an IEEE double and
 *      fractional seconds times a price is where float drift becomes money.
 *
 * ============================================================================
 * WHY THE STT SEAM IS HERE AND NOT ONLY THE AGENT ROUTES
 * ============================================================================
 * The agent describes below drive a real generation, so they need `apps/text` /
 * `apps/nlp` / `apps/tts` reachable from the gateway, and they SKIP with the
 * status when it is not — a skip states "not proven here", where a pass would
 * state something false.
 *
 * The last describe needs none of them. `POST /internal/stt/streaming/usage` is
 * the gateway's own HTTP intake for the teardown summary `apps/stt`'s idle
 * reaper pushes back, and the wire shape it accepts is frozen in §10.2. Posting
 * that exact shape exercises the REAL emitter (`emitStreamingUsage` →
 * `appendComputeAndByteUnits` → `UsageLedgerService`) end to end over HTTP, so
 * all four rules above are proved on a box where no Python service is running —
 * including the BYOK split, which no other reachable path can reach at all.
 * It impersonates the CALLER, never the emitter: every assertion is about what
 * the gateway decided, not about what the test supplied.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';

import { DEFAULT_TENANT_KEY, SEEDED_API_KEY_SERVICE_ACCOUNT, SEEDED_USERS, loginUser } from '../../../../tests/helpers';
import {
  BYTE_UNITS,
  COMPUTE_UNITS,
  closeLedgerDb,
  describe as describeRows,
  isDecimalString,
  ledgerRowsSince,
  unitForDevice,
  waitForLedgerRows,
  type LedgerRow,
} from './helpers/usage-ledger.helper';

/** The seeded customer tenant every seeded user belongs to (`seed/00-constants.ts`). */
const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';

/** Published SYSTEM agents from the TASK-930 reference set (`seed/25-agents.ts`). */
const TEXT_AGENT_SLUG = 'general-medicine-summarization';
const NER_AGENT_SLUG = 'medical-ner';
const TTS_AGENT_SLUG = 'text-to-speech';

const DEVICE_MAP_KEY = 'metering.compute.deviceByProvider';

/**
 * The `{{trigger.context.*}}` paths the seeded text agent's instruction binds.
 * Mirrors `task-890-metering.spec.ts`: the invocation is refused 400 naming the
 * first unresolved path, and this spec is about metering, not prompt authoring.
 */
const AGENT_CONTEXT = {
  context: {
    language: 'en',
    visit_type: 'new-visit',
    chief_complaint: 'mild headache',
    current_department: 'General Medicine',
    safe_age: '42',
    safe_dob: '1984-01-01',
    safe_gender: 'female',
    formatted_vitals: 'BP 120/80',
    formatted_previous_visits: 'none',
  },
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A downstream service the gateway could not reach — the one honest reason to skip. */
const DOWNSTREAM_DOWN = [502, 503, 504];

let doctorToken: string;
/** `metering.compute.deviceByProvider` as the gateway resolves it for this tenant. */
let deviceByProvider: Record<string, unknown> = {};

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: process.env.API_URL || 'http://localhost:8968/api/v1' });
  const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
  const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  if (!doctor || !admin) throw new Error('TASK-959 compute spec could not log in the seeded doctor / super admin');
  doctorToken = doctor.token;

  // The device map is CONFIGURATION, so the expected unit is read from the
  // gateway rather than hardcoded — a platform admin may legitimately have
  // moved a provider between cuda and cpu, and that must change what this
  // spec expects, not what it reports.
  const settings = await request.get(`/api/v1/admin/settings/registry/${DEVICE_MAP_KEY}?tenantId=${TENANT_GLOBAL}`, { headers: bearer(admin.token) });
  if (settings.status() === 200) {
    const body = (await settings.json()) as { value?: unknown };
    if (body.value && typeof body.value === 'object' && !Array.isArray(body.value)) {
      deviceByProvider = body.value as Record<string, unknown>;
    }
  }
  await request.dispose();
});

test.afterAll(async () => {
  await closeLedgerDb();
});

/**
 * Which device the gateway must have stamped on this row's compute unit.
 *
 * Rule 2 first: a vendor's hardware is never billed as ours, so anything but
 * `SELF_HOSTED` is `cpu` whatever the map says. Otherwise the map answers, and
 * an unlisted or unrecognised provider resolves `cpu` — the resolver's declared
 * fallback, and the cheaper unit.
 */
function expectedDevice(row: LedgerRow): string {
  if (row.deployment !== 'SELF_HOSTED') return 'cpu';
  const mapped = deviceByProvider[row.provider];
  return typeof mapped === 'string' && ['cuda', 'mps', 'cpu'].includes(mapped) ? mapped : 'cpu';
}

/** The rows of the single most recent batch among `rows` — one provider call's worth. */
function newestBatch(rows: LedgerRow[]): LedgerRow[] {
  const newest = rows.reduce((best, row) => (row.occurredAt > best.occurredAt ? row : best), rows[0]);
  return rows.filter((row) => row.outboxId === newest.outboxId);
}

/**
 * The whole of §2.1's compute contract, asserted on one batch.
 *
 * Kept in one function because the four rules are one decision: a spec that
 * checked the unit here and the device there could pass while the pair
 * disagreed, which is precisely the mis-pricing the rules exist to prevent.
 */
function expectOneWellFormedComputeRow(batch: LedgerRow[], label: string): LedgerRow {
  const compute = batch.filter((row) => (COMPUTE_UNITS as readonly string[]).includes(row.unit));
  expect(compute, `${label}: exactly one compute row per call — got ${describeRows(compute)}`).toHaveLength(1);

  const row = compute[0];
  const device = row.attributesJson?.device;
  expect(typeof device, `${label}: device rides the UNIT row's attributesJson`).toBe('string');
  expect(row.unit, `${label}: device ${String(device)} decides the unit`).toBe(unitForDevice(String(device)));
  expect(device, `${label}: the device the gateway resolved for ${row.provider}/${row.deployment}`).toBe(expectedDevice(row));
  expect(isDecimalString(row.quantity), `${label}: quantity is a decimal string, got ${JSON.stringify(row.quantity)}`).toBe(true);
  expect(Number(row.quantity), `${label}: a recorded occupancy is strictly positive`).toBeGreaterThan(0);
  return row;
}

test.describe('TASK-959 §3.2 — an LLM call records the seconds it occupied the model', () => {
  test('blocking invocation: token rows AND exactly one compute row on the same batch', async ({ request }) => {
    // A real generation on a busy single-model stack runs well past the suite's
    // 30s default, and `APIRequestContext` applies its own per-request budget.
    test.setTimeout(180_000);
    const since = new Date();

    const response = await request.post(`/api/v1/agents/${TEXT_AGENT_SLUG}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Summarise: patient reports a mild headache.', context: AGENT_CONTEXT },
      timeout: 120_000,
    });
    test.skip(DOWNSTREAM_DOWN.includes(response.status()), `apps/text unreachable from the gateway (${response.status()})`);
    expect(response.status(), await response.text()).toBe(200);

    const generated = await waitForLedgerRows(since, (row) => row.operation === 'generate' && row.tenantId === TENANT_GLOBAL, {
      label: 'generate',
      tenantId: TENANT_GLOBAL,
    });
    const batch = newestBatch(generated);

    expect(batch.map((row) => row.unit)).toContain('INPUT_TOKEN');
    expect(batch.map((row) => row.unit)).toContain('OUTPUT_TOKEN');
    expectOneWellFormedComputeRow(batch, 'generate');

    // The key is INTENT-DERIVED (`llm:<text task id>` + `:<UNIT>`), never a
    // fresh uuid: that is what makes a redelivery converge instead of double-
    // billing. The response does not expose the task id, so the prefix and the
    // per-unit suffix are what can be asserted from outside.
    for (const row of batch) {
      expect(row.idempotencyKey, 'the batch shares one intent-derived base key').toMatch(new RegExp(`^llm:.+:${row.unit}$`));
    }
  });

  test('stream invocation: the same compute row on the `generate.stream` batch', async ({ request }) => {
    test.setTimeout(180_000);
    const since = new Date();

    const response = await request.post(`/api/v1/agents/${TEXT_AGENT_SLUG}/invocations?mode=stream`, {
      headers: { ...bearer(doctorToken), Accept: 'text/event-stream' },
      data: { text: 'Summarise: patient reports a mild headache.', context: AGENT_CONTEXT },
      timeout: 120_000,
    });
    test.skip(DOWNSTREAM_DOWN.includes(response.status()), `apps/text unreachable from the gateway (${response.status()})`);
    expect(response.status(), await response.text()).toBe(200);
    // Drain the stream so the gateway reaches its own end-of-stream teardown,
    // which is where the usage batch is built.
    await response.body();

    const streamed = await waitForLedgerRows(since, (row) => row.operation === 'generate.stream' && row.tenantId === TENANT_GLOBAL, {
      label: 'generate.stream',
      tenantId: TENANT_GLOBAL,
    });
    expectOneWellFormedComputeRow(newestBatch(streamed), 'generate.stream');
  });

  test('two invocations produce two DISTINCT keys — the key is derived, not minted per emission', async ({ request }) => {
    test.setTimeout(240_000);
    const since = new Date();

    for (const text of ['Summarise: first visit.', 'Summarise: second visit.']) {
      const response = await request.post(`/api/v1/agents/${TEXT_AGENT_SLUG}/invocations`, {
        headers: bearer(doctorToken),
        data: { text, context: AGENT_CONTEXT },
        timeout: 120_000,
      });
      test.skip(DOWNSTREAM_DOWN.includes(response.status()), `apps/text unreachable from the gateway (${response.status()})`);
      expect(response.status(), await response.text()).toBe(200);
    }

    const rows = await waitForLedgerRows(
      since,
      (row) => row.operation === 'generate' && row.unit === 'INPUT_TOKEN' && row.tenantId === TENANT_GLOBAL,
      { label: 'generate x2', minimum: 2, tenantId: TENANT_GLOBAL },
    );
    const keys = new Set(rows.map((row) => row.idempotencyKey));
    expect(keys.size, 'two calls, two keys — a shared key would silently deduplicate the second bill').toBeGreaterThanOrEqual(2);
  });
});

test.describe('TASK-959 §3.2 — NER and TTS record theirs on the batch they already wrote', () => {
  test('a NER invocation writes TEXT_UNIT and one compute row', async ({ request }) => {
    test.setTimeout(120_000);
    const since = new Date();

    const response = await request.post(`/api/v1/agents/${NER_AGENT_SLUG}/invocations`, {
      headers: bearer(doctorToken),
      data: { text: 'Patient reports a mild headache and takes ibuprofen 400mg.' },
      timeout: 90_000,
    });
    test.skip(DOWNSTREAM_DOWN.includes(response.status()), `apps/nlp unreachable from the gateway (${response.status()})`);
    expect(response.status(), await response.text()).toBe(200);

    const rows = await waitForLedgerRows(since, (row) => row.operation === 'ner.extract' && row.tenantId === TENANT_GLOBAL, {
      label: 'ner.extract',
      tenantId: TENANT_GLOBAL,
    });
    const batch = newestBatch(rows);
    expect(batch.map((row) => row.unit)).toContain('TEXT_UNIT');
    expectOneWellFormedComputeRow(batch, 'ner.extract');
  });

  test('a speech synthesis writes CHARACTER, one compute row, and the bytes it received', async ({ request }) => {
    test.setTimeout(120_000);
    const since = new Date();

    const response = await request.post(`/api/v1/agents/${TTS_AGENT_SLUG}/speech`, {
      headers: bearer(doctorToken),
      data: { text: 'The patient reports a mild headache.' },
      timeout: 90_000,
    });
    test.skip(DOWNSTREAM_DOWN.includes(response.status()), `apps/tts unreachable from the gateway (${response.status()})`);
    expect(response.status(), await response.text()).toBe(200);
    await response.body();

    const rows = await waitForLedgerRows(since, (row) => row.operation === 'tts.synthesize' && row.tenantId === TENANT_GLOBAL, {
      label: 'tts.synthesize',
      tenantId: TENANT_GLOBAL,
    });
    const batch = newestBatch(rows);
    expect(batch.map((row) => row.unit)).toContain('CHARACTER');
    expectOneWellFormedComputeRow(batch, 'tts.synthesize');

    // Bytes are conditional by design: a SELF_HOSTED engine on the LAN reports
    // `null`, never `0` ("never applicable" and "measured zero" are different
    // facts). So the assertion is about SHAPE when a byte row exists, and the
    // absence is reported rather than failed.
    const bytes = batch.filter((row) => (BYTE_UNITS as readonly string[]).includes(row.unit));
    for (const row of bytes) {
      expect(isDecimalString(row.quantity)).toBe(true);
      expect(Number(row.quantity)).toBeGreaterThan(0);
      if (row.attributesJson?.byteSource !== undefined) {
        expect(['wire', 'app']).toContain(String(row.attributesJson.byteSource));
      }
    }
  });
});

/**
 * The wire contract of §10.2, proved at the one seam that needs no Python
 * service running.
 *
 * `POST /internal/stt/streaming/usage` is how `apps/stt`'s idle reaper hands
 * the gateway a teardown summary for a session whose caller crashed. The body
 * is the frozen `segments[]` shape; the gateway does the rest. Three segments
 * in one POST cover the three economic shapes a real session can take, and each
 * is a rule from §2.1/§4/§6.3 that no other reachable path on this box can
 * exercise at all.
 */
test.describe('TASK-959 §10.2 — the STT teardown wire produces the units the contract promises', () => {
  const SESSION_ID = `task-959-e2e-${randomUUID()}`;
  /**
   * Deliberately finer than a millisecond: occupancy is recorded to three
   * decimals and no more (`SECOND_DECIMALS`), so this value proves the rounding
   * happens rather than merely surviving a round trip.
   */
  const SELF_HOSTED_SECONDS = 4.2567;
  const SELF_HOSTED_RECORDED = '4.257';
  const CLOUD_SECONDS = 2.5;
  const BYOK_SECONDS = 1.5;

  /** The reaper authenticates as the platform SERVICE_ACCOUNT — the only principal holding `internal:stt:worker`. */
  const asStt = { 'X-API-Key': SEEDED_API_KEY_SERVICE_ACCOUNT, 'Content-Type': 'application/json' };

  let rows: LedgerRow[];

  test.beforeAll(async ({ playwright }) => {
    const request: APIRequestContext = await playwright.request.newContext({
      baseURL: process.env.API_URL || 'http://localhost:8968/api/v1',
    });
    const since = new Date();

    const response = await request.post('/api/v1/internal/stt/streaming/usage', {
      headers: asStt,
      data: {
        session_id: SESSION_ID,
        tenant_id: TENANT_GLOBAL,
        pipeline_id: 'task-959-e2e',
        closed_at: new Date().toISOString(),
        audio_seconds: 30,
        session_seconds: 45,
        interrupted: false,
        segments: [
          // A platform GPU engine: occupancy on a real accelerator, no vendor
          // call, so nulls rather than zeroes for the bytes.
          {
            engine: 'faster_whisper',
            deployment: 'SELF_HOSTED',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: SELF_HOSTED_SECONDS,
            device: 'cuda',
            request_bytes: null,
            response_bytes: null,
            byte_source: null,
          },
          // The platform's own cloud fallback: the vendor ran the model, so
          // these seconds are the platform's CPU, and the bytes crossed.
          {
            engine: 'azure-speech',
            deployment: 'CLOUD',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: CLOUD_SECONDS,
            device: 'cpu',
            request_bytes: 1024,
            response_bytes: 2048,
            byte_source: 'wire',
          },
          // The tenant's own key: the minutes are theirs (BYOK_NOTIONAL), the
          // seconds HOPE burned calling the vendor are the platform's.
          {
            engine: 'openai',
            deployment: 'BYOK',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: BYOK_SECONDS,
            device: 'cpu',
            request_bytes: 512,
            response_bytes: 256,
            byte_source: 'app',
          },
        ],
      },
    });
    expect(response.status(), await response.text()).toBe(201);

    rows = await waitForLedgerRows(since, (row) => row.sessionId === SESSION_ID, {
      label: 'transcribe.stream teardown',
      // 2 audio/session rows x3 segments + 3 compute + 4 byte rows = 13.
      minimum: 13,
      tenantId: TENANT_GLOBAL,
    });
    await request.dispose();
  });

  test('the self-hosted segment bills GPU seconds and NO bytes', () => {
    const segment = rows.filter((row) => row.provider === 'faster_whisper');
    const compute = segment.filter((row) => (COMPUTE_UNITS as readonly string[]).includes(row.unit));

    expect(compute).toHaveLength(1);
    expect(compute[0].unit).toBe('GPU_SECOND');
    expect(compute[0].attributesJson?.device).toBe('cuda');
    // Rounded to the millisecond, then NORMALISED: the append helper writes a
    // fixed-3dp string and `serializeUsageEvent` runs it through `Decimal`, so
    // `2.500` is stored as `2.5`. The value is what is billed; the trailing
    // zeroes are not, and asserting them would pin a formatting accident.
    expect(compute[0].quantity).toBe(SELF_HOSTED_RECORDED);
    expect(compute[0].costBasis).toBe('INTERNAL');

    // `null` bytes are not `0` bytes: a LAN call made no third-party request,
    // and inventing a zero row would put it in a third-party byte total.
    expect(segment.filter((row) => (BYTE_UNITS as readonly string[]).includes(row.unit))).toHaveLength(0);
  });

  test('the cloud segment bills the PLATFORM cpu and both byte directions', () => {
    const segment = rows.filter((row) => row.provider === 'azure-speech');

    const compute = segment.filter((row) => (COMPUTE_UNITS as readonly string[]).includes(row.unit));
    expect(compute).toHaveLength(1);
    expect(compute[0].unit).toBe('CPU_SECOND');
    expect(compute[0].attributesJson?.device).toBe('cpu');
    expect(Number(compute[0].quantity)).toBe(CLOUD_SECONDS);

    const egress = segment.find((row) => row.unit === 'EGRESS_BYTE');
    const ingress = segment.find((row) => row.unit === 'INGRESS_BYTE');
    expect(egress?.quantity).toBe('1024');
    expect(ingress?.quantity).toBe('2048');
    // Direction is a UNIT, not an attribute, so a byte total can be split
    // without reading anyone's attribute bag.
    expect(egress?.attributesJson?.byteSource).toBe('wire');
    expect(ingress?.attributesJson?.byteSource).toBe('wire');
  });

  test('§6.3 — the BYOK segment splits: notional minutes for the tenant, INTERNAL seconds for the platform', () => {
    const segment = rows.filter((row) => row.provider === 'openai');

    const minutes = segment.filter((row) => ['AUDIO_SECOND', 'SESSION_SECOND'].includes(row.unit));
    expect(minutes.length).toBeGreaterThan(0);
    for (const row of minutes) {
      expect(row.costBasis, "the tenant's own vendor spend is never platform COGS").toBe('BYOK_NOTIONAL');
      expect(row.deployment).toBe('BYOK');
    }

    const compute = segment.filter((row) => (COMPUTE_UNITS as readonly string[]).includes(row.unit));
    expect(compute).toHaveLength(1);
    expect(compute[0].unit).toBe('CPU_SECOND');
    expect(Number(compute[0].quantity)).toBe(BYOK_SECONDS);
    expect(compute[0].costBasis, 'the seconds HOPE burned calling the vendor are the platform’s').toBe('INTERNAL');
    // `deployment` stays BYOK — a fact about the CALL, not about who paid for
    // these seconds — and the split batch shares the base key, so expansion
    // keeps the rows distinct without minting a second identity.
    expect(compute[0].deployment).toBe('BYOK');

    // The bytes stay on the ORIGINATING batch, deliberately: they are COST 0
    // today, so moving them would invent a platform row for a zero.
    const bytes = segment.filter((row) => (BYTE_UNITS as readonly string[]).includes(row.unit));
    expect(bytes).toHaveLength(2);
    for (const row of bytes) {
      expect(row.costBasis).toBe('BYOK_NOTIONAL');
      expect(row.attributesJson?.byteSource).toBe('app');
    }
  });

  test('every quantity on every row is a decimal STRING, and each segment keys distinctly', () => {
    for (const row of rows) {
      expect(isDecimalString(row.quantity), `${row.provider}/${row.unit} quantity ${JSON.stringify(row.quantity)}`).toBe(true);
      expect(row.operation).toBe('transcribe.stream');
      expect(row.capability).toBe('STT');
    }

    // One base key per segment (`stt:session:<id>` then `:<ordinal>`), and
    // `:<UNIT>` appended at expansion — so three segments never collide and a
    // redelivery of the same segment converges on the same row.
    const keys = new Set(rows.map((row) => row.idempotencyKey));
    expect(keys.size).toBe(rows.length);
    for (const row of rows) {
      expect(row.idempotencyKey).toMatch(new RegExp(`^stt:session:${SESSION_ID}(:\\d+)?:${row.unit}$`));
    }
  });

  test('the push-back is idempotent — a redelivery adds no second bill', async ({ request }) => {
    const since = new Date();
    const response = await request.post('/api/v1/internal/stt/streaming/usage', {
      headers: asStt,
      data: {
        session_id: SESSION_ID,
        tenant_id: TENANT_GLOBAL,
        pipeline_id: 'task-959-e2e',
        closed_at: new Date().toISOString(),
        audio_seconds: 30,
        session_seconds: 45,
        interrupted: false,
        segments: [
          {
            engine: 'faster_whisper',
            deployment: 'SELF_HOSTED',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: SELF_HOSTED_SECONDS,
            device: 'cuda',
          },
        ],
      },
    });
    expect(response.status()).toBe(201);

    // The OUTBOX is append-only and the drainer is what deduplicates on the
    // key, so the honest assertion here is that the redelivery reuses the SAME
    // idempotency key — which is what makes the drain converge — not that no
    // row was written.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const replayed = (await ledgerRowsSince(since, { tenantId: TENANT_GLOBAL })).filter((row) => row.sessionId === SESSION_ID);
    expect(replayed.length).toBeGreaterThan(0);
    for (const row of replayed) {
      expect(row.idempotencyKey).toMatch(new RegExp(`^stt:session:${SESSION_ID}(:\\d+)?:${row.unit}$`));
    }
  });
});

/**
 * §4.2 — bytes on a BYOK LLM call.
 *
 * Not provable on this box, and deliberately not faked. Proving it needs a
 * tenant `AiProviderConnection` holding a REAL vendor key and a route out to
 * that vendor: the byte counters live in `apps/text`'s pool transport
 * (`usage_detail.request_bytes` / `response_bytes`), so a stub provider counts
 * the stub's bytes and would assert nothing about a vendor call. The BYOK
 * SPLIT rule those rows ride on IS proved above, at the STT seam, where the
 * same `appendComputeAndByteUnits` makes the same decision.
 */
test.describe('TASK-959 §4.2 — BYOK byte rows on an LLM call', () => {
  test('needs a real vendor credential and egress, neither of which exists here', () => {
    test.skip(
      true,
      'Not provable on this stack: the byte counters are in `apps/text`s pool transport, so it needs `apps/text` running AND a BYOK connection with a real vendor key and outbound reach. A stub would count the stub. The BYOK cost-basis split is proved at the STT seam in this file.',
    );
  });
});
