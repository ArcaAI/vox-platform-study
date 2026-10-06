/**
 * TASK-1047 FC-4 — the two `PromptAssemblyService` consumers that POST to `apps/text` themselves
 * (the finalize summary and the pre-summary job) hand the assembly's governance of its system
 * message to the ONE egress enrichment, with the platform pieces it emitted and the job tenant.
 * The enrichment decides whether `system_governance` rides the body.
 */
import { describe, expect, it, vi } from 'vitest';
import { PreSummaryProcessor } from '../../consultation/jobs/processors/pre-summary.processor';
import { SummaryService } from '../../consultation/summary/summary.service';

const TENANT = 'tenant-1047';
const GOVERNANCE = { pieces: [{ kind: 'TEMPLATE_BODY', key: 'body', digest: 'd' }], composedDigest: 'c' };
const PIECES = [{ kind: 'PLATFORM', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'platform-rules@1', text: 'RULES' }];
const ASSEMBLED = {
  userPrompt: 'u',
  systemPrompt: 'sys',
  hyperparameters: {},
  responseFormat: null,
  resolvedFrom: 'default',
  governance: GOVERNANCE,
  platformPieces: PIECES,
} as never;

const enrichment = () => ({
  applyTenantProviderOverrides: vi.fn(async (body: unknown) => body),
  applyTextRuntimeProfile: vi.fn(async (body: unknown) => body),
});
const http = () => ({ axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', content: 'S' } }) } });
const config = { get: vi.fn().mockReturnValue('http://text.invalid') } as never;
const secrets = { getSecretOptional: vi.fn().mockResolvedValue(''), encrypt: vi.fn(), decrypt: vi.fn() } as never;
const metrics = { recordTextCallDuration: vi.fn(), recordJobStart: vi.fn(() => vi.fn()), recordWaitingDuration: vi.fn() } as never;
const cls = () => {
  const store: Record<string, unknown> = { tenantId: TENANT };
  return {
    run: vi.fn((cb: () => unknown) => cb()),
    set: vi.fn(),
    get: vi.fn((k?: string) => (k === undefined ? store : store[k])),
    has: vi.fn(),
    isActive: vi.fn(() => true),
  } as never;
};

describe('FC-4 — assembled-prompt callers pass the governance hint', () => {
  it('SummaryService.executeTextGenerate', async () => {
    const e = enrichment();
    const service = new SummaryService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      http() as never,
      config,
      { emit: vi.fn() } as never,
      cls(),
      {} as never,
      {} as never,
      secrets,
      ...(Array.from({ length: 16 }, () => undefined) as never[]),
      e as never,
    );
    await (service as never as { executeTextGenerate(p: unknown, o: unknown): Promise<unknown> }).executeTextGenerate(
      { assembledPrompt: ASSEMBLED, options: {}, context: {} },
      {},
    );
    expect(e.applyTenantProviderOverrides.mock.calls[0]?.[1]).toMatchObject({
      phase: 'finalize',
      systemGovernance: { governance: GOVERNANCE, platformPieces: PIECES, tenantId: TENANT },
    });
  });

  it('PreSummaryProcessor.callTextService', async () => {
    const e = enrichment();
    const processor = new PreSummaryProcessor(
      { notifyProgress: vi.fn() } as never,
      {} as never,
      {} as never,
      http() as never,
      config,
      {} as never,
      {} as never,
      metrics,
      cls(),
      secrets,
      undefined,
      undefined,
      undefined,
      e as never,
    );
    await (processor as never as { callTextService(a: unknown, r: unknown, t: string): Promise<unknown> }).callTextService(ASSEMBLED, {}, TENANT);
    expect(e.applyTenantProviderOverrides.mock.calls[0]?.[1]).toMatchObject({
      phase: 'pre-summary',
      systemGovernance: { governance: GOVERNANCE, platformPieces: PIECES, tenantId: TENANT },
    });
  });
});
