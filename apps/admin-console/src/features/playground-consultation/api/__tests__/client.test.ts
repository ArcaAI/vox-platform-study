/**
 * Frames 50 + 50.1 — playground consultation REST plane (matrix row 34).
 * fetch is stubbed at the network boundary; every call is asserted as an
 * exact "METHOD /api/hope/<path>" string against ConsultationController /
 * ConsultationJobController / AudioPipelinePublicController. This is the
 * END-USER plane (no `admin/` prefix — the admin read grid is row 33).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveSummary,
  cancelConsultationJob,
  consultationJobStreamPath,
  generateSummary,
  generateSummaryAsync,
  getConsultationJob,
  getLatestSummary,
  getNamedEntities,
  getSummaryProvenance,
  getTranscriptions,
  harnessAssuranceStreamPath,
  harnessProgressStreamPath,
  listAudioPipelines,
  listDnaStyleOptions,
  listScopingDepartments,
  liveSummaryStreamPath,
  openConsultation,
  startRecording,
  stopRecording,
  updateSummary,
} from '../client';
import { playgroundConsultationKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(response: () => Response = () => Response.json({})): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('playgroundConsultationKeys', () => {
  it('is stable for equal ids and distinct across scopes', () => {
    expect(playgroundConsultationKeys.latestSummary('c-1')).toEqual(playgroundConsultationKeys.latestSummary('c-1'));
    expect(playgroundConsultationKeys.latestSummary('c-1')).not.toEqual(playgroundConsultationKeys.latestSummary('c-2'));
    expect(playgroundConsultationKeys.namedEntities('c-1')).not.toEqual(playgroundConsultationKeys.latestSummary('c-1'));
    expect(playgroundConsultationKeys.namedEntities('c-1', 'single')).not.toEqual(playgroundConsultationKeys.namedEntities('c-1', 'chain'));
    expect(playgroundConsultationKeys.job('j-1')).not.toEqual(playgroundConsultationKeys.job('j-2'));
    expect(playgroundConsultationKeys.transcriptions('c-1')).not.toEqual(playgroundConsultationKeys.transcriptions('c-2'));
    expect(playgroundConsultationKeys.provenance('c-1', 'ctx-1')).not.toEqual(playgroundConsultationKeys.provenance('c-1', 'ctx-2'));
  });

  it('roots every key under the feature namespace for coarse invalidation', () => {
    for (const key of [
      playgroundConsultationKeys.pipelines(),
      playgroundConsultationKeys.latestSummary('x'),
      playgroundConsultationKeys.namedEntities('x'),
      playgroundConsultationKeys.job('x'),
    ]) {
      expect(key[0]).toBe('playground-consultation');
    }
  });
});

describe('playground consultation client', () => {
  it('lists audio pipelines for the picker', async () => {
    const calls = installFetchMock(() => Response.json([{ id: 'pipe-1', name: 'Default Clinical', slug: 'default-clinical' }]));
    const pipelines = await listAudioPipelines();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/audio/pipelines']);
    expect(pipelines[0].slug).toBe('default-clinical');
  });

  it('opens the demo consultation via the get-or-create route (same route the SDK session.open uses)', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'c-1', patientId: 'P-448', status: 'OPEN' }));
    const opened = await openConsultation({ patientId: 'P-448' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/consultations/open']);
    expect(calls[0].body).toEqual({ patientId: 'P-448' });
    expect(opened.id).toBe('c-1');
  });

  it('starts a recording, passing sessionId only when known', async () => {
    const calls = installFetchMock(() =>
      Response.json({
        consultationId: 'c-1',
        status: 'RECORDING',
        recording: true,
        sseUrl: '/consultations/c-1/live-summary/stream',
        updatedAt: '2026-07-06T14:02:00.000Z',
      }),
    );
    const state = await startRecording('c-1');
    await startRecording('c-1', 's-7f31');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/consultations/c-1/recording/start',
      'POST /api/hope/consultations/c-1/recording/start',
    ]);
    expect(calls[0].body).toEqual({});
    expect(calls[1].body).toEqual({ sessionId: 's-7f31' });
    expect(state.status).toBe('RECORDING');
    expect(state.recording).toBe(true);
  });

  it('stops a recording persisting the live-summary snapshot by default', async () => {
    const calls = installFetchMock(() =>
      Response.json({
        consultationId: 'c-1',
        status: 'OPEN',
        recording: false,
        sseUrl: '/consultations/c-1/live-summary/stream',
        updatedAt: '2026-07-06T14:05:00.000Z',
      }),
    );
    const state = await stopRecording('c-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/consultations/c-1/recording/stop']);
    expect(calls[0].body).toEqual({ persistSnapshot: true });
    expect(state.recording).toBe(false);
  });

  it('TASK-814 §2b: forwards accepted proposals, trimmed to the gateway DTO shape (no extra fields — the ValidationPipe forbids them)', async () => {
    const calls = installFetchMock(() =>
      Response.json({
        consultationId: 'c-1',
        status: 'OPEN',
        recording: false,
        sseUrl: '/consultations/c-1/live-summary/stream',
        updatedAt: '2026-07-06T14:05:00.000Z',
      }),
    );
    await stopRecording('c-1', true, [
      {
        proposalId: 'p-1',
        start: 10,
        end: 16,
        original: 'Toprovol',
        proposed: 'Toprol',
        category: 'drugName',
        confidence: 0.92,
        rationale: 'Common ASR misrecognition of a beta-blocker name',
        detectedBy: 'nlp.ner',
        proposedBy: 'lmstudio:gemma3',
        status: 'ACCEPTED',
      },
    ]);
    expect(calls[0].body).toEqual({
      persistSnapshot: true,
      acceptedProposals: [
        { proposalId: 'p-1', start: 10, end: 16, original: 'Toprovol', proposed: 'Toprol', category: 'drugName', confidence: 0.92, status: 'ACCEPTED' },
      ],
    });
  });

  it('omits acceptedProposals from the body when none were accepted', async () => {
    const calls = installFetchMock(() =>
      Response.json({ consultationId: 'c-1', status: 'OPEN', recording: false, sseUrl: '/x', updatedAt: 't' }),
    );
    await stopRecording('c-1', true, []);
    expect(calls[0].body).toEqual({ persistSnapshot: true });
  });

  it('generates a summary synchronously', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'ctx-9', consultationId: 'c-1', type: 'summary', content: 'S …' }));
    const summary = await generateSummary('c-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/consultations/c-1/summary']);
    expect(calls[0].body).toEqual({});
    expect(summary.id).toBe('ctx-9');
  });

  it('queues an async summary job and manages its lifecycle', async () => {
    const calls = installFetchMock(() => Response.json({ jobId: 'j-2210', status: 'pending', consultationId: 'c-1' }));
    const job = await generateSummaryAsync('c-1');
    await getConsultationJob('j-2210');
    await cancelConsultationJob('j-2210');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/consultations/c-1/summary/async',
      'GET /api/hope/consultations/jobs/j-2210',
      'PATCH /api/hope/consultations/jobs/j-2210/cancel',
    ]);
    expect(job.jobId).toBe('j-2210');
  });

  it('reads the latest summary (null when the body is empty)', async () => {
    const calls = installFetchMock(() => new Response('', { status: 200 }));
    const latest = await getLatestSummary('c-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/consultations/c-1/summary/latest']);
    expect(latest).toBeNull();
  });

  it('treats a 404 latest summary as "no draft yet" (null) but rethrows other failures', async () => {
    installFetchMock(() => Response.json({ message: 'No summary found' }, { status: 404 }));
    await expect(getLatestSummary('c-1')).resolves.toBeNull();

    installFetchMock(() => Response.json({ message: 'boom' }, { status: 503 }));
    await expect(getLatestSummary('c-1')).rejects.toMatchObject({ status: 503 });
  });

  it('reads aggregated named entities with the optional chain scope', async () => {
    const calls = installFetchMock(() =>
      Response.json({ consultationId: 'c-1', scope: 'single', entities: {}, totalCount: 0, countByClass: {}, sources: [] }),
    );
    const ner = await getNamedEntities('c-1');
    await getNamedEntities('c-1', 'chain');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/consultations/c-1/named-entities',
      'GET /api/hope/consultations/c-1/named-entities?scope=chain',
    ]);
    expect(ner.totalCount).toBe(0);
  });

  it('approves a summary, sending the safety-flag override only when requested', async () => {
    const calls = installFetchMock(() =>
      Response.json({ contextItemId: 'ctx-9', approvalStatus: 'APPROVED', approvedBy: 'u-1', approvedAt: '2026-07-06T15:00:00.000Z' }),
    );
    await approveSummary('c-1', 'ctx-9');
    await approveSummary('c-1', 'ctx-9', { overrideSafetyFlag: true });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/hope/consultations/c-1/summary/ctx-9/approve',
      'POST /api/hope/consultations/c-1/summary/ctx-9/approve',
    ]);
    expect(calls[0].body).toEqual({});
    expect(calls[1].body).toEqual({ overrideSafetyFlag: true });
  });

  it('reads persisted transcripts (evidence source)', async () => {
    const calls = installFetchMock(() => Response.json([{ id: 'ctx-t1', type: 'TRANSCRIPT', content: 'Patient reports chest pain.' }]));
    const transcripts = await getTranscriptions('c-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/consultations/c-1/context/transcriptions']);
    expect(transcripts[0].content).toBe('Patient reports chest pain.');
  });

  it('reads summary provenance including cited segments', async () => {
    const calls = installFetchMock(() =>
      Response.json({
        contextItemId: 'ctx-9',
        modelName: 'hope-scribe-v2',
        citationsMap: { segmentCitedIds: ['seg-1'] },
        citedSegments: [{ id: 'seg-1', idx: 0, t0Ms: 0, t1Ms: 3000, speaker: 'patient', charStart: 0, charEnd: 27 }],
      }),
    );
    const provenance = await getSummaryProvenance('c-1', 'ctx-9');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/consultations/c-1/summary/ctx-9/provenance']);
    expect(provenance.citedSegments).toHaveLength(1);
    expect(provenance.citedSegments[0].speaker).toBe('patient');
  });

  it('escapes path params', async () => {
    const calls = installFetchMock();
    await startRecording('c/1');
    await approveSummary('c 1', 'ctx#9');
    await getConsultationJob('j/1');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/hope/consultations/c%2F1/recording/start',
      '/api/hope/consultations/c%201/summary/ctx%239/approve',
      '/api/hope/consultations/jobs/j%2F1',
    ]);
  });

  it('builds gateway-relative SSE paths (no leading slash — useEventStream prepends the origin)', () => {
    expect(liveSummaryStreamPath('c-1')).toBe('consultations/c-1/live-summary/stream');
    expect(harnessProgressStreamPath('c-1')).toBe('consultations/c-1/harness-progress/stream');
    expect(harnessAssuranceStreamPath('c-1')).toBe('consultations/c-1/harness-assurance/stream');
    expect(consultationJobStreamPath('j-1')).toBe('consultations/jobs/j-1/stream');
  });
});

/**
 * TASK-793 W1/W2 — the two request shapes TASK-789 found were never sent.
 * Asserted at the network boundary, because "the field exists on the type" was
 * exactly the evidence that misled the earlier audit.
 */
