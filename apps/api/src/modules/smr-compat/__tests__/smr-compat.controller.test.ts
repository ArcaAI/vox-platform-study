import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreSummaryRequest } from '../dto/pre-summary.request';
import type { SyncSummaryRequest } from '../dto/sync-summary.request';
import { SmrCompatController } from '../smr-compat.controller';

const createMockHttpService = () => ({
  axiosRef: { post: vi.fn() },
});

const createMockConfigService = () => ({
  getConfigValue: vi.fn((key: string) => (key === 'SMR_URL' ? 'http://localhost:8862' : undefined)),
});

const createMockClsService = () => ({
  get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)),
  getId: vi.fn(() => 'req-test-id'),
});

const createMockSecrets = () => ({
  getSecretSync: vi.fn((key: string) => (key === 'SMR_SERVICE_TOKEN' ? 'svc-token-123' : undefined)),
});

const syncRequest = (overrides: Partial<SyncSummaryRequest> = {}): SyncSummaryRequest =>
  ({
    session_data: {
      session_id: 'sess-1',
      created_at: '2026-07-27T09:30:00Z',
      conversation_segments: [
        { speaker: 'provider', text: 'What brings you in?', timestamp: '2026-07-27T09:30:05Z' },
        { speaker: 'patient', text: 'Chest tightness.', timestamp: '2026-07-27T09:30:12Z' },
      ],
      session_metadata: { language: 'en' },
    },
    department: 'Cardiology',
    ...overrides,
  }) as SyncSummaryRequest;

describe('SmrCompatController', () => {
  let controller: SmrCompatController;
  let http: ReturnType<typeof createMockHttpService>;
  let config: ReturnType<typeof createMockConfigService>;
  let cls: ReturnType<typeof createMockClsService>;
  let secrets: ReturnType<typeof createMockSecrets>;

  beforeEach(() => {
    vi.clearAllMocks();
    http = createMockHttpService();
    config = createMockConfigService();
    cls = createMockClsService();
    secrets = createMockSecrets();
    controller = new SmrCompatController(http as any, config as any, cls as any, secrets as any);
  });

  describe('POST summary/sync', () => {
    it('posts to SMR /api/v1/generate with the resolved URL + X-Service-Token', async () => {
      http.axiosRef.post.mockResolvedValue({
        data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }), latency_ms: 500, finish_reason: 'stop' },
      });

      await controller.summarySync(syncRequest());

      expect(config.getConfigValue).toHaveBeenCalledWith('SMR_URL');
      const [url, , options] = http.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://localhost:8862/api/v1/generate');
      expect(options.headers['X-Service-Token']).toBe('svc-token-123');
    });

    it('selects the Simplified schema when use_enhanced_format is false', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      await controller.summarySync(syncRequest({ use_enhanced_format: false }));
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.title).toBe('SimplifiedMedicalSummary');
      expect(body.response_format.strict).toBe(true);
    });

    it('selects the Enhanced schema when use_enhanced_format is true', async () => {
      http.axiosRef.post.mockResolvedValue({
        data: { content: JSON.stringify({ encounter_summary: {}, clinical_summary: { summary: 's' } }) },
      });
      await controller.summarySync(syncRequest({ use_enhanced_format: true }));
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.response_format.json_schema.title).toBe('EnhancedMedicalSummary');
    });

    it('returns a v1 SummaryResponse echoing the session id and latency', async () => {
      http.axiosRef.post.mockResolvedValue({
        data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }), latency_ms: 777 },
      });
      const res = await controller.summarySync(syncRequest());
      expect(res.session_id).toBe('sess-1');
      expect(res.processing_time_ms).toBe(777);
      expect(res.summary.summary).toBe('y');
    });

    it('does not omit the model → SMR resolves the tenant default (no provider/model in the body)', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      await controller.summarySync(syncRequest());
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body).not.toHaveProperty('provider');
      expect(body).not.toHaveProperty('model');
    });

    it('maps an SMR connection failure to 500 { error: "SMR service unavailable" }', async () => {
      http.axiosRef.post.mockRejectedValue({ code: 'ECONNREFUSED' });
      await expect(controller.summarySync(syncRequest())).rejects.toBeInstanceOf(HttpException);
      try {
        await controller.summarySync(syncRequest());
      } catch (err) {
        const resp = (err as HttpException).getResponse() as Record<string, unknown>;
        expect((err as HttpException).getStatus()).toBe(500);
        expect(resp.error).toBe('SMR service unavailable');
        expect(resp).toHaveProperty('requestId');
      }
    });

    it('maps unparseable LLM content to 500 { detail: "Summary generation failed: ..." }', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: 'not json' } });
      try {
        await controller.summarySync(syncRequest());
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const resp = (err as HttpException).getResponse() as Record<string, unknown>;
        expect((err as HttpException).getStatus()).toBe(500);
        expect(String(resp.detail)).toContain('Summary generation failed');
      }
    });

    it('does not retry after an upstream response (single-delivery for the billable call)', async () => {
      http.axiosRef.post.mockRejectedValue({ response: { status: 502, data: 'boom' } });
      await expect(controller.summarySync(syncRequest())).rejects.toBeInstanceOf(HttpException);
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST presummary', () => {
    const preRequest = (): PreSummaryRequest =>
      ({ current_department: 'Cardiology', visit_type: 'Follow-up', formatted_vitals: 'BP 142/88' }) as PreSummaryRequest;

    it('applies default temperature/max_tokens and returns a v1 PreSummaryResponse', async () => {
      const markdown = '**Diagnoses**\n- Hypertension';
      http.axiosRef.post.mockResolvedValue({ data: { content: markdown } });

      const res = await controller.presummary(preRequest());

      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(800);
      expect(res.pre_summary).toContain('Hypertension');
      expect(res.structured_data.sections[0].title).toBe('Diagnoses');
    });

    it('honors caller-supplied temperature/max_tokens', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: 'plain text' } });
      await controller.presummary({ ...preRequest(), temperature: 0.7, max_tokens: 1200 } as PreSummaryRequest);
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1200);
    });
  });
});
