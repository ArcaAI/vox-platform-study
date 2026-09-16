/**
 * TASK-981 — the "client-side developer" half of the end-to-end proof.
 *
 * Builds the consultation context FROM THE GENERATED TYPES (vox-codegen, tenant-schema mode),
 * opens the consultation through `@arcaai/vox-node` as the ArcaAI service account, drives the
 * realtime journey (STT session → PCM16 socket → live summary → stop → final note) and writes
 * every observation to OUT as JSON so the orchestrator can assert on it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HopeClient, type SttTranscriptResult } from '@arcaai/vox-node';
import type { ConsultationContextKindMap } from '../generated/consultation-context-schema.generated';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};

const BASE_URL = env('HOPE_BASE_URL', 'http://localhost:8868');
const OUT = env('OUT');
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 2));
const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

// --- 1. The context, typed by the tenant's schema -------------------------------------------
//
// `ConsultationContextKindMap` is what `vox-codegen --tenant` emitted from ArcaAI's PINNED
// `arcaai_consultation_scribe` version. A value that is not in the tenant's vocabulary does not
// compile — see `src-negative/off-schema.ts`.
type OpenContext = Pick<ConsultationContextKindMap, 'encounter' | 'vitals' | 'previous_case_notes'>;

const encounter: ConsultationContextKindMap['encounter'] = {
  doctor_id: env('STAFF_ID'),
  event_id: env('EVENT_ID'),
  department_code: env('DEPT_CODE', 'GEN'),
  department_name: process.env.DEPT_NAME,
  visit_type: env('VISIT_TYPE', 'new-visit') as ConsultationContextKindMap['encounter']['visit_type'],
  // Added by the tenant admin in v2 (TASK-981 A2) — optional, so v1 clients still compile.
  chief_complaint: process.env.CHIEF_COMPLAINT ?? 'Exertional shortness of breath and intermittent chest pain for two weeks',
};

const vitals: ConsultationContextKindMap['vitals'] = {
  bloodPressure: '128/82',
  heartRate: 88,
  temperature: 36.8,
  oxygenSaturation: 97,
  weightKg: 81.5,
  recordedAt: new Date().toISOString(),
};

const previous_case_notes: ConsultationContextKindMap['previous_case_notes'] = {
  notes: [
    {
      date: '2026-01-14',
      department: 'General Medicine',
      doctor: 'Dr. Bren',
      title: 'Hypertension review',
      text: 'PRIOR-NOTE-ALPHA: blood pressure controlled on amlodipine 5 mg; advised salt restriction and follow-up in three months.',
    },
    {
      date: '2026-03-02',
      title: 'Lipid panel follow-up',
      text: 'PRIOR-NOTE-BRAVO: LDL 3.9 mmol/L; started atorvastatin 20 mg nocte; no myalgia reported.',
    },
  ],
};

const context: OpenContext = { encounter, vitals, previous_case_notes };

// --- 2. The client ------------------------------------------------------------------------------
const hope = new HopeClient({
  baseUrl: BASE_URL,
  serviceAccount: { clientId: env('HOPE_SVC_CLIENT_ID'), clientSecret: env('HOPE_SVC_CLIENT_SECRET') },
});

/** Raw reads the SDK does not wrap (context items, Temporal history). */
async function svcToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/service-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: env('HOPE_SVC_CLIENT_ID'), clientSecret: env('HOPE_SVC_CLIENT_SECRET') }),
  });
  if (!res.ok) throw new Error(`service-token ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}
async function rawGet(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/api/v1/${path}`, { headers: { 'X-Service-Account-Token': token } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PCM16 payload of a 16 kHz mono WAV, header stripped by walking the RIFF chunks. */
function wavPcm(path: string): Buffer {
  const buf = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

async function main(): Promise<void> {
  const token = await svcToken();
  const journal: Record<string, unknown> = { startedAt: new Date().toISOString(), context };

  // --- 3. open ----------------------------------------------------------------------------------
  const opened = await hope.consultations.open({
    patientId: env('PATIENT_ID'),
    language: 'en',
    // NO departmentId, NO clinicianUserId: both come from the schema's markers inside `context`.
    ...(process.env.PARENT_CONSULTATION_ID ? { parentConsultationId: process.env.PARENT_CONSULTATION_ID } : {}),
    context,
  });
  log('open →', opened.id, 'dept', opened.departmentId, 'doctor', opened.doctorId, 'meta', JSON.stringify(opened.metadata));
  save('open.json', opened);
  journal.open = opened;
  const consultationId = opened.id;

  const items = await rawGet(`consultations/${consultationId}/context`, token);
  save('context-items.json', items.body);
  const rows = Array.isArray(items.body) ? (items.body as Array<{ type: string; kindKey?: string; content?: string }>) : [];
  log('context items:', rows.map((r) => `${r.type}${r.kindKey ? `(${r.kindKey})` : ''}`).join(', '));

  const engine = (opened.metadata?.governingEngine ?? null) as { workflowRunId?: string; workflowDefinitionSlug?: string } | null;
  const selection = (opened.metadata?.workflowSelection ?? null) as Record<string, unknown> | null;
  log('governingEngine at open:', JSON.stringify(engine), 'workflowSelection:', JSON.stringify(selection));

  if (process.env.SKIP_AUDIO === '1') {
    save('journal.json', journal);
    return;
  }

  // --- 4. realtime: STT session, recording, live summary, audio --------------------------------
  const session = await hope.stt.createStreamSession({ consultationId, language: 'en' });
  log('stt session', session.sessionId, 'agent', session.agentSlug, session.agentVersionId);
  save('stt-session.json', { ...session, ticket: '<redacted>' });

  const started = await hope.consultations.recording.start(consultationId, { sessionId: session.sessionId });
  log('recording/start →', JSON.stringify(started));
  save('recording-start.json', started);

  const after = await hope.consultations.get(consultationId);
  const engine2 = ((after as unknown as { metadata?: Record<string, unknown> }).metadata?.governingEngine ?? null) as { workflowRunId?: string; workflowDefinitionSlug?: string } | null;
  log('governingEngine after start:', JSON.stringify(engine2));
  save('consultation-after-start.json', after);
  journal.governingEngine = engine2 ?? engine;

  const liveEvents: unknown[] = [];
  const patches: Array<{ at: string; sectionKey: string; state: string; content: string }> = [];
  const stream = hope.consultations.streams.liveSummary(consultationId, {
    onSnapshot: (e) => {
      liveEvents.push({ at: new Date().toISOString(), kind: 'snapshot', sections: e.sections?.length ?? 0, entities: e.entities?.length ?? 0, runningSummary: (e.runningSummary ?? '').slice(0, 200) });
      log('live snapshot: sections', e.sections?.length ?? 0, 'entities', e.entities?.length ?? 0);
    },
    onSectionPatch: (e) => {
      patches.push({ at: new Date().toISOString(), sectionKey: e.sectionKey, state: e.state, content: e.content });
      log('section.patch', e.sectionKey, e.state, e.content.slice(0, 120).replace(/\n/g, ' '));
    },
    onPreSummary: (e) => {
      liveEvents.push({ at: new Date().toISOString(), kind: 'presummary', event: e });
      log('presummary event', JSON.stringify(e).slice(0, 300));
    },
    onError: (err) => {
      liveEvents.push({ at: new Date().toISOString(), kind: 'error', error: String(err) });
      log('live-summary error', err);
    },
  });

  const transcripts: Array<{ at: string; isFinal: boolean; text: string; startTime?: number; endTime?: number }> = [];
  const socket = hope.stt.socket(session);
  socket.on('transcript', (t: SttTranscriptResult) => {
    transcripts.push({ at: new Date().toISOString(), isFinal: Boolean(t.isFinal), text: t.text, startTime: t.startTime, endTime: t.endTime });
    if (t.isFinal) log('FINAL', t.text);
  });
  socket.on('status', (s) => log('stt status', JSON.stringify(s).slice(0, 200)));
  socket.on('error', (e) => log('stt error', JSON.stringify(e).slice(0, 300)));
  await socket.connect();
  log('socket connected');

  const pcm = wavPcm(env('WAV'));
  const loops = Number(env('LOOPS', '2'));
  const frame = 3200; // 100 ms @ 16 kHz mono PCM16
  const t0 = Date.now();
  for (let loop = 0; loop < loops; loop++) {
    for (let off = 0; off < pcm.length; off += frame) {
      socket.sendPcm16(pcm.subarray(off, Math.min(off + frame, pcm.length)));
      await sleep(100);
    }
    log(`loop ${loop + 1}/${loops} sent (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (loop + 1 < loops) {
      // ~2 s of silence between loops so the ASR closes the utterance.
      for (let i = 0; i < 20; i++) {
        socket.sendPcm16(Buffer.alloc(frame));
        await sleep(100);
      }
    }
  }

  const settleMs = Number(env('SETTLE_MS', '150000'));
  log(`audio done; settling ${settleMs / 1000}s for the live flush`);
  const settleUntil = Date.now() + settleMs;
  while (Date.now() < settleUntil) {
    // keep the session alive with silence while the lane flushes
    socket.sendPcm16(Buffer.alloc(frame));
    await sleep(100);
    if (patches.length > 0 && Date.now() > settleUntil - settleMs / 2 && process.env.EARLY_STOP === '1') break;
  }

  socket.finalize();
  await sleep(3000);
  socket.close();

  const stopped = await hope.consultations.recording.stop(consultationId, { persistSnapshot: true });
  log('recording/stop →', JSON.stringify(stopped));
  save('recording-stop.json', stopped);

  // --- 5. wait for the governing run and the final note ---------------------------------------
  const gov = (journal.governingEngine ?? {}) as { workflowDefinitionSlug?: string; workflowRunId?: string };
  const slug: string | undefined = gov.workflowDefinitionSlug;
  const runId: string | undefined = gov.workflowRunId;
  const finalTimeoutMs = Number(env('FINAL_TIMEOUT_MS', '360000'));
  const deadline = Date.now() + finalTimeoutMs;
  let runStatus: unknown = null;
  let latest: unknown = null;
  let gateDecided = false;
  while (Date.now() < deadline) {
    if (slug && runId) {
      try {
        runStatus = await hope.workflows.getRun(slug, runId);
        const st = (runStatus as { status: string }).status;
        log('run', runId, st);
        if (['COMPLETED', 'DEGRADED', 'FAILED', 'CANCELLED', 'completed', 'degraded', 'failed', 'cancelled'].includes(st)) break;
        // The graph parks on its clinician ReviewGate after the finalizer; an integrator (ALaaS,
        // owner decision OD-14) releases it on the clinician's behalf. Same here, once it exists.
        if (!gateDecided && process.env.AUTO_APPROVE !== '0') {
          const gate = await hope.workflows.reviews.get(slug, runId, 'n_review');
          if (gate.exists && !gate.decided) {
            const decided = await hope.workflows.reviews.decide(slug, runId, 'n_review', { decision: 'approved', comment: 'TASK-981 e2e auto-approve' });
            log('review gate decided →', JSON.stringify(decided).slice(0, 300));
            save('review-decision.json', decided);
            gateDecided = true;
          }
        }
      } catch (err) {
        log('getRun/gate error', String(err).slice(0, 200));
      }
    }
    await sleep(10000);
  }
  try {
    latest = await hope.consultations.summaries.latest(consultationId);
  } catch (err) {
    latest = { error: String(err) };
  }
  const finalRow = await hope.consultations.get(consultationId);

  stream.close();
  save('run-status.json', runStatus);
  save('summary-latest.json', latest);
  save('consultation-final.json', finalRow);
  save('transcripts.json', transcripts);
  save('live-events.json', liveEvents);
  save('section-patches.json', patches);

  if (runId) {
    const hist = await fetch(`http://localhost:8233/api/v1/namespaces/default/workflows/workflow-interpreter-${runId}/history`);
    const histJson = (await hist.json()) as { events?: Array<Record<string, unknown>> };
    save('temporal-history.json', histJson);
    const first = histJson.events?.[0] as { workflowExecutionStartedEventAttributes?: { input?: unknown } } | undefined;
    save('temporal-start-input.json', first?.workflowExecutionStartedEventAttributes?.input ?? null);
  }
  journal.endedAt = new Date().toISOString();
  journal.finalStatus = finalRow.status;
  save('journal.json', journal);
  log('DONE', consultationId, 'status', finalRow.status);
}

main().catch((err) => {
  console.error('JOURNEY FAILED', err);
  save('failure.json', { message: String(err), stack: (err as Error)?.stack, error: err });
  process.exit(1);
});