describe('TASK-793 — the previously-unsent request shapes', () => {
  interface HeaderCall {
    url: string;
    method: string;
    body: Record<string, unknown> | undefined;
    headers: Record<string, string>;
  }

  function installHeaderAwareFetch(response: () => Response = () => Response.json({})): HeaderCall[] {
    const calls: HeaderCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
          headers,
        });
        return response();
      }),
    );
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('updateSummary PATCHes under If-Match and echoes expectedVersion (W1)', async () => {
    const calls = installHeaderAwareFetch(() => Response.json({ id: 'sum-1', content: 'x', version: 8 }));

    await updateSummary('c-1', 'sum-1', { content: 'edited', changeSource: 'doctor_edit' }, 7);

    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('/api/hope/consultations/c-1/summary/sum-1');
    // `@RequiresIfMatch()` — without this header the route is 428, not a write.
    expect(calls[0].headers['if-match']).toBe('"7"');
    expect(calls[0].body).toMatchObject({ content: 'edited', changeSource: 'doctor_edit', expectedVersion: 7 });
  });

  it('generateSummary carries dnaStyleId when one is selected (W2)', async () => {
    const calls = installHeaderAwareFetch();

    await generateSummary('c-1', { dnaStyleId: 'dna-42' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/hope/consultations/c-1/summary');
    expect(calls[0].body).toEqual({ dnaStyleId: 'dna-42' });
  });

  it('openConsultation carries departmentId so the department tier can resolve (W2)', async () => {
    const calls = installHeaderAwareFetch();

    await openConsultation({ patientId: 'P-1', departmentId: 'dept-cardio' });

    expect(calls[0].body).toEqual({ patientId: 'P-1', departmentId: 'dept-cardio' });
  });
});

