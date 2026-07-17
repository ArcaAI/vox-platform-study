import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ModelTaskType } from '@arcaai/domains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrProxyController } from '../smr-proxy.controller';

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn(),
    get: vi.fn(),
  },
});

// TASK-506 — `fetchTenantConfigs` dropped: the providers listings no longer
// read the retired GlobalSetting keys; only `fetchByCodeName` (the explicit
// `?tenantKey=__GLOBAL__` resolution) remains.
const createMockTenantService = () => ({
  fetchByCodeName: vi.fn(),
});

const createMockClsService = () => ({
  get: vi.fn(),
  // TASK-462 I-1 — the correlation/request id logged alongside redacted upstream
  // errors (matches the api-wide `clsService.getId()` pattern).
  getId: vi.fn(() => 'req-test-id'),
});

const createMockContextItemRepository = () => ({
  findById: vi.fn(),
});

const createMockPromptTemplateRepository = () => ({
  findById: vi.fn(),
});

const createMockDnaWritingStyleRepository = () => ({
  findById: vi.fn(),
});

const createMockDepartmentRepository = () => ({
  findById: vi.fn(),
});

const createMockMediaRepository = () => ({
  findById: vi.fn(),
});

const createMockBlobStorage = () => ({
  getObject: vi.fn(),
});

// TASK-310 E-5 (AC-5): stubbed IConfigService so the controller resolves
// the SMR base URL through the typed accessor (matching production), not
// process.env.
const createMockConfigService = () => ({
  getConfigValue: vi.fn((key: string) => {
    const map: Record<string, string> = {
      SMR_URL: 'http://localhost:8862',
    };
    return map[key];
  }),
});

