import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { EvalRunDetail, EvalRunList, GateQueue, GoldenSetList, HarnessAuditList } from '../../api/types';
import { HarnessObservabilityScreen } from '../harness-observability-screen';
import { installFetchStub, sessionPayload, type RecordedCall } from './fetch-stub';

const AUDIT: HarnessAuditList = {
    items: [
        {
            id: 'evt-2',
            tenantId: 'tnt-1',
            consultationId: 'cons-77',
            contextItemVersionId: null,
            action: 'GATE_DECISION',
            modelName: 'gpt-medical',
            modelVersion: '3',
            promptTemplateId: null,
            promptVersion: null,
            sensorScores: {},
            citations: [],
            gateDecision: 'APPROVE',
            clinicianId: 'clin-1',
            attestationHash: null,
            prevHash: 'a'.repeat(64),
            hash: 'b'.repeat(64),
            createdAt: '2026-07-04T16:59:00.000Z',
            createdBy: 'clin-1',
        },
        {
            id: 'evt-1',
            tenantId: 'tnt-1',
            consultationId: 'cons-77',
            contextItemVersionId: null,
            action: 'GENERATE',
            modelName: 'gpt-medical',
            modelVersion: '3',
            promptTemplateId: null,
            promptVersion: null,
            sensorScores: {},
            citations: [],
            gateDecision: null,
            clinicianId: null,
            attestationHash: null,
            prevHash: '0'.repeat(64),
            hash: 'a'.repeat(64),
            createdAt: '2026-07-04T16:30:00.000Z',
            createdBy: null,
        },
    ],
    total: 4812,
    verification: { valid: true, brokenAtIndex: null, reason: null },
};

const BROKEN_AUDIT: HarnessAuditList = {
    ...AUDIT,
    verification: { valid: false, brokenAtIndex: 7, reason: 'hash mismatch at event 7' },
};

const EVAL_RUNS: EvalRunList = {
    items: [
        {
            id: 'run-1',
            tenantId: 'tnt-1',
            goldenSetId: 'gs-1',
            modelName: 'gpt-medical',
            modelVersion: '3',
            promptTemplateId: null,
            promptVersion: null,
            judgeModel: 'judge-1',
            status: 'COMPLETED',
            startedAt: '2026-07-04T10:00:00.000Z',
            completedAt: '2026-07-04T11:00:00.000Z',
            aggregateScores: { caseCount: 120, passCount: 118, overall: 0.94 },
            notes: null,
            createdAt: '2026-07-04T10:00:00.000Z',
            updatedAt: '2026-07-04T11:00:00.000Z',
        },
    ],
    total: 1,
};

const EVAL_RUN_DETAIL: EvalRunDetail = {
    ...EVAL_RUNS.items[0],
    scores: [
        {
            id: 'score-1',
            tenantId: 'tnt-1',
            evalRunId: 'run-1',
            goldenCaseId: 'case-9',
            metric: 'faithfulness',
            score: 4,
            maxScore: 5,
            rationale: 'claims grounded',
            judgeModel: 'judge-1',
            details: null,
            createdAt: '2026-07-04T11:00:00.000Z',
        },
    ],
};

const GATE_QUEUE: GateQueue = {
    items: [
        {
            consultationId: 'cons-42',
            status: 'PENDING_REVIEW',
            pendingSince: '2026-07-04T16:00:00.000Z',
            ageSeconds: 2280,
            generateCount: 1,
            regenCount: 0,
            slaDueAt: '2026-07-05T16:00:00.000Z',
            escalationDueAt: '2026-07-05T04:00:00.000Z',
            slaBreached: false,
            escalated: false,
        },
    ],
    total: 14,
    slaBreachedCount: 2,
    escalatedCount: 0,
    gateSlaSeconds: 86_400,
    gateEscalationSeconds: 43_200,
    policySource: 'tenant',
};

/** TASK-532 B-5 — the board also mounts the golden-sets panel + edit-burden card. */
const GOLDEN_SETS: GoldenSetList = {
    items: [
        {
            id: 'gs-1',
            tenantId: 'tnt-1',
            name: 'GI consultations golden set',
            description: null,
            pinnedVersion: 'v2026.07',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            createdBy: 'u-1',
        },
    ],
    total: 1,
};

