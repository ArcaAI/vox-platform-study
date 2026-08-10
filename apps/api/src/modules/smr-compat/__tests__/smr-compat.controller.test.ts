import { HttpException, Logger, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreSummaryRequest } from '../dto/pre-summary.request';
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

// TASK-592: department→governed-template resolver. Default returns undefined
// (no real tenant department matched) so every pre-existing test keeps the
// static dept×visit steering path unchanged.
const createMockTemplateService = () => ({
  toSummaryPromptType: vi.fn((visitType?: string | null) =>
    /follow|review|revisit|\bfu\b|\brv\b/i.test(visitType ?? '') ? 'revisit' : 'new-patient',
  ),
  resolveGovernedInstruction: vi.fn(async (): Promise<string | undefined> => undefined),
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
    const r = resolveDepartmentVisit({ department: '  ' }, { session_metadata: { current_department: 'Surgery', encounter: 'New Referral' } });
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

describe('PreSummaryRequest validation', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  it('accepts the compat SDK default max_tokens value', async () => {
    const transformed = (await pipe.transform({ current_department: 'General', visit_type: 'New / Referral', max_tokens: 65536 }, {
      type: 'body',
      metatype: PreSummaryRequest,
    } as never)) as PreSummaryRequest;

    expect(transformed.max_tokens).toBe(65536);
  });

  it('rejects values above the compat token ceiling', async () => {
    await expect(
      pipe.transform({ current_department: 'General', visit_type: 'New / Referral', max_tokens: 65537 }, {
        type: 'body',
        metatype: PreSummaryRequest,
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: expect.arrayContaining(['max_tokens must not be greater than 65536']),
      }),
    });
  });
});