/**
 * TASK-815 §12 (P-4) — the two scoping catalogs live on the CLINICIAN plane.
 *
 * They used to call `admin/departments` and `admin/dna-writing-styles`, which
 * 403 for the one clinical persona the product defines (a tenant admin
 * impersonating a clinician: `doctor_derm` holds ZERO abilities on
 * `Department`, and `admin/dna-writing-styles` needs `manage`). Both catalogs
 * already had owner-scoped, CLS-derived equivalents on the non-admin plane, so
 * the fix is to CALL them — no widened admin gate, no new route.
 */
describe('clinician-plane scoping catalogs (P-4)', () => {
  it('listScopingDepartments reads the caller-scoped assignments, never admin/departments', async () => {
    const calls = installFetchMock(() =>
      Response.json([
        { id: 'assign-1', userId: 'u-1', departmentId: 'dept-derm', departmentName: 'Dermatology', isPrimary: true },
        { id: 'assign-2', userId: 'u-1', departmentId: 'dept-gp', departmentCode: 'GP', isPrimary: false },
      ]),
    );

    const departments = await listScopingDepartments();

    // The ownership boundary is the ROUTE: `users/me/departments` derives the
    // user from CLS, so there is no id a caller could smuggle.
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('/api/hope/users/me/departments');
    expect(calls[0].url).not.toContain('admin/');
    // `departmentId` is the id the consultation is opened with — NOT the
    // assignment row id, which would be meaningless to the gateway.
    expect(departments).toEqual([
      { id: 'dept-derm', name: 'Dermatology' },
      { id: 'dept-gp', name: 'GP' },
    ]);
  });

  it('listDnaStyleOptions reads the caller-owned reports, never admin/dna-writing-styles', async () => {
    const calls = installFetchMock(() =>
      Response.json([
        { id: 'dna-2', doctorId: 'u-1', isLatest: true, currentVersionNumber: 4, createdAt: '2026-08-20T10:00:00.000Z' },
        { id: 'dna-1', doctorId: 'u-1', isLatest: false, currentVersionNumber: 2, createdAt: '2026-07-01T10:00:00.000Z' },
      ]),
    );

    const styles = await listDnaStyleOptions();

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('/api/hope/dna-writing-styles/mine');
    expect(calls[0].url).not.toContain('admin/');
    // Every row here belongs to the SAME doctor, so the old
    // `doctorName ?? doctorId ?? id` label rendered N identical options.
    // Version + recency is what distinguishes one of my styles from another.
    expect(styles.map((s) => s.id)).toEqual(['dna-2', 'dna-1']);
    expect(styles[0].label).toContain('v4');
    expect(styles[0].label).toContain('latest');
    expect(styles[1].label).toContain('v2');
    expect(new Set(styles.map((s) => s.label)).size).toBe(2);
  });
});
