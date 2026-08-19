/**
 * HarnessGatewayService Unit Tests
 *
 * The outbound apps/api -> apps/harness adapter. Two calls:
 *   - start(consultationId, ctx)            -> POST {HARNESS_URL}/api/v1/internal/consultations/:id/document:start
 *   - signalApproval(consultationId, body)  -> POST {HARNESS_URL}/api/v1/internal/workflows/:id/signal/approve
 *
 * Both MUST send `X-Service-Token: <HARNESS_SERVICE_TOKEN>` and carry `tenantId`
 * in the body. The harness service itself is mocked here (no live call).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { HarnessGatewayService } from '../harness-gateway.service';

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn().mockResolvedValue({ data: { ok: true } }),
    get: vi.fn().mockResolvedValue({ data: { ok: true } }),
  },
});

const createMockConfigService = (harnessUrl?: string) => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'HARNESS_URL') return harnessUrl;
    return undefined;
  }),
});

const createMockSecretsService = (token?: string) => ({
  getSecretOptional: vi.fn().mockResolvedValue(token),
});

describe('HarnessGatewayService', () => {
  let mockHttpService: ReturnType<typeof createMockHttpService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpService = createMockHttpService();
  });

  const build = (harnessUrl?: string, token?: string) =>
    new HarnessGatewayService(mockHttpService as any, createMockConfigService(harnessUrl) as any, createMockSecretsService(token) as any);

  describe('start', () => {
    it('POSTs to the harness document:start endpoint with tenantId in body and X-Service-Token header', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.start('consultation-1', { tenantId: 'tenant-1', userId: 'doctor-1', jobId: 'job-1' });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/consultations/consultation-1/document:start');
      expect(body).toEqual(expect.objectContaining({ tenantId: 'tenant-1', userId: 'doctor-1', jobId: 'job-1' }));
      expect(options.headers['X-Service-Token']).toBe('harness-token-xyz');
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('defaults the harness base URL to http://localhost:8866 when HARNESS_URL is unset', async () => {
      const service = build(undefined, 'tok');

      await service.start('c-2', { tenantId: 'tenant-2' });

      const [url] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://localhost:8866/api/v1/internal/consultations/c-2/document:start');
    });

    it('returns the harness response payload', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { workflowId: 'harness-doc-c-3' } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.start('c-3', { tenantId: 'tenant-3' });

      expect(result).toEqual({ workflowId: 'harness-doc-c-3' });
    });

    it('forwards transcriptText so the workflow can run NER + sensors on the source', async () => {
      const service = build('http://harness:8866', 'tok');

      await service.start('c-6', {
        tenantId: 'tenant-6',
        contextItemId: 'ctx-tx-6',
        transcriptText: 'Patient reports chest pain. BP 120/80.',
      });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-6',
          contextItemId: 'ctx-tx-6',
          transcriptText: 'Patient reports chest pain. BP 120/80.',
        }),
      );
    });

    it('forwards redactionRules when present', async () => {
      const service = build('http://harness:8866', 'tok');
      const rules = [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' }];

      await service.start('c-7', { tenantId: 'tenant-7', redactionRules: rules });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body.redactionRules).toEqual(rules);
    });

    it('omits redactionRules from the body when empty (byte-identical to previous)', async () => {
      const service = build('http://harness:8866', 'tok');

      await service.start('c-8', { tenantId: 'tenant-8', redactionRules: [] });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body).not.toHaveProperty('redactionRules');
    });

    it('forwards externalPatientId when present (TASK-712, consent-abac Phase 4)', async () => {
      const service = build('http://harness:8866', 'tok');

      await service.start('c-9', { tenantId: 'tenant-9', externalPatientId: 'PAT-20250101-001' });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body.externalPatientId).toBe('PAT-20250101-001');
    });

    it('omits externalPatientId from the body when absent (byte-identical to previous)', async () => {
      const service = build('http://harness:8866', 'tok');

      await service.start('c-10', { tenantId: 'tenant-10' });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body).not.toHaveProperty('externalPatientId');
    });
  });

  describe('signalApproval', () => {
    it('POSTs to the harness approve-signal endpoint with attestation payload + tenantId', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.signalApproval('consultation-9', {
        tenantId: 'tenant-9',
        contextItemVersionId: 'ver-1',
        attestationHash: 'hash-abc',
        clinicianId: 'doctor-9',
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflows/consultation-9/signal/approve');
      expect(body).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-9',
          contextItemVersionId: 'ver-1',
          attestationHash: 'hash-abc',
          clinicianId: 'doctor-9',
        }),
      );
      expect(options.headers['X-Service-Token']).toBe('harness-token-xyz');
    });
  });

  describe('signalEdit', () => {
    it('POSTs to the harness edit-signal endpoint with the edited content + version + editor', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.signalEdit('consultation-9', {
        content: 'S: edited subjective ... P: edited plan',
        contextItemVersionId: 'ver-2',
        editedBy: 'doctor-9',
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflows/consultation-9/signal/edit');
      expect(body).toEqual(
        expect.objectContaining({
          content: 'S: edited subjective ... P: edited plan',
          contextItemVersionId: 'ver-2',
          editedBy: 'doctor-9',
        }),
      );
      expect(options.headers['X-Service-Token']).toBe('harness-token-xyz');
    });

    it('returns the harness response payload', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { workflowId: 'harness-doc-c-9', signaled: true } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.signalEdit('c-9', { content: 'edited' });

      expect(result).toEqual({ workflowId: 'harness-doc-c-9', signaled: true });
    });
  });

  describe('signalContextAdded', () => {
    it('POSTs to the harness context-added-signal endpoint with the context item payload', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.signalContextAdded('consultation-9', {
        tenantId: 'tenant-9',
        contextItemId: 'ctx-1',
        contextType: 'WORKNOTE',
        subType: 'LAB_RESULT',
        contentPreview: 'BP elevated',
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflows/consultation-9/signal/context-added');
      expect(body).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-9',
          contextItemId: 'ctx-1',
          contextType: 'WORKNOTE',
          subType: 'LAB_RESULT',
          contentPreview: 'BP elevated',
        }),
      );
      expect(options.headers['X-Service-Token']).toBe('harness-token-xyz');
    });

    it('returns the harness response payload', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { signaled: true } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.signalContextAdded('c-9', { contextItemId: 'ctx-2', contextType: 'TRANSCRIPT' });

      expect(result).toEqual({ signaled: true });
    });

    // Payload completeness: kindKey/occurredAt/depth/content.
    it('forwards kindKey, occurredAt, depth, and content when the caller supplies them', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.signalContextAdded('consultation-9', {
        contextItemId: 'ctx-1',
        contextType: 'TRANSCRIPT',
        kindKey: 'transcript',
        occurredAt: '2026-08-12T00:00:00.000Z',
        depth: 1,
        content: 'doctor: hello, patient: hi doctor',
      });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body).toEqual(
        expect.objectContaining({
          kindKey: 'transcript',
          occurredAt: '2026-08-12T00:00:00.000Z',
          depth: 1,
          content: 'doctor: hello, patient: hi doctor',
        }),
      );
    });
  });

  describe('signalConsultationEnding', () => {
    it('POSTs to the harness consultation-ending-signal endpoint with the finalize payload', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.signalConsultationEnding('consultation-9', {
        reason: 'recording_stopped',
        persistSnapshot: true,
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflows/consultation-9/signal/consultation-ending');
      expect(body).toEqual(expect.objectContaining({ reason: 'recording_stopped', persistSnapshot: true }));
      expect(options.headers['X-Service-Token']).toBe('harness-token-xyz');
    });

    it('returns the harness response payload', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { workflowId: 'consultation-loop-c-9', signaled: true } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.signalConsultationEnding('c-9', {});

      expect(result).toEqual({ workflowId: 'consultation-loop-c-9', signaled: true });
    });
  });

  describe('signalLoopCancel', () => {
    it('POSTs to the harness loop-cancel-signal endpoint with the reason', async () => {
      const service = build('http://harness:8866', 'harness-token-xyz');

      await service.signalLoopCancel('consultation-9', { reason: 'abandoned' });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflows/consultation-9/signal/loop-cancel');
      expect(body).toEqual(expect.objectContaining({ reason: 'abandoned' }));
      expect(options.headers['X-Service-Token']).toBe('harness-token-xyz');
    });

    it('returns the harness response payload', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { workflowId: 'consultation-loop-c-9', signaled: true } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.signalLoopCancel('c-9', {});

      expect(result).toEqual({ workflowId: 'consultation-loop-c-9', signaled: true });
    });
  });

  describe('service token resolution', () => {
    it('sends an empty X-Service-Token when no secret is configured (fail-open header, harness guard rejects)', async () => {
      const service = build('http://harness:8866', undefined);

      await service.start('c-4', { tenantId: 'tenant-4' });

      const [, , options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(options.headers['X-Service-Token']).toBe('');
    });

    it('tolerates a missing SecretsService (optional dependency)', async () => {
      const service = new HarnessGatewayService(mockHttpService as any, createMockConfigService('http://harness:8866') as any, undefined);

      await service.signalApproval('c-5', { tenantId: 'tenant-5' });

      const [, , options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(options.headers['X-Service-Token']).toBe('');
    });
  });

  // TDD item 6: "No decrypted content appears in logs or in any
  // non-PHI-safe field." Every signal call logs only ids/booleans (see the
  // existing `logger.log` calls in `harness-gateway.service.ts`) — this pins
  // that a request carrying real clinical text never leaks it into a log line.
  describe('PHI-safe logging', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('signalContextAdded never logs the content/contentPreview text', async () => {
      const service = build('http://harness:8866', 'tok');
      const clinicalText = 'Patient reports chest pain radiating to the left arm; BP 140/95.';

      await service.signalContextAdded('c-phi', {
        contextItemId: 'ctx-1',
        contextType: 'TRANSCRIPT',
        contentPreview: clinicalText.slice(0, 20),
        content: clinicalText,
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const loggedPayload = JSON.stringify(logSpy.mock.calls[0]);
      expect(loggedPayload).not.toContain(clinicalText);
      expect(loggedPayload).not.toContain('chest pain');
    });

    it('signalConsultationEnding never logs the transcript text', async () => {
      const service = build('http://harness:8866', 'tok');
      const clinicalText = 'S: chest pain. O: BP 140/95. A: hypertension. P: start lisinopril.';

      await service.signalConsultationEnding('c-phi', { transcriptText: clinicalText });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const loggedPayload = JSON.stringify(logSpy.mock.calls[0]);
      expect(loggedPayload).not.toContain(clinicalText);
      expect(loggedPayload).not.toContain('lisinopril');
    });
  });

  describe('startWorkflowRun (TASK-722)', () => {
    it('POSTs to /workflow-runs:start with the runId/sessionId/tenantId/configRef body and the service-token header', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { runId: 'run-1', workflowId: 'workflow-interpreter-run-1', temporalRunId: 't-1', status: 'started' } });
      const service = build('http://harness:8866', 'tok');
      const configRef = { store: 's3', bucket: 'harness-claim-check', key: 'abc123', size: 42, sha256: 'a'.repeat(64), content_type: 'text/plain; charset=utf-8' };

      const result = await service.startWorkflowRun({
        runId: 'run-1',
        sessionId: 'workflow-interpreter-run-1',
        workflowVersionId: 'def-1',
        tenantId: 'tenant-1',
        configRef,
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflow-runs:start');
      expect(body).toEqual({
        runId: 'run-1',
        sessionId: 'workflow-interpreter-run-1',
        workflowVersionId: 'def-1',
        tenantId: 'tenant-1',
        configRef,
        sandbox: false,
        payload: {},
      });
      // The nested ClaimCheckRef keeps `content_type` (snake_case) — the Python
      // model carries no alias of its own.
      expect(body.configRef.content_type).toBe('text/plain; charset=utf-8');
      expect(options.headers['X-Service-Token']).toBe('tok');
      expect(options.timeout).toBe(15_000);
      expect(result.status).toBe('started');
    });

    it('forwards a sandbox flag and payload verbatim (TASK-721 Workbench)', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { runId: 'run-2', workflowId: 'workflow-interpreter-run-2', temporalRunId: 't-2', status: 'started' } });
      const service = build('http://harness:8866', 'tok');
      const configRef = { store: 's3', bucket: 'harness-claim-check', key: 'abc123', size: 42, sha256: 'a'.repeat(64), content_type: 'text/plain; charset=utf-8' };

      await service.startWorkflowRun({
        runId: 'run-2',
        sessionId: 'workflow-interpreter-run-2',
        workflowVersionId: 'def-1',
        tenantId: 'tenant-1',
        configRef,
        sandbox: true,
        payload: { transcript: 'synthetic sample only' },
      });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body.sandbox).toBe(true);
      expect(body.payload).toEqual({ transcript: 'synthetic sample only' });
    });
  });

  describe('getWorkflowRun (TASK-722)', () => {
    it('GETs /workflow-runs/{runId} with the service-token header', async () => {
      mockHttpService.axiosRef.get.mockResolvedValue({ data: { runId: 'run-1', status: 'RUNNING', stages: [], startedAt: '2026-08-16T00:00:00Z', endedAt: null } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.getWorkflowRun('run-1');

      expect(mockHttpService.axiosRef.get).toHaveBeenCalledTimes(1);
      const [url, options] = mockHttpService.axiosRef.get.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflow-runs/run-1');
      expect(options.headers['X-Service-Token']).toBe('tok');
      expect(options.timeout).toBe(15_000);
      expect(result.status).toBe('RUNNING');
    });
  });

  describe('cancelWorkflowRun (TASK-722)', () => {
    it('POSTs to /workflow-runs/{runId}:cancel with an empty body — never a caller-supplied signal name', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { runId: 'run-1', status: 'cancel_requested' } });
      const service = build('http://harness:8866', 'tok');

      const result = await service.cancelWorkflowRun('run-1');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://harness:8866/api/v1/internal/workflow-runs/run-1:cancel');
      expect(body).toEqual({});
      expect(options.headers['X-Service-Token']).toBe('tok');
      expect(options.timeout).toBe(15_000);
      expect(result.status).toBe('cancel_requested');
    });
  });
});
