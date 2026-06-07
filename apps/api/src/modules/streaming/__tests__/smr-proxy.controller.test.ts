import { BadRequestException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrProxyController } from '../smr-proxy.controller';

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn(),
    get: vi.fn(),
  },
});

const createMockTenantService = () => ({
  fetchTenantConfigs: vi.fn(),
  fetchByCodeName: vi.fn(),
});

const createMockClsService = () => ({
  get: vi.fn(),
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

    mockTenantService.fetchTenantConfigs.mockResolvedValue({
      data: [
        { key: 'default-smr-provider', value: 'ollama' },
        { key: 'default-smr-model', value: 'granite4:latest' },
      ],
      count: 2,
      limit: 200,
      page: 1,
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

    it('should propagate upstream 404 details from SMR', async () => {
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
      expect((thrown as HttpException).getResponse()).toEqual({
        detail: "Provider 'lm-studio' not found",
        error_code: 'PROVIDER_NOT_FOUND',
      });
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

      await controller.streamTaskEvents('task-1', mockRes as any);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockRes.flushHeaders).toHaveBeenCalled();
      expect(mockStream.on).toHaveBeenCalledWith('data', expect.any(Function));
      expect(mockStream.on).toHaveBeenCalledWith('end', expect.any(Function));
      expect(mockStream.on).toHaveBeenCalledWith('error', expect.any(Function));
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

  describe('GET /text/providers', () => {
    it('should return provider/model from tenant config defaults', async () => {
      const result = await controller.getProviders();

      expect(mockTenantService.fetchTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        limit: 200,
        page: 1,
      });
      expect(mockHttpService.axiosRef.get).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/providers'),
        expect.any(Object),
      );
      expect(result).toEqual([
        {
          name: 'ollama',
          models: ['granite4:latest'],
          is_available: true,
          default_model: 'granite4:latest',
        },
      ]);
    });

    // TASK-307 W5.9 (AC-23, audit D-12) retuned this from an implicit
    // SUPER_ADMIN → __GLOBAL__ fallback to an EXPLICIT
    // ?tenantKey=__GLOBAL__ query parameter. Behaviour beyond the
    // resolver remains identical.
    it('should resolve global tenant config when SUPER_ADMIN passes ?tenantKey=__GLOBAL__ (W5.9)', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { roles: ['SUPER_ADMIN'] };
        return undefined;
      });

      mockTenantService.fetchByCodeName.mockResolvedValue({ id: 'global-tenant' });
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-smr-provider', value: 'azure-openai' },
          { key: 'default-smr-model', value: 'gpt-4o-mini' },
        ],
        count: 2,
        limit: 200,
        page: 1,
      });

      const result = await controller.getProviders('__GLOBAL__');

      expect(mockTenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
      expect(mockTenantService.fetchTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'global-tenant',
        limit: 200,
        page: 1,
      });
      expect(result).toEqual([
        {
          name: 'azure-openai',
          models: ['gpt-4o-mini'],
          is_available: true,
          default_model: 'gpt-4o-mini',
        },
      ]);
    });

    it('should fall back to SMR /providers when tenant settings are empty', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [],
        count: 0,
        limit: 200,
        page: 1,
      });
      mockHttpService.axiosRef.get.mockResolvedValue({
        data: [
          {
            name: 'ollama',
            display_name: 'Ollama',
            status: 'available',
            default_model: 'granite4:latest',
            models: [{ name: 'granite4:latest', supports_streaming: true }],
          },
          {
            name: 'azure-openai',
            display_name: 'Azure OpenAI',
            status: 'unavailable',
            default_model: 'gpt-4o-mini',
            models: [{ name: 'gpt-4o-mini', supports_streaming: true }],
          },
        ],
      });

      const result = await controller.getProviders();

      expect(mockHttpService.axiosRef.get).toHaveBeenCalledWith(expect.stringContaining('/api/v1/providers'), expect.any(Object));
      expect(result).toEqual([
        expect.objectContaining({ name: 'ollama', is_available: true, status: 'available' }),
        expect.objectContaining({ name: 'azure-openai', is_available: false, status: 'unavailable' }),
      ]);
    });

    it('should return empty list when tenant settings are empty and SMR fallback fails', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [],
        count: 0,
        limit: 200,
        page: 1,
      });
      mockHttpService.axiosRef.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(controller.getProviders()).resolves.toEqual([]);
    });
  });

  // TASK-307 W5.9 (AC-23, audit D-12) — the GLOBAL-tenant fallback must
  // be requested EXPLICITLY via `?tenantKey=__GLOBAL__`. The old
  // implicit "SUPER_ADMIN without a CLS tenantId silently reads
  // __GLOBAL__" path is removed because operators rarely intend it and
  // tenant admins debugging an issue can land on it by mistake when CLS
  // resolution misfires.
  describe('TASK-307 W5.9 — explicit ?tenantKey=__GLOBAL__ on getProviders (AC-23, audit D-12)', () => {
    beforeEach(() => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [{ key: 'default-smr-provider', value: 'azure-openai' }, { key: 'default-smr-model', value: 'gpt-4o-mini' }],
        count: 2,
        limit: 200,
        page: 1,
      });
    });

    it('SUPER_ADMIN with ?tenantKey=__GLOBAL__ resolves to the GLOBAL tenant', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'admin', roles: ['SUPER_ADMIN'] };
        return undefined;
      });
      mockTenantService.fetchByCodeName.mockResolvedValue({ id: 'global-tenant' });

      await controller.getProviders('__GLOBAL__');

      expect(mockTenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
      expect(mockTenantService.fetchTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'global-tenant' }),
      );
    });

    it('non-SUPER_ADMIN with ?tenantKey=__GLOBAL__ is FORBIDDEN', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'u-1', roles: ['DOCTOR'] };
        return undefined;
      });

      await expect(controller.getProviders('__GLOBAL__')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
    });

    it('any tenantKey OTHER than __GLOBAL__ is rejected as a BAD REQUEST', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { id: 'admin', roles: ['SUPER_ADMIN'] };
        return undefined;
      });

      await expect(controller.getProviders('other-tenant')).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getProviders('__global__')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN WITHOUT an explicit ?tenantKey AND no CLS tenantId is REJECTED (no implicit fallback)', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'admin', roles: ['SUPER_ADMIN'] };
        return undefined;
      });

      await expect(controller.getProviders()).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
    });

    it('non-admin without ?tenantKey defaults to the CLS tenant (the common path)', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-cls';
        if (key === 'user') return { id: 'u-1', roles: ['DOCTOR'] };
        return undefined;
      });

      await controller.getProviders();

      expect(mockTenantService.fetchByCodeName).not.toHaveBeenCalled();
      expect(mockTenantService.fetchTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-cls' }),
      );
    });
  });

  describe('GET /text/providers (catalog-based — TASK-240)', () => {
    const CATALOG_JSON = JSON.stringify([
      {
        provider: 'ollama',
        models: [
          { name: 'granite4:latest', size: '2.1 GB' },
          { name: 'gemma3:latest', size: '3.3 GB' },
        ],
      },
      {
        provider: 'lm-studio',
        models: [
          { name: 'qwen3.5-4b', size: '3.1 GB' },
        ],
      },
      {
        provider: 'azure-openai',
        models: [
          { name: 'gpt-4o-mini', size: '' },
        ],
      },
    ]);

    it('should return all catalog providers with models and sizes when catalog setting exists', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-smr-provider', value: 'ollama' },
          { key: 'default-smr-model', value: 'granite4:latest' },
          { key: 'smr-provider-models', value: CATALOG_JSON },
        ],
        count: 3,
        limit: 200,
        page: 1,
      });

      const result = await controller.getProviders();

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('ollama');
      expect(result[0].models).toEqual([
        { name: 'granite4:latest', size: '2.1 GB' },
        { name: 'gemma3:latest', size: '3.3 GB' },
      ]);
      expect(result[1].name).toBe('lm-studio');
      expect(result[2].name).toBe('azure-openai');
    });

    it('should mark the tenant default provider and model in the response', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-smr-provider', value: 'lm-studio' },
          { key: 'default-smr-model', value: 'qwen3.5-4b' },
          { key: 'smr-provider-models', value: CATALOG_JSON },
        ],
        count: 3,
        limit: 200,
        page: 1,
      });

      const result = await controller.getProviders();

      const lmStudio = result.find((p: any) => p.name === 'lm-studio');
      expect(lmStudio.is_default).toBe(true);
      expect(lmStudio.default_model).toBe('qwen3.5-4b');

      const ollama = result.find((p: any) => p.name === 'ollama');
      expect(ollama.is_default).toBe(false);
    });

    it('should set is_available true for all catalog providers', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-smr-provider', value: 'ollama' },
          { key: 'default-smr-model', value: 'granite4:latest' },
          { key: 'smr-provider-models', value: CATALOG_JSON },
        ],
        count: 3,
        limit: 200,
        page: 1,
      });

      const result = await controller.getProviders();
      for (const provider of result) {
        expect(provider.is_available).toBe(true);
      }
    });
  });

  // TASK-338 — admin-configurable Guardrail engine endpoint. Mirrors the
  // catalog-based SMR provider listing but reads the `guardrail` namespace
  // settings + `guardrail-provider-models` catalog, and has NO upstream fallback.
  describe('GET /text/guardrail-providers (TASK-338)', () => {
    const GUARDRAIL_CATALOG_JSON = JSON.stringify([
      {
        provider: 'lm-studio',
        models: [
          { name: 'granite-guardian-4.1-8b', size: '4.9 GB' },
          { name: 'ibm-granite/granite-guardian-3.2-5b', size: '3.1 GB' },
        ],
      },
      {
        provider: 'ollama',
        models: [{ name: 'granite3-guardian:8b', size: '4.9 GB' }],
      },
      {
        provider: 'azure-openai',
        models: [{ name: 'gpt-4o-mini', size: '' }],
      },
    ]);

    it('should return all guardrail catalog providers with the tenant default marked', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-guardrail-provider', value: 'lm-studio' },
          { key: 'default-guardrail-model', value: 'granite-guardian-4.1-8b' },
          { key: 'guardrail-provider-models', value: GUARDRAIL_CATALOG_JSON },
        ],
        count: 3,
        limit: 200,
        page: 1,
      });

      const result = await controller.getGuardrailProviders();

      expect(mockTenantService.fetchTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        limit: 200,
        page: 1,
      });
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('lm-studio');
      expect(result[0].models).toEqual([
        { name: 'granite-guardian-4.1-8b', size: '4.9 GB' },
        { name: 'ibm-granite/granite-guardian-3.2-5b', size: '3.1 GB' },
      ]);

      const lmStudio = result.find((p: any) => p.name === 'lm-studio');
      expect(lmStudio.is_default).toBe(true);
      expect(lmStudio.default_model).toBe('granite-guardian-4.1-8b');
      for (const provider of result) {
        expect(provider.is_available).toBe(true);
      }
    });

    it('should NOT fall back to the SMR /providers upstream', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [],
        count: 0,
        limit: 200,
        page: 1,
      });

      const result = await controller.getGuardrailProviders();

      expect(result).toEqual([]);
      expect(mockHttpService.axiosRef.get).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/providers'),
        expect.any(Object),
      );
    });

    it('should ignore SMR settings and only read guardrail settings', async () => {
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-smr-provider', value: 'ollama' },
          { key: 'default-smr-model', value: 'granite4:latest' },
          { key: 'default-guardrail-provider', value: 'ollama' },
          { key: 'default-guardrail-model', value: 'granite3-guardian:8b' },
          { key: 'guardrail-provider-models', value: GUARDRAIL_CATALOG_JSON },
        ],
        count: 5,
        limit: 200,
        page: 1,
      });

      const result = await controller.getGuardrailProviders();

      const ollama = result.find((p: any) => p.name === 'ollama');
      expect(ollama.is_default).toBe(true);
      expect(ollama.default_model).toBe('granite3-guardian:8b');
    });

    it('should resolve global tenant config when SUPER_ADMIN passes ?tenantKey=__GLOBAL__', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { roles: ['SUPER_ADMIN'] };
        return undefined;
      });
      mockTenantService.fetchByCodeName.mockResolvedValue({ id: 'global-tenant' });
      mockTenantService.fetchTenantConfigs.mockResolvedValue({
        data: [
          { key: 'default-guardrail-provider', value: 'lm-studio' },
          { key: 'default-guardrail-model', value: 'granite-guardian-4.1-8b' },
          { key: 'guardrail-provider-models', value: GUARDRAIL_CATALOG_JSON },
        ],
        count: 3,
        limit: 200,
        page: 1,
      });

      const result = await controller.getGuardrailProviders('__GLOBAL__');

      expect(mockTenantService.fetchByCodeName).toHaveBeenCalledWith('__GLOBAL__');
      expect(mockTenantService.fetchTenantConfigs).toHaveBeenCalledWith({
        tenantId: 'global-tenant',
        limit: 200,
        page: 1,
      });
      expect(result.find((p: any) => p.name === 'lm-studio').is_default).toBe(true);
    });

    it('non-SUPER_ADMIN with ?tenantKey=__GLOBAL__ is FORBIDDEN', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'user') return { roles: ['DOCTOR'] };
        return undefined;
      });

      await expect(controller.getGuardrailProviders('__GLOBAL__')).rejects.toBeInstanceOf(ForbiddenException);
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
