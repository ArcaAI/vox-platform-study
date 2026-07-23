import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    cancelWorkflow,
    getEvalRun,
    getGateQueue,
    getHarnessAudit,
    getLiveSession,
    getWorkflow,
    listEvalRuns,
    listGateEditExemplars,
    listLiveSessions,
    listWorkflows,
    signalWorkflow,
    terminateWorkflow,
} from '../client';
import { harnessOpsKeys } from '../keys';

interface RecordedCall {
    url: string;
    method: string;
    body: unknown;
}

function installFetchMock(): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(input),
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return Response.json({ success: true });
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('harnessOpsKeys', () => {
    it('is stable and separates audit, evals, gate queue, workflows and live sessions', () => {
        expect(harnessOpsKeys.audit({ action: 'GENERATE' })).toEqual(harnessOpsKeys.audit({ action: 'GENERATE' }));
        expect(harnessOpsKeys.audit()).not.toEqual(harnessOpsKeys.evalRuns());
        expect(harnessOpsKeys.evalRun('run-1')).not.toEqual(harnessOpsKeys.evalRuns());
        expect(harnessOpsKeys.workflows({ status: 'RUNNING' })).not.toEqual(harnessOpsKeys.workflows());
        expect(harnessOpsKeys.workflow('wf-1')).not.toEqual(harnessOpsKeys.workflow('wf-2'));
        expect(harnessOpsKeys.liveSession('cons-1')).not.toEqual(harnessOpsKeys.liveSessions());
        expect(harnessOpsKeys.gateQueue()[0]).toBe('harness-ops');
        expect(harnessOpsKeys.gateEditExemplars({ departmentId: 'd-1' })).not.toEqual(harnessOpsKeys.gateEditExemplars());
    });
});

describe('harness-ops client — observe', () => {
    it('reads the WORM audit trail with server-side filters and never sends tenantId', async () => {
        const calls = installFetchMock();
        await getHarnessAudit();
        await getHarnessAudit({ action: 'GATE_DECISION', from: '2026-06-28T00:00:00.000Z', limit: 50, offset: 0 });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/harness/audit',
            'GET /api/hope/admin/harness/audit?action=GATE_DECISION&from=2026-06-28T00%3A00%3A00.000Z&limit=50&offset=0',
        ]);
        // ?tenantId= is platform-only on the gateway; the BFF proxy scopes via X-Tenant-Id.
        expect(calls.every((call) => !call.url.includes('tenantId'))).toBe(true);
    });

    it('lists eval runs (1-based page) and fetches one run with its per-case scores', async () => {
        const calls = installFetchMock();
        await listEvalRuns({ page: 1, limit: 20 });
        await getEvalRun('run-1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/harness/eval-runs?page=1&limit=20',
            'GET /api/hope/admin/harness/eval-runs/run-1',
        ]);
    });

    it('reads the clinician gate queue', async () => {
        const calls = installFetchMock();
        await getGateQueue();
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/harness/gate-queue']);
    });
});

describe('harness-ops client — workflows', () => {
    it('lists workflows with the Temporal cursor params and describes one with the loop phase', async () => {
        const calls = installFetchMock();
        await listWorkflows();
        await listWorkflows({ status: 'RUNNING', limit: 50, pageToken: 'tok==' });
        await getWorkflow('harness-doc-c1', { phase: true });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/harness/workflows',
            'GET /api/hope/admin/harness/workflows?status=RUNNING&limit=50&pageToken=tok%3D%3D',
            'GET /api/hope/admin/harness/workflows/harness-doc-c1?phase=true',
        ]);
    });

    it('signals a workflow with the DTO body (signalName + JSON object payload)', async () => {
        const calls = installFetchMock();
        await signalWorkflow('harness-doc-c1', { signalName: 'approve', payload: { note: 'ok' } });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/hope/admin/harness/workflows/harness-doc-c1/signal',
        ]);
        expect(calls[0].body).toEqual({ signalName: 'approve', payload: { note: 'ok' } });
    });

    it('cancels and terminates with an always-present JSON body (reason optional)', async () => {
        const calls = installFetchMock();
        await cancelWorkflow('harness-doc-c1', { reason: 'stuck' });
        await terminateWorkflow('harness-doc-c1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST /api/hope/admin/harness/workflows/harness-doc-c1/cancel',
            'POST /api/hope/admin/harness/workflows/harness-doc-c1/terminate',
        ]);
        expect(calls[0].body).toEqual({ reason: 'stuck' });
        // The gateway's strict ValidationPipe needs a JSON object, not an absent body.
        expect(calls[1].body).toEqual({});
    });

    it('escapes workflow ids in paths', async () => {
        const calls = installFetchMock();
        await getWorkflow('wf/with space');
        expect(calls[0].url).toBe('GET /api/hope/admin/harness/workflows/wf%2Fwith%20space'.replace('GET ', ''));
    });
});

describe('harness-ops client — gate-edit exemplars', () => {
    it('exports corpus candidates with department/quality-signal/limit filters', async () => {
        const calls = installFetchMock();
        await listGateEditExemplars();
        await listGateEditExemplars({ departmentId: 'd-1', qualitySignal: 'HEAVILY_EDITED', limit: 20 });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/harness/gate-edit-exemplars',
            'GET /api/hope/admin/harness/gate-edit-exemplars?departmentId=d-1&qualitySignal=HEAVILY_EDITED&limit=20',
        ]);
    });
});

describe('harness-ops client — live sessions', () => {
    it('lists active live-doc sessions and reads one session stats snapshot', async () => {
        const calls = installFetchMock();
        await listLiveSessions();
        await getLiveSession('cons-1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /api/hope/admin/harness/live/sessions',
            'GET /api/hope/admin/harness/live/sessions/cons-1',
        ]);
    });
});
