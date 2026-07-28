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
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HarnessGatewayService } from '../harness-gateway.service';

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn().mockResolvedValue({ data: { ok: true } }),
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

    it('forwards redactionRules (TASK-551) when present', async () => {
      const service = build('http://harness:8866', 'tok');
      const rules = [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' }];

      await service.start('c-7', { tenantId: 'tenant-7', redactionRules: rules });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body.redactionRules).toEqual(rules);
    });

    it('omits redactionRules from the body when empty (byte-identical to pre-TASK-551)', async () => {
      const service = build('http://harness:8866', 'tok');

      await service.start('c-8', { tenantId: 'tenant-8', redactionRules: [] });

      const [, body] = mockHttpService.axiosRef.post.mock.calls[0];
      expect(body).not.toHaveProperty('redactionRules');
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
});
