import { HttpException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreSummaryRequest } from '../dto/pre-summary.request';
import type { PreSummaryResponse, SummaryResponse } from '../dto/summary.response';
import { SyncSummaryRequest } from '../dto/sync-summary.request';
import { resolveDepartmentVisit, SmrCompatController } from '../smr-compat.controller';

const createMockHttpService = () => ({
  axiosRef: { post: vi.fn(), get: vi.fn() },
});

/**
 * Minimal Express `Response` double capturing everything the streaming +
 * non-streaming paths touch: header sets, `flushHeaders`, every `write`, `end`,
 * `status().json()`, and the `close` listener.
 */
const createMockRes = () => {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    writes: [] as string[],
    jsonBody: undefined as unknown,
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn((k: string, v: string) => {
      res.headers[k] = v;
    }),
    flushHeaders: vi.fn(() => {
      res.headersSent = true;
    }),
    write: vi.fn((s: string) => {
      res.writes.push(s);
      return true;
    }),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.jsonBody = body;
      res.writableEnded = true;
      return res;
    }),
    on: vi.fn(() => res),
  };
  return res;
};

/** All bytes written to the mock response, concatenated. */
const written = (res: ReturnType<typeof createMockRes>): string => res.writes.join('');

/** Parse the `data` payload of the FIRST SSE frame with the given event name. */
const sseEventData = (res: ReturnType<typeof createMockRes>, event: string): unknown => {
  const frame = written(res)
    .split('\n\n')
    .find((f) => f.startsWith(`event: ${event}\n`) || f.includes(`\nevent: ${event}\n`) || f.startsWith(`event: ${event}\r`));
  if (!frame) return undefined;
  const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
  return dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : undefined;
};

/** Build one SMR SSE frame the way `apps/smr` emits it. */
const smrFrame = (type: string, extra: Record<string, unknown> = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

/** Let the mocked stream's buffered `data`/`end` events flush to the handler. */
const flushStream = () => new Promise((r) => setImmediate(r));

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
const createMockHarnessPolicy = () => ({
  resolveSmrSelection: vi.fn(async () => ({ provider: 'lm-studio', model: 'gemma-4' })),
  // TASK-588: per-tenant fallback resolver (fail-open — null = no fallback configured).
  resolveSmrFallbackSelection: vi.fn(async (): Promise<{ provider: string; model: string } | null> => null),
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

describe('resolveDepartmentVisit (frozen wire contract, TASK-560 item 1)', () => {
  it('prefers the top-level department/visit_type when non-empty', () => {
    const r = resolveDepartmentVisit(
      { department: 'Cardiology', visit_type: 'Follow-up' },
      { session_metadata: { department: 'Neurology', visit_type: 'New' }, session_type: 'routine' },
    );
    expect(r).toEqual({ department: 'Cardiology', visitType: 'Follow-up' });
  });

  it('falls back to session_metadata aliases (first non-empty) when top-level is absent/blank', () => {
    const r = resolveDepartmentVisit(
      { department: '  ' },
      { session_metadata: { current_department: 'Surgery', encounter: 'New Referral' } },
    );
    expect(r).toEqual({ department: 'Surgery', visitType: 'New Referral' });
  });

  it('honors the alias precedence order for department and visit type', () => {
    const r = resolveDepartmentVisit(
      {},
      { session_metadata: { department_name: 'Ortho', dept: 'IGNORED', visit: 'Review', encounter_type: 'IGNORED' } },
    );
    expect(r.department).toBe('Ortho');
    expect(r.visitType).toBe('Review');
  });

  it('uses session_type as the last-resort visit type', () => {
    const r = resolveDepartmentVisit({}, { session_type: 'consultation', session_metadata: {} });
    expect(r.visitType).toBe('consultation');
    expect(r.department).toBeUndefined();
  });

  it('returns undefined for both when nothing resolves', () => {
    expect(resolveDepartmentVisit({}, {})).toEqual({ department: undefined, visitType: undefined });
  });
});

describe('SyncSummaryRequest validation', () => {
  it('accepts v1 previous_visit_summary in session_data', async () => {
    const request = syncRequest({
      session_data: { ...syncRequest().session_data, previous_visit_summary: null },
    });
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });
    const transformed = await pipe.transform(request, {
      type: 'body',
      metatype: SyncSummaryRequest,
    } as never);

    expect((transformed as SyncSummaryRequest).session_data.previous_visit_summary).toBeNull();
  });

  it('accepts session_data with no session_id (consultation-free summarization)', async () => {
    const base = syncRequest();
    delete (base.session_data as { session_id?: string }).session_id;
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });
    const transformed = (await pipe.transform(base, {
      type: 'body',
      metatype: SyncSummaryRequest,
    } as never)) as SyncSummaryRequest;

    expect(transformed.session_data.session_id).toBeUndefined();
  });
});