describe('SmrCompatController', () => {
  let controller: SmrCompatController;
  let http: ReturnType<typeof createMockHttpService>;
  let config: ReturnType<typeof createMockConfigService>;
  let cls: ReturnType<typeof createMockClsService>;
  let secrets: ReturnType<typeof createMockSecrets>;
  let policy: ReturnType<typeof createMockHarnessPolicy>;
  let template: ReturnType<typeof createMockTemplateService>;

  beforeEach(() => {
    vi.clearAllMocks();
    http = createMockHttpService();
    config = createMockConfigService();
    cls = createMockClsService();
    secrets = createMockSecrets();
    policy = createMockHarnessPolicy();
    template = createMockTemplateService();
    controller = new SmrCompatController(http as any, config as any, cls as any, policy as any, template as any, secrets as any);
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

    // TASK-599 — the requesting doctor's DNA writing-style is resolved by
    // doctor_id and injected into the SMR system_prompt; omitted entirely when no
    // doctor_id is supplied (D5: department + visit-type only).
    it('injects the doctor DNA writing style into the SMR system_prompt when doctor_id is provided', async () => {
      const dna = { getEffectiveStyleText: vi.fn().mockResolvedValue('Terse SOAP, active voice.') };
      const controllerWithDna = new SmrCompatController(
        http as any,
        config as any,
        cls as any,
        policy as any,
        template as any,
        secrets as any,
        dna as any,
      );
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

      const res = createMockRes();
      await controllerWithDna.summarySync(syncRequest({ doctor_id: 'doctor-1' }), {} as never, res as never);

      expect(dna.getEffectiveStyleText).toHaveBeenCalledWith('doctor-1');
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.system_prompt).toContain('Terse SOAP, active voice.');
    });

    it('does NOT resolve or inject DNA style when doctor_id is absent', async () => {
      const dna = { getEffectiveStyleText: vi.fn().mockResolvedValue('SHOULD NOT APPEAR') };
      const controllerWithDna = new SmrCompatController(
        http as any,
        config as any,
        cls as any,
        policy as any,
        template as any,
        secrets as any,
        dna as any,
      );
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

      const res = createMockRes();
      await controllerWithDna.summarySync(syncRequest(), {} as never, res as never);

      expect(dna.getEffectiveStyleText).not.toHaveBeenCalled();
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.system_prompt).not.toContain('SHOULD NOT APPEAR');
    });

    // TASK-600 — translate the transcript to English via SMR /api/v1/translate
    // before summarizing; BYOK resolved from the unified provider plane; fail-open
    // to the original transcript on error; no call when the flag is absent.
    it('translates the transcript via SMR /api/v1/translate (with tenant BYOK) before summarizing', async () => {
      const providerConnection = {
        resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides: { sarvam: { api_key: 'byok', funding: 'tenant' } } }),
      };
      const httpLocal = createMockHttpService();
      httpLocal.axiosRef.post.mockImplementation((url: string, reqBody: { texts?: string[] }) => {
        if (String(url).includes('/api/v1/translate')) {
          return Promise.resolve({ data: { translations: (reqBody.texts ?? []).map((t) => `EN:${t}`), provider: 'sarvam', chars: 0 } });
        }
        return Promise.resolve({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      });
      const ctrl = new SmrCompatController(
        httpLocal as any,
        config as any,
        cls as any,
        policy as any,
        template as any,
        secrets as any,
        undefined,
        providerConnection as any,
      );

      const res = createMockRes();
      await ctrl.summarySync(syncRequest({ translate_to_english: true }), {} as never, res as never);

      expect(providerConnection.resolveTenantCloudOverrides).toHaveBeenCalledWith('stt', 'tenant-1');
      const calls = httpLocal.axiosRef.post.mock.calls;
      const translateCall = calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/translate'));
      expect(translateCall).toBeTruthy();
      expect(translateCall![1].texts).toEqual(['What brings you in?', 'Chest tightness.']);
      expect(translateCall![1].provider).toBe('sarvam');
      expect(translateCall![1].provider_overrides.sarvam.api_key).toBe('byok');
      const smrCall = calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'));
      expect(smrCall![1].prompt).toContain('EN:What brings you in?');
      expect(smrCall![1].prompt).toContain('EN:Chest tightness.');
    });

    it('forces the summary OUTPUT language to English when the transcript is translated (AC: EN summary from a non-English transcript)', async () => {
      const providerConnection = {
        resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides: { sarvam: { api_key: 'byok', funding: 'tenant' } } }),
      };
      const httpLocal = createMockHttpService();
      httpLocal.axiosRef.post.mockImplementation((url: string, reqBody: { texts?: string[] }) => {
        if (String(url).includes('/api/v1/translate')) {
          return Promise.resolve({ data: { translations: (reqBody.texts ?? []).map((t) => `EN:${t}`), provider: 'sarvam', chars: 0 } });
        }
        return Promise.resolve({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      });
      const ctrl = new SmrCompatController(
        httpLocal as any,
        config as any,
        cls as any,
        policy as any,
        template as any,
        secrets as any,
        undefined,
        providerConnection as any,
      );

      // A Malayalam-language consultation WITH the translate flag ON: the
      // transcript is translated to English, so the output-language directive
      // must switch from 'ml' to 'en' (otherwise the model writes an English
      // transcript back up as a Malayalam summary — the TASK-600 defect).
      const mlBody = syncRequest({
        translate_to_english: true,
        session_data: {
          session_id: 'sess-ml',
          created_at: '2026-07-27T09:30:00Z',
          conversation_segments: [
            { speaker: 'provider', text: 'ചോദ്യം', timestamp: '2026-07-27T09:30:05Z' },
            { speaker: 'patient', text: 'നെഞ്ചുവേദന', timestamp: '2026-07-27T09:30:12Z' },
          ],
          session_metadata: { language: 'ml' },
        },
      } as Partial<SyncSummaryRequest>);
      const res = createMockRes();
      await ctrl.summarySync(mlBody, {} as never, res as never);

      const smrCall = httpLocal.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'));
      expect(smrCall![1].prompt).toContain('EN:ചോദ്യം'); // transcript translated
      // TASK-650: the bare `Language: X` label was replaced by an explicit
      // directive that also overrides the department template's own
      // "content in conversation language" clause.
      expect(smrCall![1].system_prompt).toContain('Write ALL summary content in English'); // output forced to English
      expect(smrCall![1].system_prompt).not.toContain('Malayalam');
    });

    it('falls back to the ORIGINAL transcript when translation fails (fail-open)', async () => {
      const providerConnection = { resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides: {} }) };
      const httpLocal = createMockHttpService();
      httpLocal.axiosRef.post.mockImplementation((url: string) => {
        if (String(url).includes('/api/v1/translate')) return Promise.reject(new Error('smr translate down'));
        return Promise.resolve({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      });
      const ctrl = new SmrCompatController(
        httpLocal as any,
        config as any,
        cls as any,
        policy as any,
        template as any,
        secrets as any,
        undefined,
        providerConnection as any,
      );

      const res = createMockRes();
      await ctrl.summarySync(syncRequest({ translate_to_english: true }), {} as never, res as never);

      const smrCall = httpLocal.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/generate'));
      expect(smrCall![1].prompt).toContain('What brings you in?'); // original, untranslated
      expect(res.jsonBody).toBeTruthy(); // summary still produced
    });

    // TASK-643 — this used to prove the CONTROLLER called the resolver twice
    // (its own hand-rolled tenant→SYSTEM cascade, the only one in the codebase).
    // The cascade now lives in the resolver, so the controller makes ONE call
    // and the platform tier arrives labelled `funding: 'platform'` — which is
    // what makes the translation bill as platform spend rather than as the
    // tenant's own key.
    it('serves the global-admin (SYSTEM) Sarvam credential through the shared cascade, labelled platform', async () => {
      const providerConnection = {
        resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides: { sarvam: { api_key: 'platform-byok', funding: 'platform' } } }),
      };
      const httpLocal = createMockHttpService();
      httpLocal.axiosRef.post.mockImplementation((url: string, reqBody: { texts?: string[] }) => {
        if (String(url).includes('/api/v1/translate')) {
          return Promise.resolve({ data: { translations: (reqBody.texts ?? []).map((t) => `EN:${t}`), provider: 'sarvam', chars: 0 } });
        }
        return Promise.resolve({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      });
      const ctrl = new SmrCompatController(
        httpLocal as any,
        config as any,
        cls as any,
        policy as any,
        template as any,
        secrets as any,
        undefined,
        providerConnection as any,
      );

      const res = createMockRes();
      await ctrl.summarySync(syncRequest({ translate_to_english: true }), {} as never, res as never);

      // ONE call, on the caller's tenant — the SYSTEM read happens inside the
      // resolver, under the veto and the entitlement gate like every other path.
      expect(providerConnection.resolveTenantCloudOverrides).toHaveBeenCalledWith('stt', 'tenant-1');
      expect(providerConnection.resolveTenantCloudOverrides.mock.calls.map((c: unknown[]) => c[1])).not.toContain(
        '00000000-0000-0000-0000-000000000000',
      );
      const translateCall = httpLocal.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/translate'));
      expect(translateCall![1].provider_overrides.sarvam.api_key).toBe('platform-byok');
      expect(translateCall![1].provider_overrides.sarvam.funding).toBe('platform');
    });

    it('does not call SMR translate when translate_to_english is absent', async () => {
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
      await invokeSummary(syncRequest());
      const translateCall = http.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/translate'));
      expect(translateCall).toBeFalsy();
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
      http.axiosRef.post.mockRejectedValueOnce({ response: { status: 500, data: 'llm boom' } }).mockResolvedValueOnce({ data: { content: good } });

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
      // TASK-634 D-10 — v1 `routes.py`: temperature 0.2, max_tokens 800 (the
      // 800-token ceiling is what enforces the prompt's "CRISP" instruction).
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

  describe('Department-aware governed template steering (TASK-592)', () => {
    it('resolves the governed instruction for the resolved tenant + department/visit and injects it into the SMR system_prompt', async () => {
      template.resolveGovernedInstruction.mockResolvedValue('Cardiology instruction: capture ejection fraction and rhythm.');
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

      await invokeSummary(syncRequest({ department: 'Cardiology', visit_type: 'Follow-up' }));

      expect(template.resolveGovernedInstruction).toHaveBeenCalledWith('tenant-1', 'Cardiology', 'revisit', expect.objectContaining({ visitType: expect.any(String) }));
      const [, body] = http.axiosRef.post.mock.calls[0];
      expect(body.system_prompt).toContain('capture ejection fraction and rhythm');
    });

    it('falls back to the static steering (no governed instruction) when no tenant department matches', async () => {
      template.resolveGovernedInstruction.mockResolvedValue(undefined);
      http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

      await invokeSummary(syncRequest({ department: 'Rheumatology', visit_type: 'New Referral' }));

      const [, body] = http.axiosRef.post.mock.calls[0];
      // Static rheumatology×new_referral steering still applies (v1 field set).
      expect(body.system_prompt).toContain('Department-specific documentation focus');
    });

    it('resolves the pre-summary governed template with the pre-summary prompt type', async () => {
      template.resolveGovernedInstruction.mockResolvedValue('Cardiology pre-summary instruction.');
      http.axiosRef.post.mockResolvedValue({ data: { content: '**Confirmed & Provisional Diagnoses**\n- HTN' } });

      await invokePresummary({ current_department: 'Cardiology', visit_type: 'New Referral' } as PreSummaryRequest);

      expect(template.resolveGovernedInstruction).toHaveBeenCalledWith('tenant-1', 'Cardiology', 'pre-summary', expect.any(Object));
      const [, body] = http.axiosRef.post.mock.calls[0];
      // TASK-634: the governed template IS the user prompt (v1 shape); the
      // system prompt stays v1's dedicated pre-summary system message.
      expect(body.prompt).toContain('Cardiology pre-summary instruction');
      expect(body.system_prompt).toContain('department-aware pre-summaries from EMR context');
    });

    it('pre-summary retries the tenant fallback provider on a provider-side failure (parity with summary)', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post
        .mockRejectedValueOnce({ response: { status: 500 } }) // primary provider error
        .mockResolvedValueOnce({ data: { content: '**Confirmed & Provisional Diagnoses**\n- HTN' } }); // fallback ok

      const res = await invokePresummary({ current_department: 'Cardiology' } as PreSummaryRequest);

      expect(policy.resolveSmrFallbackSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
      expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
      expect(http.axiosRef.post.mock.calls[1][1].provider).toBe('azure-openai');
      expect(res.pre_summary).toContain('HTN');
    });

    it('pre-summary does not fall back when SMR is unreachable (connect-phase failure)', async () => {
      policy.resolveSmrFallbackSelection.mockResolvedValue({ provider: 'azure-openai', model: 'gpt-4o-foundry' });
      http.axiosRef.post.mockRejectedValue({ code: 'ECONNREFUSED' });

      await expect(invokePresummary({ current_department: 'Cardiology' } as PreSummaryRequest)).rejects.toBeInstanceOf(HttpException);
      expect(policy.resolveSmrFallbackSelection).not.toHaveBeenCalled();
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
      // The handler now awaits the stream to completion (required so the
      // pre-content fallback can observe the outcome), so the frames must be
      // written WHILE it is pending — PassThrough buffers them until the pump
      // attaches its reader.
      const done = controller.summarySync(syncRequest({ stream: true }), {} as never, res as never);
      for (const f of frames) smrStream.write(f);
      smrStream.end();
      await done;
      await flushStream();
      return res;
    };

    it('sets text/event-stream headers, forwards each chunk as a delta, and emits a terminal result', async () => {
      const res = await runSummaryStream([
        smrFrame('chunk', { content: '{"chief_complaint":"x",' }),
        smrFrame('chunk', { content: '"summary":"y"}' }),
        smrFrame('done'),
      ]);

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

      const done = controller.presummary({ current_department: 'Cardiology', stream: true } as PreSummaryRequest, {} as never, res as never);
      smrStream.write(smrFrame('chunk', { content: '**Confirmed & Provisional Diagnoses**\n- Hypertension' }));
      smrStream.write(smrFrame('done'));
      smrStream.end();
      await done;
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

      const done = controller.summarySync(syncRequest({ stream: true }), {} as never, res as never);
      smrStream.write(smrFrame('chunk', { content: '{"chief_complaint":"x","summary":"y"}' }));
      smrStream.write(smrFrame('done'));
      smrStream.end();
      await done;
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
      const res = await runSummaryStream([
        smrFrame('chunk', { content: '{"partial":' }),
        smrFrame('error', { content: 'SECRET_PHI_LEAK', data: { note: 'SECRET_PHI_LEAK' } }),
      ]);

      const out = written(res);
      expect(out).toContain('event: error');
      expect(out).not.toContain('SECRET_PHI_LEAK');
      expect(res.end).toHaveBeenCalled();
    });

    it('forwards SMR reasoning frames to the client as a separate `reasoning` event, never mixed into the result', async () => {
      const res = await runSummaryStream([
        smrFrame('reasoning', { content: 'Weighing the differential…' }),
        smrFrame('chunk', { content: '{"chief_complaint":"x","summary":"y"}' }),
        smrFrame('done'),
      ]);

      expect(written(res)).toContain('event: reasoning');
      expect(sseEventData(res, 'reasoning')).toEqual({ text: 'Weighing the differential…' });
      // Reasoning is NOT part of the answer — the result still parses cleanly.
      const result = sseEventData(res, 'result') as SummaryResponse;
      expect(result.summary.summary).toBe('y');
    });
  });

  // TASK-652 §3.1 — an empty context must not be indistinguishable from a full
  // one in the logs. One INFO line per pre-summary/summary request, booleans
  // and lengths only — never field content.
  describe('Context-presence logging (TASK-652 §3.1)', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    /** All `logger.log` call payloads whose `message` matches. */
    const logCallsFor = (message: string): Record<string, unknown>[] =>
      logSpy.mock.calls.map(([arg]) => arg as Record<string, unknown>).filter((c) => c?.message === message);

    describe('pre-summary', () => {
      const populated = (): PreSummaryRequest =>
        ({
          current_department: 'Cardiology',
          visit_type: 'Follow-up',
          age: '54',
          dob: '1970-01-01',
          gender: 'F',
          formatted_vitals: 'BP 142/88, HR 78 — SECRET_VITALS_MARKER',
          formatted_test_results: 'Troponin 0.02 — SECRET_LABS_MARKER',
          formatted_previous_visits: 'Visit 2026-01-01 — SECRET_VISITS_MARKER',
          language: 'en',
        }) as PreSummaryRequest;

      it('logs true/populated booleans + lengths + identifiers for a fully-populated request (non-stream)', async () => {
        const body = populated();
        http.axiosRef.post.mockResolvedValue({ data: { content: '**Confirmed & Provisional Diagnoses**\n- HTN' } });

        await invokePresummary(body);

        const calls = logCallsFor('SMR compat pre-summary context received');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          hasVitals: true,
          hasTestResults: true,
          hasPreviousVisits: true,
          hasAge: true,
          hasDob: true,
          hasGender: true,
          department: 'Cardiology',
          visitType: 'Follow-up',
          language: 'en',
          vitalsChars: body.formatted_vitals!.length,
          testResultsChars: body.formatted_test_results!.length,
          previousVisitsChars: body.formatted_previous_visits!.length,
          correlationId: 'req-test-id',
        });
      });

      it('logs false/0/null for an empty-context request (non-stream)', async () => {
        http.axiosRef.post.mockResolvedValue({ data: { content: 'plain text' } });

        await invokePresummary({} as PreSummaryRequest);

        const calls = logCallsFor('SMR compat pre-summary context received');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          hasVitals: false,
          hasTestResults: false,
          hasPreviousVisits: false,
          hasAge: false,
          hasDob: false,
          hasGender: false,
          department: null,
          visitType: null,
          language: null,
          vitalsChars: 0,
          testResultsChars: 0,
          previousVisitsChars: 0,
        });
      });

      it('logs on the STREAMING path too', async () => {
        const body = { ...populated(), stream: true } as PreSummaryRequest;
        const smrStream = new PassThrough();
        http.axiosRef.post.mockResolvedValue({ data: { task_id: 't-log' } });
        http.axiosRef.get.mockResolvedValue({ data: smrStream });
        const res = createMockRes();

        const done = controller.presummary(body, {} as never, res as never);
        smrStream.write(smrFrame('chunk', { content: '**Confirmed & Provisional Diagnoses**\n- HTN' }));
        smrStream.write(smrFrame('done'));
        smrStream.end();
        await done;
        await flushStream();

        const calls = logCallsFor('SMR compat pre-summary context received');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ hasVitals: true, department: 'Cardiology' });
      });

      it('never logs the actual field content (PHI)', async () => {
        const body = populated();
        http.axiosRef.post.mockResolvedValue({ data: { content: '**Confirmed & Provisional Diagnoses**\n- HTN' } });

        await invokePresummary(body);

        const serialized = JSON.stringify(logSpy.mock.calls);
        expect(serialized).not.toContain('SECRET_VITALS_MARKER');
        expect(serialized).not.toContain('SECRET_LABS_MARKER');
        expect(serialized).not.toContain('SECRET_VISITS_MARKER');
        expect(serialized).not.toContain(body.dob);
      });
    });

    describe('summary', () => {
      const populated = (): SyncSummaryRequest =>
        syncRequest({
          include_pre_summary_in_context: true,
          translate_to_english: false,
          session_data: {
            ...syncRequest().session_data,
            patient_info: { name: 'SECRET_PATIENT_NAME' },
            pre_summary_text: 'SECRET_PRESUMMARY_TEXT',
            test_results_text: 'SECRET_TEST_RESULTS_TEXT',
            previous_visits_text: 'SECRET_PREVIOUS_VISITS_TEXT',
          },
        });

      it('logs true booleans + transcript counts for a fully-populated request (non-stream)', async () => {
        const body = populated();
        http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

        await invokeSummary(body);

        const calls = logCallsFor('SMR compat summary context received');
        expect(calls).toHaveLength(1);
        const expectedChars = body.session_data.conversation_segments!.reduce((sum, s) => sum + s.text.length, 0);
        expect(calls[0]).toMatchObject({
          hasPatientInfo: true,
          hasPreSummary: true,
          hasTestResults: true,
          hasPreviousVisits: true,
          transcriptSegments: 2,
          transcriptChars: expectedChars,
          includePreSummaryInContext: true,
          translateToEnglish: false,
          correlationId: 'req-test-id',
        });
      });

      it('logs false booleans + zero transcript counts for an empty-context request (non-stream)', async () => {
        http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
        const body = syncRequest({
          session_data: { session_id: 'sess-empty', created_at: '2026-07-27T09:30:00Z' },
        });

        await invokeSummary(body);

        const calls = logCallsFor('SMR compat summary context received');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          hasPatientInfo: false,
          hasPreSummary: false,
          hasTestResults: false,
          hasPreviousVisits: false,
          transcriptSegments: 0,
          transcriptChars: 0,
          includePreSummaryInContext: false,
          translateToEnglish: false,
        });
      });

      it('reflects translate_to_english: true regardless of the translate call outcome', async () => {
        // No providerConnectionService wired on this controller, and the mocked
        // /generate response also answers the /translate POST, so translation
        // fails to parse and fails OPEN — the log still reflects the flag the
        // caller sent, not whether translation succeeded.
        http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });
        const body = syncRequest({ translate_to_english: true });

        await invokeSummary(body);

        const calls = logCallsFor('SMR compat summary context received');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ translateToEnglish: true });
      });

      it('logs on the STREAMING path too', async () => {
        const body = { ...populated(), stream: true } as SyncSummaryRequest;
        const smrStream = new PassThrough();
        http.axiosRef.post.mockResolvedValue({ data: { task_id: 't-log-summary' } });
        http.axiosRef.get.mockResolvedValue({ data: smrStream });
        const res = createMockRes();

        const done = controller.summarySync(body, {} as never, res as never);
        smrStream.write(smrFrame('chunk', { content: '{"chief_complaint":"x","summary":"y"}' }));
        smrStream.write(smrFrame('done'));
        smrStream.end();
        await done;
        await flushStream();

        const calls = logCallsFor('SMR compat summary context received');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ hasPatientInfo: true, hasPreSummary: true });
      });

      it('never logs the actual field content (PHI)', async () => {
        const body = populated();
        http.axiosRef.post.mockResolvedValue({ data: { content: JSON.stringify({ chief_complaint: 'x', summary: 'y' }) } });

        await invokeSummary(body);

        const serialized = JSON.stringify(logSpy.mock.calls);
        expect(serialized).not.toContain('SECRET_PATIENT_NAME');
        expect(serialized).not.toContain('SECRET_PRESUMMARY_TEXT');
        expect(serialized).not.toContain('SECRET_TEST_RESULTS_TEXT');
        expect(serialized).not.toContain('SECRET_PREVIOUS_VISITS_TEXT');
      });
    });
  });
});