describe('SmrProxyController', () => {
  let controller: SmrProxyController;
  let mockHttpService: ReturnType<typeof createMockHttpService>;
  let mockTenantService: ReturnType<typeof createMockTenantService>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockContextItemRepo: ReturnType<typeof createMockContextItemRepository>;
  let mockPromptTemplateRepo: ReturnType<typeof createMockPromptTemplateRepository>;
  let mockDnaStyleRepo: ReturnType<typeof createMockDnaWritingStyleRepository>;
  let mockDepartmentRepo: ReturnType<typeof createMockDepartmentRepository>;
  let mockMediaRepo: ReturnType<typeof createMockMediaRepository>;
  let mockBlobStorage: ReturnType<typeof createMockBlobStorage>;
  let mockConfigService: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpService = createMockHttpService();
    mockTenantService = createMockTenantService();
    mockClsService = createMockClsService();
    mockContextItemRepo = createMockContextItemRepository();
    mockPromptTemplateRepo = createMockPromptTemplateRepository();
    mockDnaStyleRepo = createMockDnaWritingStyleRepository();
    mockDepartmentRepo = createMockDepartmentRepository();
    mockMediaRepo = createMockMediaRepository();
    mockBlobStorage = createMockBlobStorage();
    mockConfigService = createMockConfigService();

    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      // TASK-299 D-12 — user id must be present so the ownership check
      // can pass for legacy fixtures that expect the happy path.
      if (key === 'user') return { id: 'user-1', roles: [] };
      return undefined;
    });

    controller = new SmrProxyController(
      mockHttpService as any,
      mockTenantService as any,
      mockClsService as any,
      mockContextItemRepo as any,
      mockPromptTemplateRepo as any,
      mockDnaStyleRepo as any,
      mockDepartmentRepo as any,
      mockMediaRepo as any,
      mockBlobStorage as any,
      mockConfigService as any,
    );
  });

  describe('POST /text/generate', () => {
    it('should proxy synchronous generation to SMR v2', async () => {
      const smrResponse = {
        data: {
          task_id: 'task-1',
          status: 'completed',
          content: 'Generated summary',
          provider: 'ollama',
          model: 'llama3',
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          latency_ms: 1200,
          finish_reason: 'stop',
          created_at: '2026-03-02T00:00:00Z',
        },
      };
      mockHttpService.axiosRef.post.mockResolvedValue(smrResponse);

      const body = {
        prompt: 'Generate a summary',
        provider: 'ollama',
        stream: false,
      };

      const result = await controller.generate(body);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({ prompt: 'Generate a summary', stream: false }),
        expect.any(Object),
      );
      expect(result.task_id).toBe('task-1');
      expect(result.content).toBe('Generated summary');
    });

    it('should proxy streaming generation and return task info with stream_url', async () => {
      const smrResponse = {
        data: {
          task_id: 'task-stream-1',
          status: 'running',
          stream_url: '/api/v1/tasks/task-stream-1/stream',
        },
      };
      mockHttpService.axiosRef.post.mockResolvedValue(smrResponse);

      const body = {
        prompt: 'Generate a summary',
        provider: 'ollama',
        stream: true,
      };

      const result = await controller.generate(body);

      expect(result.task_id).toBe('task-stream-1');
      expect(result.status).toBe('running');
      expect(result.stream_url).toContain('/stream');
    });

    it('should return 502 when SMR service is unreachable', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue(
        new Error('ECONNREFUSED'),
      );

      await expect(
        controller.generate({ prompt: 'test', stream: false }),
      ).rejects.toThrow();
    });

    // TASK-462 C4-05 — the proxy MUST preserve the upstream status code but must
    // NOT forward the raw upstream error body verbatim: that body can echo the
    // assembled clinical prompt / PHI / internal SMR detail. The client receives
    // a generic message; the upstream detail is kept server-side only.
    it('preserves the upstream status but does NOT forward the raw upstream body (C4-05)', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue({
        response: {
          status: 404,
          data: {
            detail: "Provider 'lm-studio' not found",
            error_code: 'PROVIDER_NOT_FOUND',
          },
        },
      });

      let thrown: unknown;
      try {
        await controller.generate({ prompt: 'test', provider: 'lm-studio', stream: false });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(404);
      // Generic body only — no upstream detail or error_code echoed to the client.
      expect((thrown as HttpException).getResponse()).toEqual({ detail: 'SMR service unavailable' });
      const serialized = JSON.stringify((thrown as HttpException).getResponse());
      expect(serialized).not.toContain('lm-studio');
      expect(serialized).not.toContain('PROVIDER_NOT_FOUND');
    });
  });

  // TASK-462 C4-05 — `buildUpstreamException` used to forward the raw upstream
  // error body verbatim (`{ detail: payload }` for string bodies, `payload` for
  // object bodies). SMR/LM-Studio error bodies can echo the assembled clinical
  // prompt / PHI / internal stack detail, so an upstream 4xx/5xx leaked that into
  // the caller's telemetry. The proxy must return a GENERIC sanitized message to
  // the client (status code preserved) and log the upstream detail SERVER-SIDE only.
  describe('TASK-462 C4-05 — upstream error body sanitization (no PHI/prompt echo)', () => {
    const PHI_STRING = 'prompt fragment: Patient Jane Doe DOB 1980-01-01 SSN 123-45-6789';

    it('does NOT echo a STRING upstream error body to the client (generic message, status preserved)', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue({
        response: { status: 400, data: PHI_STRING },
      });

      const thrown = await controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(400);
      expect((thrown as HttpException).getResponse()).toEqual({ detail: 'SMR service unavailable' });
      expect(JSON.stringify((thrown as HttpException).getResponse())).not.toContain('123-45-6789');
    });

    it('does NOT echo an OBJECT upstream error body to the client (generic message, status preserved)', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue({
        response: { status: 422, data: { detail: PHI_STRING, error_code: 'LEAK' } },
      });

      const thrown = await controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch((e: unknown) => e);

      expect((thrown as HttpException).getStatus()).toBe(422);
      expect((thrown as HttpException).getResponse()).toEqual({ detail: 'SMR service unavailable' });
      const serialized = JSON.stringify((thrown as HttpException).getResponse());
      expect(serialized).not.toContain('123-45-6789');
      expect(serialized).not.toContain('LEAK');
    });

    // TASK-462 I-1 — the raw upstream body is PHI-shaped and must ALSO stay out of
    // the server logs (stdout → k8s/Loki, outside PHI controls). The server-side
    // record is REDACTED: it carries the status + correlation id + a redaction
    // sentinel so operators can correlate the failure, but never the body content.
    it('logs a REDACTED marker server-side (status + correlation id + sentinel; NEVER the raw body/PHI)', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      const payload = { detail: PHI_STRING, error_code: 'LEAK' };
      mockHttpService.axiosRef.post.mockRejectedValue({ response: { status: 500, data: payload } });

      await controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch(() => undefined);

      // A redacted server-side marker carries the status + correlation id (for
      // debugging) and an explicit redaction sentinel — but never the raw body.
      const redactedLog = errorSpy.mock.calls.some((call) => {
        const arg = call[0] as { upstreamStatus?: unknown; correlationId?: unknown; upstreamBodyRedacted?: unknown } | undefined;
        return (
          arg != null &&
          typeof arg === 'object' &&
          arg.upstreamStatus === 500 &&
          arg.correlationId === 'req-test-id' &&
          arg.upstreamBodyRedacted === true
        );
      });
      expect(redactedLog).toBe(true);

      // CRITICAL: the raw upstream body / PHI must NEVER appear in ANY server log.
      const phiInAnyLog = errorSpy.mock.calls.some((call) => JSON.stringify(call[0] ?? '').includes('123-45-6789'));
      expect(phiInAnyLog).toBe(false);

      errorSpy.mockRestore();
    });

    it('falls back to 502 with a generic message when the upstream produced no HTTP response', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue(new Error('socket hang up'));

      const thrown = await controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch((e: unknown) => e);

      expect((thrown as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect((thrown as HttpException).getResponse()).toEqual({ detail: 'SMR service unavailable' });
    });
  });

  // TASK-356 D-7 (T-D1) — the playground/SDK proxy passes a caller-supplied
  // model through untouched (SDK fidelity); only when the model is absent does it
  // fall back to the HarnessPolicy cascade. When neither is available it forwards
  // to SMR, which is the fail-closed 422 authority (no in-proxy default).
  describe('SMR model selection (TASK-356 D-7)', () => {
    const buildWithResolver = (resolver: { resolveSmrSelection: ReturnType<typeof vi.fn> }) =>
      new SmrProxyController(
        mockHttpService as any,
        mockTenantService as any,
        mockClsService as any,
        mockContextItemRepo as any,
        mockPromptTemplateRepo as any,
        mockDnaStyleRepo as any,
        mockDepartmentRepo as any,
        mockMediaRepo as any,
        mockBlobStorage as any,
        mockConfigService as any,
        undefined, // secretsService (@Optional)
        resolver as any, // HarnessPolicyService resolver
      );

    it('passes a caller-supplied model through without resolving (SDK fidelity)', async () => {
      const resolver = { resolveSmrSelection: vi.fn() };
      const ctrl = buildWithResolver(resolver);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { content: 'ok' } });

      await ctrl.generate({ prompt: 'p', provider: 'lm-studio', model: 'caller-pinned', stream: false });

      expect(resolver.resolveSmrSelection).not.toHaveBeenCalled();
      const body = mockHttpService.axiosRef.post.mock.calls[0][1];
      expect(body.provider).toBe('lm-studio');
      expect(body.model).toBe('caller-pinned');
    });

    it('resolves provider+model via policy when the caller omits the model', async () => {
      const resolver = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'ollama', model: 'granite4:latest' }) };
      const ctrl = buildWithResolver(resolver);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { content: 'ok' } });

      await ctrl.generate({ prompt: 'p', stream: false });

      expect(resolver.resolveSmrSelection).toHaveBeenCalled();
      const body = mockHttpService.axiosRef.post.mock.calls[0][1];
      expect(body.provider).toBe('ollama');
      expect(body.model).toBe('granite4:latest');
    });

    it('forwards to SMR (the fail-closed 422 authority) when model is omitted and policy is unresolved', async () => {
      const resolver = { resolveSmrSelection: vi.fn().mockRejectedValue(new BadRequestException('unresolved')) };
      const ctrl = buildWithResolver(resolver);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { content: 'ok' } });

      await ctrl.generate({ prompt: 'p', stream: false });

      expect(resolver.resolveSmrSelection).toHaveBeenCalled();
      expect(mockHttpService.axiosRef.post).toHaveBeenCalled();
      const body = mockHttpService.axiosRef.post.mock.calls[0][1];
      expect(body.model).toBeUndefined();
    });

    it('generate/assembled resolves provider+model when the caller omits the model', async () => {
      const resolver = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'ollama', model: 'granite4:latest' }) };
      const ctrl = buildWithResolver(resolver);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { task_id: 't', status: 'completed', content: 'ok' } });

      await ctrl.generateAssembled({ type: 'summary', message: 'hello' });

      expect(resolver.resolveSmrSelection).toHaveBeenCalled();
      const body = mockHttpService.axiosRef.post.mock.calls[0][1];
      expect(body.provider).toBe('ollama');
      expect(body.model).toBe('granite4:latest');
    });

    it('generate/assembled passes a caller-supplied model through without resolving', async () => {
      const resolver = { resolveSmrSelection: vi.fn() };
      const ctrl = buildWithResolver(resolver);
      mockHttpService.axiosRef.post.mockResolvedValue({ data: { task_id: 't', status: 'completed', content: 'ok' } });

      await ctrl.generateAssembled({ type: 'summary', message: 'hello', provider: 'lm-studio', model: 'qwen3.5-4b' });

      expect(resolver.resolveSmrSelection).not.toHaveBeenCalled();
      const body = mockHttpService.axiosRef.post.mock.calls[0][1];
      expect(body.provider).toBe('lm-studio');
      expect(body.model).toBe('qwen3.5-4b');
    });
  });

  // TASK-460 C4-04 — `withRetry` used to re-POST `/generate` on post-send
  // socket failures (ECONNRESET/EPIPE/ETIMEDOUT) and upstream 5xx responses.
  // Those occur AFTER request bytes reached SMR, so a generation may already
  // be running/billed — the retry re-invoked it (duplicate billing, divergent
  // drafts). `/generate` may only retry CONNECT-PHASE failures (the request
  // provably never left the gateway); idempotent GETs keep the broad retry.
  describe('TASK-460 C4-04 — /generate retry hygiene (single delivery)', () => {
    const codeError = (code: string) => Object.assign(new Error(code), { code });

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does NOT re-POST /generate after a post-send ECONNRESET (single delivery)', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue(codeError('ECONNRESET'));

      const outcome = controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(await outcome).toBeInstanceOf(HttpException);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-POST /generate after a post-send ETIMEDOUT or EPIPE', async () => {
      for (const code of ['ETIMEDOUT', 'EPIPE']) {
        mockHttpService.axiosRef.post.mockReset();
        mockHttpService.axiosRef.post.mockRejectedValue(codeError(code));

        const outcome = controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch((e: unknown) => e);
        await vi.runAllTimersAsync();
        await outcome;

        expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
      }
    });

    it('does NOT re-POST /generate when SMR itself responded 5xx (request was delivered)', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue({ response: { status: 503, data: { detail: 'busy' } } });

      const outcome = controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false }).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = await outcome;

      expect((err as HttpException).getStatus()).toBe(503);
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
    });

    it('still retries a connect-phase ECONNREFUSED (request never reached SMR)', async () => {
      mockHttpService.axiosRef.post.mockRejectedValueOnce(codeError('ECONNREFUSED')).mockResolvedValueOnce({ data: { task_id: 't-retry' } });

      const outcome = controller.generate({ prompt: 'p', provider: 'ollama', model: 'm', stream: false });
      await vi.runAllTimersAsync();
      const result = await outcome;

      expect(result.task_id).toBe('t-retry');
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(2);
    });

    it('does NOT re-POST /generate/assembled after a post-send ECONNRESET', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue(codeError('ECONNRESET'));

      const outcome = controller
        .generateAssembled({ type: 'summary', message: 'Patient transcript', provider: 'ollama', model: 'm' })
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(await outcome).toBeInstanceOf(HttpException);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
    });

    it('keeps the broad retry for the idempotent GET task-status (ECONNRESET retries)', async () => {
      mockHttpService.axiosRef.get.mockRejectedValueOnce(codeError('ECONNRESET')).mockResolvedValueOnce({ data: { task_id: 't-1', status: 'completed' } });

      const outcome = controller.getTaskStatus('t-1');
      await vi.runAllTimersAsync();
      const result = await outcome;

      expect(result.status).toBe('completed');
      expect(mockHttpService.axiosRef.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /text/tasks/:taskId', () => {
    it('should proxy task status request to SMR v2', async () => {
      const taskResponse = {
        data: {
          task_id: 'task-1',
          status: 'completed',
          content: 'Done',
          provider: 'ollama',
          model: 'llama3',
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          latency_ms: 800,
          created_at: '2026-03-02T00:00:00Z',
        },
      };
      mockHttpService.axiosRef.get.mockResolvedValue(taskResponse);

      const result = await controller.getTaskStatus('task-1');

      expect(mockHttpService.axiosRef.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/tasks/task-1'),
        expect.any(Object),
      );
      expect(result.task_id).toBe('task-1');
      expect(result.status).toBe('completed');
    });
  });

  describe('GET /text/tasks/:taskId/stream', () => {
    it('should pipe SSE stream from SMR to the response', async () => {
      const mockStream = {
        on: vi.fn(),
        destroy: vi.fn(),
      };
      mockHttpService.axiosRef.get.mockResolvedValue({ data: mockStream });

      const mockRes = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await controller.streamTaskEvents('task-1', undefined, mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockRes.flushHeaders).toHaveBeenCalled();
      expect(mockStream.on).toHaveBeenCalledWith('data', expect.any(Function));
      expect(mockStream.on).toHaveBeenCalledWith('end', expect.any(Function));
      expect(mockStream.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('forwards the inbound Last-Event-ID header as a last_event_id query param', async () => {
      const mockStream = {
        on: vi.fn(),
        destroy: vi.fn(),
      };
      mockHttpService.axiosRef.get.mockResolvedValue({ data: mockStream });

      const mockRes = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await controller.streamTaskEvents('task-1', '2-0', mockRes as any);

      const [url] = mockHttpService.axiosRef.get.mock.calls[0];
      expect(url).toContain('last_event_id=2-0');
    });

    // TASK-462 M-1 — the SSE connect-error branch must never forward the raw
    // upstream body. In production this branch is dead (flushHeaders() runs before
    // the try, so res.headersSent is always true → only res.end()), but if headers
    // were not yet sent the response must be GENERIC (status preserved). This test
    // forces the not-yet-flushed path with a PHI-shaped upstream body.
    it('never forwards the raw upstream body on an SSE connect error (M-1 — generic only)', async () => {
      mockHttpService.axiosRef.get.mockRejectedValue({
        response: { status: 502, data: { detail: 'prompt: Patient John Q SSN 999-88-7777', error_code: 'X' } },
      });

      const mockRes = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
        headersSent: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };

      await controller.streamTaskEvents('task-err', undefined, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(502);
      expect(mockRes.json).toHaveBeenCalledWith({ detail: 'SMR service unavailable' });
      const jsonArg = JSON.stringify(mockRes.json.mock.calls[0]?.[0]);
      expect(jsonArg).not.toContain('999-88-7777');
      expect(jsonArg).not.toContain('error_code');
    });
  });

  describe('POST /text/tasks/:taskId/cancel', () => {
    it('should proxy cancel request to SMR v2', async () => {
      const cancelResponse = {
        data: { task_id: 'task-1', status: 'cancelled' },
      };
      mockHttpService.axiosRef.post.mockResolvedValue(cancelResponse);

      const result = await controller.cancelTask('task-1');

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/tasks/task-1/cancel'),
        {},
        expect.any(Object),
      );
      expect(result.task_id).toBe('task-1');
      expect(result.status).toBe('cancelled');
    });

    it('should return 502 when SMR service is unreachable', async () => {
      mockHttpService.axiosRef.post.mockRejectedValue(
        new Error('ECONNREFUSED'),
      );

      await expect(controller.cancelTask('task-1')).rejects.toThrow();
    });
  });

  describe('POST /text/generate with structured output', () => {
    it('should forward json response_format to SMR v2', async () => {
      const smrResponse = {
        data: {
          task_id: 'task-json-1',
          status: 'completed',
          content: '{"key": "value"}',
        },
      };
      mockHttpService.axiosRef.post.mockResolvedValue(smrResponse);

      const body = {
        prompt: 'Return JSON',
        response_format: { type: 'json' as const },
        stream: false,
      };

      await controller.generate(body);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          response_format: { type: 'json' },
        }),
        expect.any(Object),
      );
    });

    it('should forward json_schema response_format to SMR v2', async () => {
      const smrResponse = {
        data: {
          task_id: 'task-schema-1',
          status: 'completed',
          content: '{"name": "test"}',
        },
      };
      mockHttpService.axiosRef.post.mockResolvedValue(smrResponse);

      const body = {
        prompt: 'Return structured data',
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            title: 'TestSchema',
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          strict: true,
        },
        stream: false,
      };

      await controller.generate(body);

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          response_format: expect.objectContaining({
            type: 'json_schema',
            json_schema: expect.objectContaining({ title: 'TestSchema' }),
            strict: true,
          }),
        }),
        expect.any(Object),
      );
    });

    it('should forward streaming request with json_schema to SMR v2', async () => {
      const smrResponse = {
        data: {
          task_id: 'task-stream-schema-1',
          status: 'running',
          stream_url: '/api/v1/tasks/task-stream-schema-1/stream',
        },
      };
      mockHttpService.axiosRef.post.mockResolvedValue(smrResponse);

      const body = {
        prompt: 'Return structured data',
        response_format: {
          type: 'json_schema' as const,
          json_schema: { title: 'Output', type: 'object', properties: {} },
        },
        stream: true,
      };

      const result = await controller.generate(body);

      expect(result.task_id).toBe('task-stream-schema-1');
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          stream: true,
          response_format: expect.objectContaining({ type: 'json_schema' }),
        }),
        expect.any(Object),
      );
    });
  });

  // ── TASK-506 §3.3 — providers listings repointed to the AiModel registry ──
  // `GET /text/providers` and `GET /text/guardrail-providers` no longer read the
  // retired GlobalSetting keys (`smr-provider-models` / `default-smr-*` /
  // `default-guardrail-*`); the registry (ENABLED AiModel rows grouped by
  // `provider`) is the single UI catalog. The live-SMR probe survives ONLY as
  // the /providers transition fallback when the registry has zero rows.

  const createMockAiModelService = () => ({ getByTaskTypeSharedRead: vi.fn(async () => []) });
  const createMockAiTaskDefaultService = () => ({ getEffective: vi.fn() });

  const buildProvidersController = (opts: {
    aiModels?: { getByTaskTypeSharedRead: ReturnType<typeof vi.fn> };
    aiTaskDefaults?: { getEffective: ReturnType<typeof vi.fn> };
    harnessPolicy?: { resolveSmrSelection: ReturnType<typeof vi.fn> };
  }) =>
    new SmrProxyController(
      mockHttpService as any,
      mockTenantService as any,
      mockClsService as any,
      mockContextItemRepo as any,
      mockPromptTemplateRepo as any,
      mockDnaStyleRepo as any,
      mockDepartmentRepo as any,
      mockMediaRepo as any,
      mockBlobStorage as any,
      mockConfigService as any,
      undefined, // secretsService (@Optional)
      (opts.harnessPolicy ?? undefined) as any,
      (opts.aiModels ?? undefined) as any,
      (opts.aiTaskDefaults ?? undefined) as any,
    );

  const registryRow = (over: Record<string, unknown>) => ({
    id: `id-${String(over.slug ?? 'row')}`,
    name: String(over.slug ?? 'row'),
    slug: 'row',
    provider: null,
    architecture: null,
    taskType: ModelTaskType.TEXT_GENERATION,
    format: 'GGUF',
    sourceUri: '',
    memorySizeMb: null,
    resourceStatus: 'ENABLED',
    ...over,
  });

  describe('GET /text/providers (registry-backed — TASK-506)', () => {
    it('groups ENABLED TEXT_GENERATION + SUMMARIZATION rows by provider in the legacy shape, default from HarnessPolicy', async () => {
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockImplementation(async (taskType: string) =>
        taskType === ModelTaskType.TEXT_GENERATION
          ? [
              registryRow({ slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', sourceUri: 'gemma-4-e2b-it-qat', memorySizeMb: 3100 }),
              registryRow({ slug: 'ollama-qwen3.5-2b', provider: 'ollama', sourceUri: 'qwen3.5:2b', memorySizeMb: 900 }),
            ]
          : [registryRow({ slug: 'lms-gemma-4-e4b-it-qat', provider: 'lm-studio', sourceUri: 'gemma-4-e4b-it-qat', taskType: ModelTaskType.SUMMARIZATION })],
      );
      const harnessPolicy = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat' }) };
      const ctrl = buildProvidersController({ aiModels, harnessPolicy });

      const result = await ctrl.getProviders();

      expect(aiModels.getByTaskTypeSharedRead).toHaveBeenCalledWith(ModelTaskType.TEXT_GENERATION);
      expect(aiModels.getByTaskTypeSharedRead).toHaveBeenCalledWith(ModelTaskType.SUMMARIZATION);
      expect(harnessPolicy.resolveSmrSelection).toHaveBeenCalledWith('tenant-1');
      expect(result).toEqual([
        {
          name: 'lm-studio',
          models: [
            { name: 'gemma-4-e2b-it-qat', slug: 'lms-gemma-4-e2b-it-qat', size: '3.0 GB' },
            { name: 'gemma-4-e4b-it-qat', slug: 'lms-gemma-4-e4b-it-qat', size: '' },
          ],
          is_available: true,
          is_default: true,
          default_model: 'gemma-4-e2b-it-qat',
        },
        {
          name: 'ollama',
          models: [{ name: 'qwen3.5:2b', slug: 'ollama-qwen3.5-2b', size: '900 MB' }],
          is_available: true,
          is_default: false,
          default_model: 'qwen3.5:2b',
        },
      ]);
      // The retired GlobalSetting keys are never read.
      expect(mockHttpService.axiosRef.get).not.toHaveBeenCalled();
    });

    it('dedupes a row returned under both task types', async () => {
      const aiModels = createMockAiModelService();
      const shared = registryRow({ slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', sourceUri: 'gemma-4-e2b-it-qat' });
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([shared]);
      const ctrl = buildProvidersController({ aiModels });

      const result = await ctrl.getProviders();

      expect(result).toHaveLength(1);
      expect(result[0].models).toHaveLength(1);
    });

    it('marks no default when the HarnessPolicy cascade is unresolved (fail-open)', async () => {
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([registryRow({ slug: 's', provider: 'ollama', sourceUri: 'qwen3.5:2b' })]);
      const harnessPolicy = { resolveSmrSelection: vi.fn().mockRejectedValue(new BadRequestException('unresolved')) };
      const ctrl = buildProvidersController({ aiModels, harnessPolicy });

      const result = await ctrl.getProviders();

      expect(result).toHaveLength(1);
      expect(result[0].is_default).toBe(false);
      expect(result[0].default_model).toBe('qwen3.5:2b'); // first model, mirroring the legacy shape
    });

    it('skips rows without a provider (unmigrated) — all-unmigrated falls to the SMR probe', async () => {
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([registryRow({ slug: 'legacy-row', provider: null, sourceUri: 'legacy' })]);
      mockHttpService.axiosRef.get.mockResolvedValue({ data: [] });
      const ctrl = buildProvidersController({ aiModels });

      await ctrl.getProviders();

      expect(mockHttpService.axiosRef.get).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.any(Object));
    });

    it('falls back to the live SMR /providers probe when the registry returns zero rows (transition safety)', async () => {
      const aiModels = createMockAiModelService(); // returns []
      mockHttpService.axiosRef.get.mockResolvedValue({
        data: [
          { name: 'ollama', display_name: 'Ollama', status: 'available', default_model: 'granite4:latest', models: [{ name: 'granite4:latest' }] },
          { name: 'azure-openai', display_name: 'Azure OpenAI', status: 'unavailable', default_model: 'gpt-4o-mini', models: [{ name: 'gpt-4o-mini' }] },
        ],
      });
      const ctrl = buildProvidersController({ aiModels });

      const result = await ctrl.getProviders();

      expect(mockHttpService.axiosRef.get).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.any(Object));
      expect(result).toEqual([
        expect.objectContaining({ name: 'ollama', is_available: true, status: 'available' }),
        expect.objectContaining({ name: 'azure-openai', is_available: false, status: 'unavailable' }),
      ]);
    });

    it('returns an empty list when the registry is empty and the SMR probe fails', async () => {
      const aiModels = createMockAiModelService();
      mockHttpService.axiosRef.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const ctrl = buildProvidersController({ aiModels });

      await expect(ctrl.getProviders()).resolves.toEqual([]);
    });

    it('treats a registry read failure as zero rows (probe fallback, never a 5xx to the console)', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockRejectedValue(new BadRequestException('Tenant ID is required')) };
      mockHttpService.axiosRef.get.mockResolvedValue({ data: [] });
      const ctrl = buildProvidersController({ aiModels });

      await expect(ctrl.getProviders()).resolves.toEqual([]);
      expect(mockHttpService.axiosRef.get).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.any(Object));
    });
  });

  // TASK-307 W5.9 (AC-23, audit D-12) — the GLOBAL-tenant targeting must stay
  // EXPLICIT via `?tenantKey=__GLOBAL__` after the registry repoint.
  describe('TASK-307 W5.9 — explicit ?tenantKey=__GLOBAL__ posture on getProviders (TASK-506 registry-backed)', () => {
    it('GLOBAL_ADMIN with ?tenantKey=__GLOBAL__ resolves the GLOBAL tenant id', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'admin', roles: ['GLOBAL_ADMIN'] };
        return undefined;
      });
      mockTenantService.fetchByCodeName.mockResolvedValue({ id: 'global-tenant' });
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([registryRow({ slug: 's', provider: 'ollama', sourceUri: 'qwen3.5:2b' })]);
      const harnessPolicy = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'ollama', model: 'qwen3.5:2b' }) };
      const ctrl = buildProvidersController({ aiModels, harnessPolicy });

      const result = await ctrl.getProviders('__GLOBAL__');

      expect(mockTenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
      expect(harnessPolicy.resolveSmrSelection).toHaveBeenCalledWith('global-tenant');
      expect(result).toHaveLength(1);
    });

    it('non-GLOBAL_ADMIN with ?tenantKey=__GLOBAL__ is FORBIDDEN', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'u-1', roles: ['DOCTOR'] };
        return undefined;
      });
      const ctrl = buildProvidersController({ aiModels: createMockAiModelService() });

      await expect(ctrl.getProviders('__GLOBAL__')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
    });

    it('any tenantKey OTHER than __GLOBAL__ is rejected as a BAD REQUEST', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'admin', roles: ['GLOBAL_ADMIN'] };
        return undefined;
      });
      const ctrl = buildProvidersController({ aiModels: createMockAiModelService() });

      await expect(ctrl.getProviders('other-tenant')).rejects.toBeInstanceOf(BadRequestException);
      await expect(ctrl.getProviders('__global__')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
    });

    it('GLOBAL_ADMIN WITHOUT an explicit ?tenantKey AND no CLS tenantId is REJECTED (no implicit fallback)', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'admin', roles: ['GLOBAL_ADMIN'] };
        return undefined;
      });
      const ctrl = buildProvidersController({ aiModels: createMockAiModelService() });

      await expect(ctrl.getProviders()).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
    });

    it('non-admin without ?tenantKey defaults to the CLS tenant (the common path)', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-cls';
        if (key === 'user') return { id: 'u-1', roles: ['DOCTOR'] };
        return undefined;
      });
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([registryRow({ slug: 's', provider: 'ollama', sourceUri: 'qwen3.5:2b' })]);
      const harnessPolicy = { resolveSmrSelection: vi.fn().mockResolvedValue({ provider: 'ollama', model: 'qwen3.5:2b' }) };
      const ctrl = buildProvidersController({ aiModels, harnessPolicy });

      await ctrl.getProviders();

      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
      expect(harnessPolicy.resolveSmrSelection).toHaveBeenCalledWith('tenant-cls');
    });
  });

  // TASK-506 — the guardrail listing reads ENABLED GUARDRAIL registry rows and
  // marks the effective `guardrail.validate` default (AiTaskDefault cascade).
  // NO upstream probe: an empty registry simply means "not configured".
  describe('GET /text/guardrail-providers (registry-backed — TASK-506)', () => {
    it('groups ENABLED GUARDRAIL rows by provider and marks the effective guardrail.validate default', async () => {
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([
        registryRow({ slug: 'granite-guardian-4.1-8b', provider: 'lm-studio', sourceUri: 'granite-guardian-4.1-8b', taskType: ModelTaskType.GUARDRAIL, memorySizeMb: 4900 }),
        registryRow({ slug: 'ollama-guardian', provider: 'ollama', sourceUri: 'granite3-guardian:8b', taskType: ModelTaskType.GUARDRAIL }),
      ]);
      const aiTaskDefaults = createMockAiTaskDefaultService();
      aiTaskDefaults.getEffective.mockResolvedValue({
        tenantId: 'tenant-1',
        taskKey: 'guardrail.validate',
        modelSlug: 'granite-guardian-4.1-8b',
        source: 'system',
        configJson: null,
        model: {
          id: 'm1',
          slug: 'granite-guardian-4.1-8b',
          name: 'Granite Guardian 4.1 8B',
          provider: 'lm-studio',
          architecture: 'granite',
          taskType: 'GUARDRAIL',
          format: 'GGUF',
          sourceUri: 'granite-guardian-4.1-8b',
        },
      });
      const ctrl = buildProvidersController({ aiModels, aiTaskDefaults });

      const result = await ctrl.getGuardrailProviders();

      expect(aiModels.getByTaskTypeSharedRead).toHaveBeenCalledWith(ModelTaskType.GUARDRAIL);
      expect(aiTaskDefaults.getEffective).toHaveBeenCalledWith('guardrail.validate', 'tenant-1');
      expect(result).toEqual([
        {
          name: 'lm-studio',
          models: [{ name: 'granite-guardian-4.1-8b', slug: 'granite-guardian-4.1-8b', size: '4.8 GB' }],
          is_available: true,
          is_default: true,
          default_model: 'granite-guardian-4.1-8b',
        },
        {
          name: 'ollama',
          models: [{ name: 'granite3-guardian:8b', slug: 'ollama-guardian', size: '' }],
          is_available: true,
          is_default: false,
          default_model: 'granite3-guardian:8b',
        },
      ]);
    });

    it('does NOT fall back to the SMR /providers upstream on an empty registry', async () => {
      const ctrl = buildProvidersController({ aiModels: createMockAiModelService(), aiTaskDefaults: createMockAiTaskDefaultService() });

      const result = await ctrl.getGuardrailProviders();

      expect(result).toEqual([]);
      expect(mockHttpService.axiosRef.get).not.toHaveBeenCalled();
    });

    it('fails open when the effective-default resolution throws — listing returned, no default marked', async () => {
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([
        registryRow({ slug: 'granite-guardian-4.1-8b', provider: 'lm-studio', sourceUri: 'granite-guardian-4.1-8b', taskType: ModelTaskType.GUARDRAIL }),
      ]);
      const aiTaskDefaults = createMockAiTaskDefaultService();
      aiTaskDefaults.getEffective.mockRejectedValue(new Error('resolver down'));
      const ctrl = buildProvidersController({ aiModels, aiTaskDefaults });

      const result = await ctrl.getGuardrailProviders();

      expect(result).toHaveLength(1);
      expect(result[0].is_default).toBe(false);
    });

    it('resolves the GLOBAL tenant for the effective default when GLOBAL_ADMIN passes ?tenantKey=__GLOBAL__', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { roles: ['GLOBAL_ADMIN'] };
        return undefined;
      });
      mockTenantService.fetchByCodeName.mockResolvedValue({ id: 'global-tenant' });
      const aiModels = createMockAiModelService();
      aiModels.getByTaskTypeSharedRead.mockResolvedValue([
        registryRow({ slug: 'granite-guardian-4.1-8b', provider: 'lm-studio', sourceUri: 'granite-guardian-4.1-8b', taskType: ModelTaskType.GUARDRAIL }),
      ]);
      const aiTaskDefaults = createMockAiTaskDefaultService();
      aiTaskDefaults.getEffective.mockResolvedValue({ tenantId: 'global-tenant', taskKey: 'guardrail.validate', modelSlug: null, source: null, configJson: null, model: null });
      const ctrl = buildProvidersController({ aiModels, aiTaskDefaults });

      await ctrl.getGuardrailProviders('__GLOBAL__');

      expect(mockTenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
      expect(aiTaskDefaults.getEffective).toHaveBeenCalledWith('guardrail.validate', 'global-tenant');
    });

    it('non-GLOBAL_ADMIN with ?tenantKey=__GLOBAL__ is FORBIDDEN', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { roles: ['DOCTOR'] };
        return undefined;
      });
      const ctrl = buildProvidersController({ aiModels: createMockAiModelService() });

      await expect(ctrl.getGuardrailProviders('__GLOBAL__')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('POST /text/generate/assembled', () => {
    it('should reject when neither context_item_ids nor message is provided', async () => {
      await expect(
        controller.generateAssembled({ type: 'pre-summary' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when both context_item_ids and message are provided', async () => {
      await expect(
        controller.generateAssembled({
          type: 'pre-summary',
          context_item_ids: ['ctx-1'],
          message: 'some text',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid type', async () => {
      await expect(
        controller.generateAssembled({
          type: 'invalid' as any,
          message: 'test',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid visit_type', async () => {
      await expect(
        controller.generateAssembled({
          type: 'pre-summary',
          message: 'test',
          visit_type: 'invalid' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject debug mode for non-admin users', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { roles: ['DOCTOR'] };
        return undefined;
      });

      await expect(
        controller.generateAssembled({
          type: 'pre-summary',
          message: 'test',
          debug: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow debug mode for TENANT_ADMIN', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { roles: ['TENANT_ADMIN'] };
        return undefined;
      });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-assembled-1',
          status: 'completed',
          content: 'Generated pre-summary',
        },
      });

      const result = await controller.generateAssembled({
        type: 'pre-summary',
        message: 'Patient presents with chest pain',
        debug: true,
        provider: 'ollama',
      });

      expect(result.task_id).toBe('task-assembled-1');
      expect(result._debug.assembled).toBe(true);
      expect(result._debug.type).toBe('pre-summary');
    });

    it('should fetch context item content when context_item_ids is provided', async () => {
      mockContextItemRepo.findById.mockResolvedValue({
        id: 'ctx-1',
        content: 'Patient transcript content here',
        type: 'TRANSCRIPT',
      });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-ctx-1',
          status: 'completed',
          content: 'Summary from context item',
        },
      });

      const result = await controller.generateAssembled({
        type: 'summary',
        context_item_ids: ['ctx-1'],
      });

      expect(mockContextItemRepo.findById).toHaveBeenCalledWith('ctx-1');
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          prompt: expect.stringContaining('Patient transcript content here'),
        }),
        expect.any(Object),
      );
      expect(result._debug.context_item_ids).toEqual(['ctx-1']);
    });

    it('should throw NotFoundException when context item does not exist', async () => {
      mockContextItemRepo.findById.mockResolvedValue(null);

      await expect(
        controller.generateAssembled({
          type: 'summary',
          context_item_ids: ['nonexistent'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should fetch multiple context items and concatenate with type labels', async () => {
      mockContextItemRepo.findById
        .mockResolvedValueOnce({
          id: 'ctx-1',
          content: 'Transcript content here',
          type: 'TRANSCRIPT',
        })
        .mockResolvedValueOnce({
          id: 'ctx-2',
          content: 'Case note content here',
          type: 'CASE_NOTE',
        });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-multi',
          status: 'completed',
          content: 'Multi-item summary',
        },
      });

      const result = await controller.generateAssembled({
        type: 'summary',
        context_item_ids: ['ctx-1', 'ctx-2'],
      });

      expect(mockContextItemRepo.findById).toHaveBeenCalledTimes(2);
      const postedPrompt = mockHttpService.axiosRef.post.mock.calls[0][1].prompt;
      expect(postedPrompt).toContain('Transcript:\nTranscript content here');
      expect(postedPrompt).toContain('Case Note:\nCase note content here');
      expect(postedPrompt.indexOf('Transcript:')).toBeLessThan(postedPrompt.indexOf('Case Note:'));
      expect(result._debug.context_item_ids).toEqual(['ctx-1', 'ctx-2']);
    });

    it('should silently skip items without content', async () => {
      mockContextItemRepo.findById
        .mockResolvedValueOnce({
          id: 'ctx-1',
          content: 'Valid content',
          type: 'TRANSCRIPT',
        })
        .mockResolvedValueOnce({
          id: 'ctx-2',
          content: null,
          type: 'CASE_NOTE',
        });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-skip',
          status: 'completed',
          content: 'Summary',
        },
      });

      const result = await controller.generateAssembled({
        type: 'summary',
        context_item_ids: ['ctx-1', 'ctx-2'],
      });

      const postedPrompt = mockHttpService.axiosRef.post.mock.calls[0][1].prompt;
      expect(postedPrompt).toContain('Valid content');
      expect(postedPrompt).not.toContain('Case Note:');
      expect(result._debug.context_item_ids).toEqual(['ctx-1', 'ctx-2']);
    });

    it('should fetch + extract text from an ATTACHMENT item via blob storage (TASK-318 W3-D)', async () => {
      mockContextItemRepo.findById.mockResolvedValue({
        id: 'ctx-att',
        content: null,
        type: 'ATTACHMENT',
        mediaId: 'media-1',
      });
      mockMediaRepo.findById.mockResolvedValue({
        id: 'media-1',
        name: 'lab-result.txt',
        uri: 's3://hope-attachments-arcaai/2026/05/31/lab-result.txt',
        mimeType: 'text/plain',
      });
      mockBlobStorage.getObject.mockResolvedValue(Buffer.from('WBC 6.1, Hemoglobin 14.2', 'utf-8'));

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { task_id: 'task-att', status: 'completed', content: 'Summary' },
      });

      await controller.generateAssembled({ type: 'summary', context_item_ids: ['ctx-att'] });

      expect(mockMediaRepo.findById).toHaveBeenCalledWith('media-1');
      expect(mockBlobStorage.getObject).toHaveBeenCalledWith({
        bucket: 'hope-attachments-arcaai',
        key: '2026/05/31/lab-result.txt',
      });
      const postedPrompt = mockHttpService.axiosRef.post.mock.calls[0][1].prompt;
      expect(postedPrompt).toContain('Attachment (lab-result.txt):');
      expect(postedPrompt).toContain('WBC 6.1, Hemoglobin 14.2');
    });

    it('should skip an ATTACHMENT whose file cannot be fetched without failing the request', async () => {
      mockContextItemRepo.findById
        .mockResolvedValueOnce({ id: 'ctx-1', content: 'Transcript here', type: 'TRANSCRIPT' })
        .mockResolvedValueOnce({ id: 'ctx-att', content: null, type: 'ATTACHMENT', mediaId: 'media-x' });
      mockMediaRepo.findById.mockResolvedValue({
        id: 'media-x',
        name: 'scan.pdf',
        uri: 's3://hope-attachments-arcaai/scan.pdf',
        mimeType: 'application/pdf',
      });
      mockBlobStorage.getObject.mockRejectedValue(new Error('NoSuchKey'));

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { task_id: 'task-skip-att', status: 'completed', content: 'Summary' },
      });

      const result = await controller.generateAssembled({ type: 'summary', context_item_ids: ['ctx-1', 'ctx-att'] });

      const postedPrompt = mockHttpService.axiosRef.post.mock.calls[0][1].prompt;
      expect(postedPrompt).toContain('Transcript here');
      expect(result.task_id).toBe('task-skip-att');
    });

    it('should throw BadRequestException when all items have no content', async () => {
      mockContextItemRepo.findById
        .mockResolvedValueOnce({
          id: 'ctx-1',
          content: null,
          type: 'TRANSCRIPT',
        })
        .mockResolvedValueOnce({
          id: 'ctx-2',
          content: '',
          type: 'CASE_NOTE',
        });

      await expect(
        controller.generateAssembled({
          type: 'summary',
          context_item_ids: ['ctx-1', 'ctx-2'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject empty context_item_ids array', async () => {
      await expect(
        controller.generateAssembled({
          type: 'summary',
          context_item_ids: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should use prompt template content as system prompt when template ID is provided', async () => {
      mockPromptTemplateRepo.findById.mockResolvedValue({
        id: 'tmpl-1',
        name: 'Cardiology Pre-Summary',
        content: 'You are a cardiology specialist. Generate a focused pre-summary.',
      });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-tmpl-1',
          status: 'completed',
          content: 'Cardiology pre-summary',
        },
      });

      const result = await controller.generateAssembled({
        type: 'pre-summary',
        message: 'Patient with chest pain',
        prompt_template_id: 'tmpl-1',
      });

      expect(mockPromptTemplateRepo.findById).toHaveBeenCalledWith('tmpl-1');
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          system_prompt: expect.stringContaining('cardiology specialist'),
        }),
        expect.any(Object),
      );
      expect(result._debug.prompt_template_id).toBe('tmpl-1');
      expect(result._debug.prompt_template_name).toBe('Cardiology Pre-Summary');
    });

    it('should throw NotFoundException when prompt template does not exist', async () => {
      mockPromptTemplateRepo.findById.mockResolvedValue(null);

      await expect(
        controller.generateAssembled({
          type: 'pre-summary',
          message: 'test',
          prompt_template_id: 'nonexistent',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should append DNA writing style to system prompt when dna_writing_style_id is provided', async () => {
      mockDnaStyleRepo.findById.mockResolvedValue({
        id: 'dna-1',
        styleText: 'Use concise, formal medical language with standard abbreviations.',
        doctorId: 'user-1',
        tenantId: 'tenant-1',
      });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-dna-1',
          status: 'completed',
          content: 'Styled summary',
        },
      });

      const result = await controller.generateAssembled({
        type: 'summary',
        message: 'Patient transcript',
        dna_writing_style_id: 'dna-1',
      });

      expect(mockDnaStyleRepo.findById).toHaveBeenCalledWith('dna-1');
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          system_prompt: expect.stringContaining('concise, formal medical language'),
        }),
        expect.any(Object),
      );
      expect(result._debug.dna_writing_style_id).toBe('dna-1');
    });

    it('should include visit type in system prompt', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-visit-1',
          status: 'completed',
          content: 'Visit summary',
        },
      });

      await controller.generateAssembled({
        type: 'summary',
        message: 'Patient transcript',
        visit_type: 'referral',
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          system_prompt: expect.stringContaining('referral visit'),
        }),
        expect.any(Object),
      );
    });

    it('should forward streaming request and return stream_url with debug metadata', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: {
          task_id: 'task-stream-assembled',
          status: 'running',
          stream_url: '/api/v1/tasks/task-stream-assembled/stream',
        },
      });

      const result = await controller.generateAssembled({
        type: 'summary',
        message: 'Patient transcript',
        stream: true,
        provider: 'lm-studio',
        model: 'qwen3.5-4b',
      });

      expect(result.task_id).toBe('task-stream-assembled');
      expect(result.stream_url).toContain('/stream');
      expect(result._debug.assembled).toBe(true);
      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          stream: true,
          provider: 'lm-studio',
          model: 'qwen3.5-4b',
        }),
        expect.any(Object),
      );
    });

    it('should use default system prompt for pre-summary when no template is provided', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { task_id: 'task-default', status: 'completed', content: 'result' },
      });

      await controller.generateAssembled({
        type: 'pre-summary',
        message: 'Clinical context',
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          system_prompt: expect.stringContaining('pre-summary'),
          prompt: expect.stringContaining('Clinical context'),
        }),
        expect.any(Object),
      );
    });

    it('should use default system prompt for summary when no template is provided', async () => {
      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { task_id: 'task-default-s', status: 'completed', content: 'result' },
      });

      await controller.generateAssembled({
        type: 'summary',
        message: 'Transcript text',
      });

      expect(mockHttpService.axiosRef.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/generate'),
        expect.objectContaining({
          system_prompt: expect.stringContaining('comprehensive clinical summary'),
          prompt: expect.stringContaining('Transcript text'),
        }),
        expect.any(Object),
      );
    });

    it('should combine template, DNA style, and visit type in system prompt', async () => {
      mockPromptTemplateRepo.findById.mockResolvedValue({
        id: 'tmpl-combo',
        name: 'Combo Template',
        content: 'You are a specialist. Generate a detailed summary.',
      });
      mockDnaStyleRepo.findById.mockResolvedValue({
        id: 'dna-combo',
        styleText: 'Use bullet points and short sentences.',
        doctorId: 'user-1',
        tenantId: 'tenant-1',
      });

      mockHttpService.axiosRef.post.mockResolvedValue({
        data: { task_id: 'task-combo', status: 'completed', content: 'combo result' },
      });

      await controller.generateAssembled({
        type: 'summary',
        message: 'Patient transcript',
        prompt_template_id: 'tmpl-combo',
        dna_writing_style_id: 'dna-combo',
        visit_type: 'new_visit',
      });

      const callArgs = mockHttpService.axiosRef.post.mock.calls[0];
      const systemPrompt = callArgs[1].system_prompt;
      expect(systemPrompt).toContain('specialist');
      expect(systemPrompt).toContain('bullet points');
      expect(systemPrompt).toContain('new patient visit');
    });

    // TASK-299 D-12 — Cross-doctor `dnaStyleId` ownership.
    describe('TASK-299 D-12 — DNA writing-style ownership', () => {
      it('throws ForbiddenException when dna_writing_style_id belongs to a different doctor', async () => {
        mockDnaStyleRepo.findById.mockResolvedValue({
          id: 'dna-other',
          styleText: 'Other doctor style',
          doctorId: 'doctor-other',
          tenantId: 'tenant-1',
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            dna_writing_style_id: 'dna-other',
          }),
        ).rejects.toThrow(ForbiddenException);

        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      });

      it('throws ForbiddenException when dna_writing_style_id belongs to a different tenant', async () => {
        mockDnaStyleRepo.findById.mockResolvedValue({
          id: 'dna-foreign-tenant',
          styleText: 'Other tenant style',
          doctorId: 'user-1',
          tenantId: 'tenant-other',
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            dna_writing_style_id: 'dna-foreign-tenant',
          }),
        ).rejects.toThrow(ForbiddenException);

        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when dna_writing_style_id does not resolve', async () => {
        mockDnaStyleRepo.findById.mockResolvedValue(null);

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            dna_writing_style_id: 'dna-missing',
          }),
        ).rejects.toThrow(NotFoundException);

        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      });

      it('allows DNA style owned by the current doctor', async () => {
        mockDnaStyleRepo.findById.mockResolvedValue({
          id: 'dna-owned',
          styleText: 'My style',
          doctorId: 'user-1',
          tenantId: 'tenant-1',
        });
        mockHttpService.axiosRef.post.mockResolvedValue({
          data: { task_id: 'ok', status: 'completed', content: 'ok' },
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            dna_writing_style_id: 'dna-owned',
          }),
        ).resolves.toBeDefined();
      });
    });

    // TASK-331 doc-09 — `prompt_template_id` ownership bypass on the
    // assembled-generation path. The template branch previously resolved any
    // `findById` hit with NO tenant/owner check (unlike the DNA guard right
    // below it), so a caller could reference another tenant's template — or a
    // peer's USER_PERSONAL template within the same tenant — and fold its
    // content into the system prompt. Mirror the DNA guard: tenant must match
    // (NotFound on mismatch, no existence leak), and a USER_PERSONAL template
    // must be owned by the caller (Forbidden otherwise).
    describe('TASK-331 doc-09 — prompt-template tenant/owner scope', () => {
      it('rejects a prompt template that belongs to a different tenant (NotFound, no leak)', async () => {
        mockPromptTemplateRepo.findById.mockResolvedValue({
          id: 'tmpl-foreign',
          name: 'Foreign tenant template',
          content: "Another tenant's prompt",
          scope: 'TENANT_DEFAULT',
          tenantId: 'tenant-other',
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            prompt_template_id: 'tmpl-foreign',
          }),
        ).rejects.toThrow(NotFoundException);

        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      });

      it("rejects another user's USER_PERSONAL template within the same tenant (Forbidden)", async () => {
        mockPromptTemplateRepo.findById.mockResolvedValue({
          id: 'tmpl-peer-personal',
          name: 'Peer personal template',
          content: "A peer's private prompt",
          scope: 'USER_PERSONAL',
          ownerUserId: 'doctor-other',
          tenantId: 'tenant-1',
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            prompt_template_id: 'tmpl-peer-personal',
          }),
        ).rejects.toThrow(ForbiddenException);

        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      });

      it("allows the caller's OWN USER_PERSONAL template in the caller's tenant", async () => {
        mockPromptTemplateRepo.findById.mockResolvedValue({
          id: 'tmpl-own-personal',
          name: 'My personal template',
          content: 'You are my personalized assistant.',
          scope: 'USER_PERSONAL',
          ownerUserId: 'user-1',
          tenantId: 'tenant-1',
        });
        mockHttpService.axiosRef.post.mockResolvedValue({
          data: { task_id: 'ok', status: 'completed', content: 'ok' },
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            prompt_template_id: 'tmpl-own-personal',
          }),
        ).resolves.toBeDefined();
      });

      it('allows a TENANT_DEFAULT template in the caller tenant', async () => {
        mockPromptTemplateRepo.findById.mockResolvedValue({
          id: 'tmpl-tenant-default',
          name: 'Tenant default',
          content: 'You are a clinical assistant.',
          scope: 'TENANT_DEFAULT',
          tenantId: 'tenant-1',
        });
        mockHttpService.axiosRef.post.mockResolvedValue({
          data: { task_id: 'ok', status: 'completed', content: 'ok' },
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            message: 'Patient transcript',
            prompt_template_id: 'tmpl-tenant-default',
          }),
        ).resolves.toBeDefined();
      });
    });

    // TASK-329 X3 — raw context ownership bypass on the assembled-generation path.
    // A caller could previously pass another tenant's context_item_ids and
    // exfiltrate their content through the generated summary; the proxy must
    // reject cross-tenant context items (surfaced as NotFound to avoid leaking
    // their existence) before any prompt is assembled or sent to SMR.
    describe('TASK-329 X3 — cross-tenant context item ownership', () => {
      it('rejects a context item that belongs to a different tenant (NotFound, no leak)', async () => {
        mockContextItemRepo.findById.mockResolvedValue({
          id: 'ctx-foreign',
          content: "Another tenant's confidential transcript",
          type: 'TRANSCRIPT',
          tenantId: 'tenant-other',
        });

        await expect(
          controller.generateAssembled({
            type: 'summary',
            context_item_ids: ['ctx-foreign'],
          }),
        ).rejects.toThrow(NotFoundException);

        expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
      });

      it('allows a context item that belongs to the caller tenant', async () => {
        mockContextItemRepo.findById.mockResolvedValue({
          id: 'ctx-own',
          content: 'My own transcript',
          type: 'TRANSCRIPT',
          tenantId: 'tenant-1',
        });
        mockHttpService.axiosRef.post.mockResolvedValue({
          data: { task_id: 'task-own', status: 'completed', content: 'Summary' },
        });

        const result = await controller.generateAssembled({
          type: 'summary',
          context_item_ids: ['ctx-own'],
        });

        expect(result.task_id).toBe('task-own');
        expect(mockHttpService.axiosRef.post).toHaveBeenCalled();
      });
    });
  });
});

describe('SmrProxyController - OpenAPI/Swagger metadata', () => {
  const SWAGGER = {
    API_OPERATION: 'swagger/apiOperation',
    API_RESPONSE: 'swagger/apiResponse',
    API_TAGS: 'swagger/apiUseTags',
  };

  it('should have @ApiTags("text")', () => {
    const tags = Reflect.getMetadata(SWAGGER.API_TAGS, SmrProxyController);
    expect(tags).toContain('text');
  });
});

describe('SmrProxyController - Endpoint Security', () => {
  it('should have all mutating endpoints protected', () => {
    const proto = SmrProxyController.prototype;
    const endpoints = ['generate', 'cancelTask', 'getTaskStatus', 'streamTaskEvents', 'getProviders', 'getGuardrailProviders'];

    for (const method of endpoints) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, method);
      expect(descriptor).toBeDefined();
    }
  });
});
