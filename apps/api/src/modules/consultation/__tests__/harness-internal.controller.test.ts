/**
 * HarnessInternalController Unit Tests
 *
 * The inbound /internal/harness/* surface. Thin controller: it delegates each
 * route to HarnessInternalService and is class-guarded by HarnessServiceTokenGuard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { HarnessInternalController } from '../harness-internal.controller';
import { HarnessServiceTokenGuard } from '../harness-service-token.guard';

const mockService = {
    persistEntities: vi.fn(),
    // Read NamedEntity rows the harness reuses as NER priors.
    getEntities: vi.fn(),
    assemble: vi.fn(),
    persistDraft: vi.fn(),
    recordGateDecision: vi.fn(),
    // Second phase of optimistic delivery.
    finalizeAssurance: vi.fn(),
    // Gate SLA-breach escalation record.
    recordEscalation: vi.fn(),
};

describe('HarnessInternalController', () => {
    let controller: HarnessInternalController;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new HarnessInternalController(
            mockService as any,
            undefined as any,
            undefined as any,
            undefined as any,
            undefined as any,
            undefined as any,
        );
    });

    it('is class-guarded by HarnessServiceTokenGuard', () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, HarnessInternalController) as unknown[] | undefined;
        expect(guards).toContain(HarnessServiceTokenGuard);
    });

    it('is @Public() so the boot route-audit passes and the global auth chain defers to the service-token guard', () => {
        // The routes are service-to-service (X-Service-Token), not user-JWT. Without
        // @Public() the boot-time route-permission audit refuses to
        // start, AND a future global APP_GUARD would reject the harness's token calls
        // before HarnessServiceTokenGuard runs. @Public() only sets SKIP_AUTH_KEY — the
        // class-level HarnessServiceTokenGuard still enforces the token.
        const skipAuth = Reflect.getMetadata(SKIP_AUTH_KEY, HarnessInternalController) as boolean | undefined;
        expect(skipAuth).toBe(true);
    });

    // The 4 WORM/draft callbacks forward the Idempotency-Key
    // header into the service so a retried harness callback dedups.
    it('POST entities -> persistEntities(consultationId, dto, idempotencyKey)', async () => {
        mockService.persistEntities.mockResolvedValue({ savedCount: 1, entityIds: ['ne-1'] });
        const dto = { tenantId: 't-1', contextItemId: 'tx-1', entities: [{ text: 'X', type: 'CONDITION' }] };

        const result = await controller.persistEntities('consultation-1', dto as any, 'run-1:persist_entities');

        expect(mockService.persistEntities).toHaveBeenCalledWith('consultation-1', dto, 'run-1:persist_entities');
        expect(result).toEqual({ savedCount: 1, entityIds: ['ne-1'] });
    });

    // The read route the harness `load_entity_priors` activity calls.
    it('GET entities -> getEntities(consultationId, tenantId)', async () => {
        mockService.getEntities.mockResolvedValue({ entities: [{ text: 'X', type: 'DISEASE', umlsCui: 'C1' }] });

        const result = await controller.getEntities('consultation-1', 't-1');

        expect(mockService.getEntities).toHaveBeenCalledWith('consultation-1', 't-1');
        expect(result).toEqual({ entities: [{ text: 'X', type: 'DISEASE', umlsCui: 'C1' }] });
    });

    it('GET entities without tenantId throws (and never touches the service)', async () => {
        await expect(controller.getEntities('consultation-1', undefined)).rejects.toThrow();
        expect(mockService.getEntities).not.toHaveBeenCalled();
    });

    it('POST assemble -> assemble(consultationId, dto) (no dedup — not a WORM write)', async () => {
        mockService.assemble.mockResolvedValue({ userPrompt: 'p', systemPrompt: 's' });
        const dto = { tenantId: 't-1' };

        const result = await controller.assemble('consultation-1', dto as any);

        expect(mockService.assemble).toHaveBeenCalledWith('consultation-1', dto);
        expect(result).toEqual({ userPrompt: 'p', systemPrompt: 's' });
    });

    it('POST draft -> persistDraft(consultationId, dto, idempotencyKey)', async () => {
        mockService.persistDraft.mockResolvedValue({ contextItemId: 'ctx-1' });
        const dto = { tenantId: 't-1', content: 'S: ...' };

        const result = await controller.persistDraft('consultation-1', dto as any, 'run-1:persist_draft');

        expect(mockService.persistDraft).toHaveBeenCalledWith('consultation-1', dto, 'run-1:persist_draft');
        expect(result).toEqual({ contextItemId: 'ctx-1' });
    });

    it('POST gate-decision -> recordGateDecision(consultationId, dto, idempotencyKey)', async () => {
        mockService.recordGateDecision.mockResolvedValue({ recorded: true });
        const dto = { tenantId: 't-1', decision: 'SIGNED', gateDecision: 'PASS', attestationHash: 'h-1', clinicianId: 'doc-1' };

        const result = await controller.recordGateDecision('consultation-1', dto as any, 'run-1:record_gate_decision');

        expect(mockService.recordGateDecision).toHaveBeenCalledWith('consultation-1', dto, 'run-1:record_gate_decision');
        expect(result).toEqual({ recorded: true });
    });

    it('POST entities without the header forwards undefined (dedup no-op)', async () => {
        mockService.persistEntities.mockResolvedValue({ savedCount: 0, entityIds: [] });
        const dto = { tenantId: 't-1', contextItemId: 'tx-1', entities: [] };

        await controller.persistEntities('consultation-1', dto as any);

        expect(mockService.persistEntities).toHaveBeenCalledWith('consultation-1', dto, undefined);
    });

    // The escalation route delegates to recordEscalation
    // and forwards the Idempotency-Key header so a re-delivered escalate_gate dedups.
    it('POST escalation -> recordEscalation(consultationId, dto, idempotencyKey)', async () => {
        mockService.recordEscalation.mockResolvedValue({ recorded: true });
        const dto = { tenantId: 't-1', reason: 'gate_sla_abandoned', jobId: 'harness-doc-1' };

        const result = await controller.recordEscalation('consultation-1', dto as any, 'run-1:escalate_gate');

        expect(mockService.recordEscalation).toHaveBeenCalledWith('consultation-1', dto, 'run-1:escalate_gate');
        expect(result).toEqual({ recorded: true });
    });

    it('POST escalation without the header forwards undefined (dedup no-op)', async () => {
        mockService.recordEscalation.mockResolvedValue({ recorded: true });
        const dto = { tenantId: 't-1', reason: 'gate_sla_breached' };

        await controller.recordEscalation('consultation-1', dto as any);

        expect(mockService.recordEscalation).toHaveBeenCalledWith('consultation-1', dto, undefined);
    });

    // TASK-550 — the worker `fetch_policy` GET, now accepting an optional
    // consultationId so the department default agent's tenant-tier
    // harnessOverrides overlay onto the effective policy.
    describe('GET internal/harness/policy (fetch_policy)', () => {
        const mockPolicyService = { getEffectivePolicy: vi.fn() };
        // CLS fake mirroring effective-config.controller.test.ts: run executes the
        // callback synchronously in a store; set/get operate on it, so the tests can
        // assert the tenant context the service read executed under (set-before-read).
        function fakeCls() {
            const store = new Map<string, unknown>();
            return {
                store,
                run: vi.fn((fn: () => unknown) => fn()),
                set: vi.fn((key: string, value: unknown) => void store.set(key, value)),
                get: vi.fn((key: string) => store.get(key)),
            };
        }

        const buildController = (cls: ReturnType<typeof fakeCls>) =>
            new HarnessInternalController(
                mockService as any,
                mockPolicyService as any,
                cls as any,
                undefined as any,
                undefined as any,
            );

        it('threads consultationId through to getEffectivePolicy(tenantId, { consultationId })', async () => {
            const policy = { source: 'tenant', tenantId: 't-1', coverageThreshold: 0.95 };
            mockPolicyService.getEffectivePolicy.mockResolvedValue(policy);
            const cls = fakeCls();

            const result = await buildController(cls).getEffectivePolicy('t-1', 'consult-1');

            expect(mockPolicyService.getEffectivePolicy).toHaveBeenCalledWith('t-1', { consultationId: 'consult-1' });
            expect(result).toEqual(policy);
        });

        it('preserves the no-consultationId behaviour (undefined consultationId ⇒ same second arg, still passed)', async () => {
            const policy = { source: 'system-default', tenantId: 't-1' };
            mockPolicyService.getEffectivePolicy.mockResolvedValue(policy);
            const cls = fakeCls();

            await buildController(cls).getEffectivePolicy('t-1', undefined);

            expect(mockPolicyService.getEffectivePolicy).toHaveBeenCalledWith('t-1', { consultationId: undefined });
        });

        it('re-establishes CLS pinned to the tenant BEFORE the service read (set-before-read ordering)', async () => {
            const cls = fakeCls();
            // Capture the tenant context observed at read time — proves set() ran first.
            mockPolicyService.getEffectivePolicy.mockImplementation(async () => {
                expect(cls.store.get('tenantId')).toBe('t-1');
                return { source: 'tenant', tenantId: 't-1' };
            });

            await buildController(cls).getEffectivePolicy('t-1', 'consult-1');

            expect(cls.run).toHaveBeenCalled();
            expect(cls.set).toHaveBeenCalledWith('tenantId', 't-1');
            const setOrder = cls.set.mock.invocationCallOrder[0];
            const readOrder = mockPolicyService.getEffectivePolicy.mock.invocationCallOrder[0];
            expect(setOrder).toBeLessThan(readOrder);
        });

        it('rejects a missing tenantId without touching the service', async () => {
            const cls = fakeCls();
            await expect(buildController(cls).getEffectivePolicy(undefined, 'consult-1')).rejects.toThrow();
            expect(mockPolicyService.getEffectivePolicy).not.toHaveBeenCalled();
        });
    });

    describe('POST consultations/:id/progress', () => {
        const mockProgressService = { reportProgress: vi.fn() };

        const buildController = () =>
            new HarnessInternalController(
                mockService as any,
                undefined as any, // harnessPolicyService (unused by progress route)
                undefined as any, // cls (unused by progress route)
                mockProgressService as any,
                undefined as any,
            );

        it('delegates to HarnessProgressService.reportProgress(consultationId, dto)', async () => {
            mockProgressService.reportProgress.mockResolvedValue({ ok: true });
            const dto = { tenantId: 't-1', jobId: 'harness-doc-1', stage: 'drafting_note', label: 'Drafting note', ordinal: 4, total: 5 };

            const result = await buildController().reportProgress('consultation-1', dto as any);

            expect(mockProgressService.reportProgress).toHaveBeenCalledWith('consultation-1', dto);
            expect(result).toEqual({ ok: true });
        });

        it('relays the best-effort { ok: false } ack without throwing (progress must never fail the workflow)', async () => {
            mockProgressService.reportProgress.mockResolvedValue({ ok: false });

            const result = await buildController().reportProgress('consultation-1', { tenantId: 't-1', stage: 'generating' } as any);

            expect(result).toEqual({ ok: false });
        });

        it('responds 200 (not 201): nothing is created — the ack can carry { ok: false }', () => {
            const statusCode = Reflect.getMetadata(
                HTTP_CODE_METADATA,
                HarnessInternalController.prototype.reportProgress,
            ) as number | undefined;
            expect(statusCode).toBe(200);
        });
    });

    describe('POST consultations/:id/assurance (finalize) + assurance-event (per-claim)', () => {
        const mockAssuranceService = { reportClaim: vi.fn(), publishComplete: vi.fn() };

        const buildController = () =>
            new HarnessInternalController(
                mockService as any,
                undefined as any, // harnessPolicyService (unused by these routes)
                undefined as any, // cls (unused by these routes)
                undefined as any, // harnessProgressService (unused by these routes)
                mockAssuranceService as any,
            );

        it('POST assurance -> harnessInternalService.finalizeAssurance(consultationId, dto, idempotencyKey)', async () => {
            mockService.finalizeAssurance.mockResolvedValue({ recorded: true, contextItemId: 'ctx-draft-1' });
            const dto = { tenantId: 't-1', contextItemId: 'ctx-draft-1', gateDecision: 'PASS' };

            const result = await buildController().finalizeAssurance('consultation-1', dto as any, 'run-1:finalize_assurance');

            expect(mockService.finalizeAssurance).toHaveBeenCalledWith('consultation-1', dto, 'run-1:finalize_assurance');
            expect(result).toEqual({ recorded: true, contextItemId: 'ctx-draft-1' });
        });

        it('POST assurance-event -> harnessAssuranceService.reportClaim(consultationId, dto)', async () => {
            mockAssuranceService.reportClaim.mockResolvedValue({ ok: true });
            const dto = { tenantId: 't-1', jobId: 'job-1', claimId: 'c-1', sensor: 'groundedness', verdict: 'grounded', ordinal: 1, total: 3 };

            const result = await buildController().reportAssuranceClaim('consultation-1', dto as any);

            expect(mockAssuranceService.reportClaim).toHaveBeenCalledWith('consultation-1', dto);
            expect(result).toEqual({ ok: true });
        });

        it('relays the best-effort { ok: false } per-claim ack without throwing (live feed must never fail the workflow)', async () => {
            mockAssuranceService.reportClaim.mockResolvedValue({ ok: false });

            const result = await buildController().reportAssuranceClaim('consultation-1', {
                tenantId: 't-1',
                claimId: 'c-1',
                sensor: 'safety',
                verdict: 'flag',
            } as any);

            expect(result).toEqual({ ok: false });
        });

        it('assurance-event responds 200 (not 201): nothing is created — the ack can carry { ok: false }', () => {
            const statusCode = Reflect.getMetadata(
                HTTP_CODE_METADATA,
                HarnessInternalController.prototype.reportAssuranceClaim,
            ) as number | undefined;
            expect(statusCode).toBe(200);
        });
    });

    // the harness `report_trajectory` batch ingest.
    describe('POST internal/harness/trajectory (ordered-trajectory ingest)', () => {
        const mockTrajectoryService = { recordSteps: vi.fn() };
        // The ingest re-establishes CLS from the batch tenantId (like /policy),
        // so cls.run must invoke the callback and cls.set must be observable.
        const mockCls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };

        const buildController = () =>
            new HarnessInternalController(
                mockService as any,
                undefined as any, // harnessPolicyService (unused by trajectory)
                mockCls as any,
                undefined as any, // harnessProgressService (unused)
                undefined as any, // harnessAssuranceService (unused)
                mockTrajectoryService as any,
            );

        it('maps the harness batch (ISO → Date) and delegates to recordSteps, acking 202-style', async () => {
            mockTrajectoryService.recordSteps.mockResolvedValue(undefined);
            const dto = {
                steps: [
                    {
                        tenantId: 't-1',
                        consultationId: 'consult-1',
                        sessionKind: 'HARNESS_DOC',
                        sessionId: 'wf-1',
                        runId: 'run-1',
                        seq: 0,
                        stepType: 'PHASE',
                        name: 'init',
                        status: 'OK',
                        startedAt: '2026-07-19T00:00:00.000Z',
                        endedAt: '2026-07-19T00:00:01.000Z',
                        durationMs: 1000,
                    },
                ],
            };

            const result = await buildController().reportTrajectory(dto as any, 'run-1:phase-init');

            expect(mockTrajectoryService.recordSteps).toHaveBeenCalledTimes(1);
            const passed = mockTrajectoryService.recordSteps.mock.calls[0][0] as any[];
            expect(passed[0].startedAt).toBeInstanceOf(Date);
            expect(passed[0].endedAt).toBeInstanceOf(Date);
            expect(passed[0].tenantId).toBe('t-1');
            expect(passed[0].sessionKind).toBe('HARNESS_DOC');
            expect(result).toEqual({ accepted: 1 });
            // CLS re-established from the batch tenantId for the tenant-scope extension.
            expect(mockCls.set).toHaveBeenCalledWith('tenantId', 't-1');
        });

        it('B1: floors a fractional durationMs into the Int column instead of dropping the batch', async () => {
            mockTrajectoryService.recordSteps.mockResolvedValue(undefined);
            const dto = {
                steps: [
                    {
                        tenantId: 't-1',
                        sessionKind: 'HARNESS_DOC',
                        sessionId: 'wf-1',
                        runId: 'run-1',
                        seq: 0,
                        stepType: 'LLM_CALL',
                        name: 'generate',
                        status: 'OK',
                        startedAt: '2026-07-19T00:00:00.000Z',
                        durationMs: 12.7,
                    },
                ],
            };

            await buildController().reportTrajectory(dto as any, 'run-1:llm');

            const passed = mockTrajectoryService.recordSteps.mock.calls[0][0] as any[];
            expect(passed[0].durationMs).toBe(12);
        });

        it('is resilient to an empty batch — no-op ack, never touches the service or 5xxs', async () => {
            const result = await buildController().reportTrajectory({ steps: [] } as any);

            expect(mockTrajectoryService.recordSteps).not.toHaveBeenCalled();
            expect(result).toEqual({ accepted: 0 });
        });

        it('responds 202 (accepted, async ingest) rather than the default POST 201', () => {
            const statusCode = Reflect.getMetadata(
                HTTP_CODE_METADATA,
                HarnessInternalController.prototype.reportTrajectory,
            ) as number | undefined;
            expect(statusCode).toBe(202);
        });
    });
});