describe('SmrCompatController', () => {
  let controller: SmrCompatController;
  let http: ReturnType<typeof createMockHttpService>;
  let config: ReturnType<typeof createMockConfigService>;
  let cls: ReturnType<typeof createMockClsService>;
  let secrets: ReturnType<typeof createMockSecrets>;
  let policy: ReturnType<typeof createMockHarnessPolicy>;

  beforeEach(() => {
    vi.clearAllMocks();
    http = createMockHttpService();
    config = createMockConfigService();
    cls = createMockClsService();
    secrets = createMockSecrets();
    policy = createMockHarnessPolicy();
    controller = new SmrCompatController(http as any, config as any, cls as any, policy as any, secrets as any);
  });

  // Drive the real (thin-router) handler with a mock `res`. Non-stream success →
  // returns the captured `res.json(...)` body; a thrown HttpException propagates
  // (computeSummary throws before `res.json`), so error tests keep `.rejects`.
  const invokeSummary = async (body: SyncSummaryRequest, req?: unknown): Promise<SummaryResponse> => {
    const res = createMockRes();
    await controller.summarySync(body, req as never, res as never);
    return res.jsonBody as SummaryResponse;
  };
  const invokePresummary = async (body: PreSummaryRequest, req?: unknown): Promise<PreSummaryResponse> => {
    const res = createMockRes();
    await controller.presummary(body, req as never, res as never);
    return res.jsonBody as PreSummaryResponse;
  };

  describe('POST summary/sync', () => {
    it('posts to SMR /api/v1/generate with the resolved URL + X-Service-Token', async () => {
      http.axiosRef.post.mockResolvedValue({
        data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }), latency_ms: 500, finish_reason: 'stop' },
      });

      await invokeSummary(syncRequest());

      expect(config.getConfigValue).toHaveBeenCalledWith('SMR_URL');
      const [url, body, options] = http.axiosRef.post.mock.calls[0];
      expect(url).toBe('http://localhost:8862/api/v1/generate');
      expect(options.headers['X-Service-Token']).toBe('svc-token-123');
      expect(body.provider).toBe('lm-studio');
      expect(body.model).toBe('gemma-4');
    });
    it('uses the authenticated API-key tenant when CLS has no tenant', async () => {
      cls.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : undefined));
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

      await invokeSummary(syncRequest(), { apiKey: { tenantId: 'tenant-from-key' } } as any);

      expect(policy.resolveSmrSelection).toHaveBeenCalledWith('tenant-from-key');
    });

    it('selects the Simplified schema when use_enhanced_format is false', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      await invokeSummary(syncRequest({ use_enhanced_format: false }));
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.title).toBe('SimplifiedMedicalSummary');
      expect(body.response_format.strict).toBe(true);
    });

    it('selects the Enhanced schema when use_enhanced_format is true', async () => {
      http.axiosRef.post.mockResolvedValue({
        data: { content: JSON.stringify({ encounter_summary: {}, clinical_summary: { summary: 's' } }) },
      });
      await invokeSummary(syncRequest({ use_enhanced_format: true }));
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.response_format.json_schema.title).toBe('EnhancedMedicalSummary');
    });

    it('returns a v1 SummaryResponse echoing the session id and latency', async () => {
      http.axiosRef.post.mockResolvedValue({
        data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }), latency_ms: 777 },
      });
      const res = await invokeSummary(syncRequest());
      expect(res.session_id).toBe('sess-1');
      expect(res.processing_time_ms).toBe(777);
      expect(res.summary.summary).toBe('y');
    });

    it('summarizes with no session_id (no consultation required), synthesizing a smr- id', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      const body = syncRequest();
      delete (body.session_data as { session_id?: string }).session_id;
      const res = await invokeSummary(body);
      expect(res.session_id).toMatch(/^smr-/);
      expect(res.summary.summary).toBe('y');
    });

    it('maps an SMR connection failure to 500 { error: "SMR service unavailable" }', async () => {
      http.axiosRef.post.mockRejectedValue({ code: 'ECONNREFUSED' });
      await expect(invokeSummary(syncRequest())).rejects.toBeInstanceOf(HttpException);
      try {
        await invokeSummary(syncRequest());
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
        await invokeSummary(syncRequest());
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
      await expect(invokeSummary(syncRequest())).rejects.toBeInstanceOf(HttpException);
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    });

    it('echoes v1-parity labels (provider/model/parsing_method/raw_llm_content) reflecting the call', async () => {
      const content = JSON.stringify({ chief_complaint: 'x', summary: 'y' });
      http.axiosRef.post.mockResolvedValue({ data: { content } });
      const res = await invokeSummary(syncRequest());
      expect(res.metadata.llm_provider).toBe('lm-studio');
      expect(res.metadata.model_name).toBe('gemma-4');
      expect(res.metadata.parsing_method).toBe('json_schema');
      expect(res.metadata.raw_llm_content).toBe(content);
    });
  });

  describe('Per-tenant SMR fallback (TASK-588)', () => {
    const good = JSON.stringify({ chief_complaint: 'x', summary: 'y' });

    // (a) primary fails + resolver returns a target → ONE retry on that provider/model.
    it('retries ONCE on the tenant-configured fallback provider/model on an upstream LLM error', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post
        .mockRejectedValueOnce({ response: { status: 500, data: 'llm boom' } })
        .mockResolvedValueOnce({ data: { content: good } });

      const res = await invokeSummary(syncRequest());

      // Resolver consulted with the CLS tenant + the finalize task.
      expect(policy.resolveSmrFallbackSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
      expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
      const [, fbBody] = http.axiosRef.post.mock.calls[1];
      expect(fbBody.provider).toBe('azure-openai');
      expect(fbBody.model).toBe('gpt-4o-foundry');
      // Metadata reflects the provider/model that actually produced the summary.
      expect(res.metadata.llm_provider).toBe('azure-openai');
      expect(res.metadata.model_name).toBe('gpt-4o-foundry');
      expect(res.summary.summary).toBe('y');
    });

    it('retries on the tenant fallback when the primary content is unparseable', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post.mockResolvedValueOnce({ data: { content: 'not json' } }).mockResolvedValueOnce({ data: { content: good } });

      const res = await invokeSummary(syncRequest());

      expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
      expect(res.summary.summary).toBe('y');
    });

    it('resolves the fallback tenant from the authenticated API key when CLS has no tenant', async () => {
      cls.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : undefined));
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post.mockRejectedValueOnce({ response: { status: 500 } }).mockResolvedValueOnce({ data: { content: good } });

      await invokeSummary(syncRequest(), { apiKey: { tenantId: 'tenant-from-key' } } as any);

      expect(policy.resolveSmrFallbackSelection).toHaveBeenCalledWith('tenant-from-key', 'finalize');
    });

    // (b) primary fails + resolver returns null → NO retry, original error surfaced.
    it('does not retry when the tenant has no fallback configured (resolver returns null)', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue(null);
      http.axiosRef.post.mockRejectedValue({ response: { status: 500 } });

      await expect(invokeSummary(syncRequest())).rejects.toBeInstanceOf(HttpException);
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    });

    // (c) resolver target + fallback ALSO fails → surface the ORIGINAL primary error.
    it('surfaces the ORIGINAL primary error when the tenant fallback also fails', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post
        .mockRejectedValueOnce({ response: { status: 502, data: 'primary' } })
        .mockRejectedValueOnce({ response: { status: 500, data: 'fallback' } });

      try {
        await invokeSummary(syncRequest());
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const resp = (err as HttpException).getResponse() as Record<string, unknown>;
        expect(String(resp.detail)).toContain('Summary generation failed');
      }
      expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
    });

    // (d) connect-phase primary failure → resolver NOT consulted, no retry.
    it('does not consult the resolver or fall back when SMR is unreachable (connect-phase failure)', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post.mockRejectedValue({ code: 'ECONNREFUSED' });

      await expect(invokeSummary(syncRequest())).rejects.toBeInstanceOf(HttpException);
      expect(policy.resolveSmrFallbackSelection).not.toHaveBeenCalled();
      const fbCalls = http.axiosRef.post.mock.calls.filter(([, body]) => body.provider === 'azure-openai');
      expect(fbCalls).toHaveLength(0);
    });

    it('does not fall back to itself when the primary provider already is the fallback provider', async () => {
      policy.resolveSmrSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-other' });
      http.axiosRef.post.mockRejectedValue({ response: { status: 500 } });

      await expect(invokeSummary(syncRequest())).rejects.toBeInstanceOf(HttpException);
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST presummary', () => {
    const preRequest = (): PreSummaryRequest =>
      ({ current_department: 'Cardiology', visit_type: 'Follow-up', formatted_vitals: 'BP 142/88' }) as PreSummaryRequest;

    it('applies default temperature/max_tokens and returns the v1 5-section PreSummaryResponse', async () => {
      const markdown = '**Confirmed & Provisional Diagnoses**\n- Hypertension';
      http.axiosRef.post.mockResolvedValue({ data: { content: markdown } });

      const res = await invokePresummary(preRequest());

      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(800);
      expect(res.pre_summary).toContain('Hypertension');
      // v1 guarantees the 5 canonical sections in order.
      expect(res.structured_data.sections).toHaveLength(5);
      expect(res.structured_data.sections[0].title).toBe('Confirmed & Provisional Diagnoses');
      expect(res.structured_data.sections[0].items).toEqual([{ text: 'Hypertension' }]);
    });

    it('honors caller-supplied temperature/max_tokens', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: 'plain text' } });
      await invokePresummary({ ...preRequest(), temperature: 0.7, max_tokens: 1200 } as PreSummaryRequest);
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1200);
    });
  });

  describe('Mandatory tenant-id enforcement (TASK-589)', () => {
    beforeEach(() => {
      // No CLS tenant and (by default) no api key → nothing resolves.
      cls.get.mockReturnValue(undefined);
    });

    it('rejects summary/sync with UnauthorizedException and makes NO SMR call when no tenant resolves', async () => {
      await expect(invokeSummary(syncRequest())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(http.axiosRef.post).not.toHaveBeenCalled();
      expect(policy.resolveSmrSelection).not.toHaveBeenCalled();
    });

    it('rejects presummary with UnauthorizedException and makes NO SMR call when no tenant resolves', async () => {
      await expect(invokePresummary({ current_department: 'Cardiology' } as PreSummaryRequest)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(http.axiosRef.post).not.toHaveBeenCalled();
      expect(policy.resolveSmrSelection).not.toHaveBeenCalled();
    });

    it('passes the resolved tenant (never undefined) to resolveSmrSelection', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      await invokeSummary(syncRequest(), { apiKey: { tenantId: 'tenant-xyz' } });
      expect(policy.resolveSmrSelection).toHaveBeenCalledWith('tenant-xyz');
      expect(policy.resolveSmrSelection).not.toHaveBeenCalledWith(undefined);
    });
  });

  describe('Streaming (stream:true) (TASK-589)', () => {
    // Drive a summary stream: primary START ok → task_id, then feed SMR frames.
    const runSummaryStream = async (frames: string[]) => {
      const smrStream = new PassThrough();
      http.axiosRef.post.mockResolvedValue({ data: { task_id: 't1', status: 'streaming' } });
      http.axiosRef.get.mockResolvedValue({ data: smrStream });
      const res = createMockRes();
      await controller.summarySync(syncRequest({ stream: true }), {} as never, res as never);
      for (const f of frames) smrStream.write(f);
      smrStream.end();
      await flushStream();
      return res;
    };

    it('sets text/event-stream headers, forwards each chunk as a delta, and emits a terminal result', async () => {
      const res = await runSummaryStream([smrFrame('chunk', { content: '{"chief_complaint":"x",' }), smrFrame('chunk', { content: '"summary":"y"}' }), smrFrame('done')]);

      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['X-Accel-Buffering']).toBe('no');
      expect(res.flushHeaders).toHaveBeenCalled();
      // POST carried stream:true.
      expect(http.axiosRef.post.mock.calls[0][1].stream).toBe(true);

      const deltas = written(res)
        .split('\n\n')
        .filter((f) => f.startsWith('event: delta'));
      expect(deltas).toHaveLength(2);
      expect(sseEventData(res, 'delta')).toEqual({ text: '{"chief_complaint":"x",' });

      const result = sseEventData(res, 'result') as SummaryResponse;
      expect(result.session_id).toBe('sess-1');
      expect(result.summary.summary).toBe('y');
      expect(result.metadata.llm_provider).toBe('lm-studio');
      expect(res.end).toHaveBeenCalled();
    });

    it('presummary stream:true emits markdown deltas and a terminal 5-section PreSummaryResponse', async () => {
      const smrStream = new PassThrough();
      http.axiosRef.post.mockResolvedValue({ data: { task_id: 't2' } });
      http.axiosRef.get.mockResolvedValue({ data: smrStream });
      const res = createMockRes();

      await controller.presummary({ current_department: 'Cardiology', stream: true } as PreSummaryRequest, {} as never, res as never);
      smrStream.write(smrFrame('chunk', { content: '**Confirmed & Provisional Diagnoses**\n- Hypertension' }));
      smrStream.write(smrFrame('done'));
      smrStream.end();
      await flushStream();

      expect(sseEventData(res, 'delta')).toEqual({ text: '**Confirmed & Provisional Diagnoses**\n- Hypertension' });
      const result = sseEventData(res, 'result') as PreSummaryResponse;
      expect(result.structured_data.sections).toHaveLength(5);
      expect(result.pre_summary).toContain('Hypertension');
      expect(res.end).toHaveBeenCalled();
    });

    it('retries the tenant fallback provider on a stream START failure, then streams from it', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      const smrStream = new PassThrough();
      http.axiosRef.post
        .mockRejectedValueOnce({ response: { status: 500 } }) // primary START (before any bytes)
        .mockResolvedValueOnce({ data: { task_id: 't3' } }); // fallback START ok
      http.axiosRef.get.mockResolvedValue({ data: smrStream });
      const res = createMockRes();

      await controller.summarySync(syncRequest({ stream: true }), {} as never, res as never);
      smrStream.write(smrFrame('chunk', { content: '{"chief_complaint":"x","summary":"y"}' }));
      smrStream.write(smrFrame('done'));
      smrStream.end();
      await flushStream();

      expect(policy.resolveSmrFallbackSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
      const [, fbBody] = http.axiosRef.post.mock.calls[1];
      expect(fbBody.provider).toBe('azure-openai');
      expect(fbBody.stream).toBe(true);
      const result = sseEventData(res, 'result') as SummaryResponse;
      expect(result.metadata.llm_provider).toBe('azure-openai');
    });

    it('emits a single error event (no task stream opened) when START fails with no fallback', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue(null);
      http.axiosRef.post.mockRejectedValue({ response: { status: 500 } });
      const res = createMockRes();

      await controller.summarySync(syncRequest({ stream: true }), {} as never, res as never);
      await flushStream();

      const errors = written(res)
        .split('\n\n')
        .filter((f) => f.startsWith('event: error'));
      expect(errors).toHaveLength(1);
      expect(http.axiosRef.get).not.toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });

    it('surfaces a mid-stream SMR error frame as a PHI-redacted error event (no upstream content on the wire)', async () => {
      const res = await runSummaryStream([smrFrame('chunk', { content: '{"partial":' }), smrFrame('error', { content: 'SECRET_PHI_LEAK', data: { note: 'SECRET_PHI_LEAK' } })]);

      const out = written(res);
      expect(out).toContain('event: error');
      expect(out).not.toContain('SECRET_PHI_LEAK');
      expect(res.end).toHaveBeenCalled();
    });
  });
});