function stubRoutes(overrides: { audit?: Response | HarnessAuditList; workingTenantId?: string | null } = {}) {
    return installFetchStub(({ url }: RecordedCall) => {
        if (url === '/api/auth/session') return sessionPayload({ workingTenantId: overrides.workingTenantId });
        if (url === '/api/hope/rbac/check/my-permissions') {
            return { userId: 'u-1', tenantId: 'tnt-1', permissions: [{ action: 'manage', subject: 'HarnessEval' }] };
        }
        if (url.startsWith('/api/hope/admin/harness/golden-sets')) return GOLDEN_SETS;
        // Best-effort per-user grid-layout persistence (TASK-423): the eval-runs grid
        // loads its layout on mount; no saved layout in tests.
        if (url.includes('/user/me/settings')) return [];
        if (url.startsWith('/api/hope/admin/harness/audit')) return overrides.audit ?? AUDIT;
        if (url.startsWith('/api/hope/admin/harness/eval-runs?')) return EVAL_RUNS;
        if (url === '/api/hope/admin/harness/eval-runs/run-1') return EVAL_RUN_DETAIL;
        if (url === '/api/hope/admin/harness/gate-queue') return GATE_QUEUE;
        return undefined;
    });
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('HarnessObservabilityScreen', () => {
    it('renders the intact chain verdict, the audit trail and the gate queue', async () => {
        stubRoutes();
        renderWithProviders(<HarnessObservabilityScreen />);
        expect(await screen.findByRole('heading', { level: 1, name: 'Harness Observability' })).toBeDefined();
        expect(await screen.findByText('Chain intact')).toBeDefined();
        expect(await screen.findByText(/4,812 rows/)).toBeDefined();
        expect(await screen.findByText('GATE_DECISION')).toBeDefined();
        expect(screen.getByRole('grid', { name: 'WORM audit trail' })).toBeDefined();
        expect(await screen.findByText(/waiting 38 min/)).toBeDefined();
        expect(screen.getByText('Breached SLA')).toBeDefined();
    });

    it('mounts the TASK-532 B-5 golden-sets panel and edit-burden card', async () => {
        stubRoutes();
        renderWithProviders(<HarnessObservabilityScreen />);

        expect(await screen.findByRole('list', { name: 'Golden sets' })).toBeDefined();
        expect(screen.getByRole('heading', { level: 2, name: 'Edit burden' })).toBeDefined();
        expect(screen.getByLabelText('Consultation ID')).toBeDefined();
    });

    it('renders the broken-chain variant as a destructive banner', async () => {
        stubRoutes({ audit: BROKEN_AUDIT });
        renderWithProviders(<HarnessObservabilityScreen />);
        expect(await screen.findByText('Chain broken')).toBeDefined();
        expect(await screen.findByText(/tampering suspected/)).toBeDefined();
        expect(screen.getByText(/hash mismatch at event 7/)).toBeDefined();
    });

    it('opens the per-case scores when an eval run row is clicked', async () => {
        const calls = stubRoutes();
        renderWithProviders(<HarnessObservabilityScreen />);
        fireEvent.click(await screen.findByText('120'));
        expect(await screen.findByText('faithfulness')).toBeDefined();
        expect(screen.getByText('case-9')).toBeDefined();
        await waitFor(() => expect(calls.some((call) => call.url === '/api/hope/admin/harness/eval-runs/run-1')).toBe(true));
    });

    it('gates an elevated session without a working tenant and fires no harness reads', async () => {
        const calls = stubRoutes({ workingTenantId: null });
        renderWithProviders(<HarnessObservabilityScreen />);
        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(calls.every((call) => !call.url.startsWith('/api/hope/admin/harness'))).toBe(true);
    });

    it('shows the unverified badge and the error panel when the audit API fails', async () => {
        stubRoutes({ audit: Response.json({ statusCode: 503, message: 'harness unreachable' }, { status: 503 }) });
        renderWithProviders(<HarnessObservabilityScreen />);
        expect(await screen.findByText('Unverified')).toBeDefined();
        expect(await screen.findByText('harness unreachable')).toBeDefined();
        expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
});
