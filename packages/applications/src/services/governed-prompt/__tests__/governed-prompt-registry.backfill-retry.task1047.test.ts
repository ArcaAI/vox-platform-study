/**
 * TASK-1047 FC-3 — the boot backfill retries sources whose screening was UNAVAILABLE.
 * Bounded exponential backoff, never retries a FAIL, single-flight, stops on module destroy,
 * and a changed SYSTEM policy version kicks a fresh pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { GovernedPromptRegistryService } from '../governed-prompt-registry.service';
import { PromptScreeningUnavailableError } from '../guardrail-prompt-screen.client';

const TENANT = '7a000000-0000-0000-0000-000000000001';
const allow = { decision: 'allow', reasons: [], undetermined: false, piiRegions: new Set<string>() };
const block = { decision: 'block', reasons: ['jailbreak_detection'], undetermined: false, piiRegions: new Set<string>() };

function makeHarness(settings: Record<string, number> = {}) {
  const repository = {
    findPassing: vi.fn(async () => [] as Array<{ digest: string }>),
    upsertVerdict: vi.fn(async (input: Record<string, unknown>) => ({ id: 'row', version: 1, ...input })),
    findPublishedAgentSources: vi.fn(async () => [] as unknown[]),
    findApprovedVersionSources: vi.fn(
      async () => [{ id: 'pv-1', tenantId: TENANT, promptTemplateId: 'tpl-1', content: 'Template body.' }] as unknown[],
    ),
  };
  const client = {
    screenRegions: vi.fn(async (): Promise<unknown> => allow),
    fetchPolicyVersion: vi.fn(async () => 'pv-1' as string | null),
  };
  const cls = { get: vi.fn(), run: vi.fn(async (work: () => unknown) => work()) };
  const effective: Record<string, number> = { 'governedPrompt.backfillInitialDelayMs': 0, ...settings };
  const appSettings = { getValueWithDefault: vi.fn((key: string, fallback: number) => effective[key] ?? fallback) };
  const service = new GovernedPromptRegistryService(
    repository as never,
    client as never,
    { emit: vi.fn() } as never,
    cls as never,
    appSettings as never,
  );
  return { service, repository, client };
}

const unavailable = () => {
  throw new PromptScreeningUnavailableError('down');
};

describe('backfill retry (FC-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the boot pass waits governedPrompt.backfillInitialDelayMs (NLP warm-up) before screening anything', async () => {
    const { service, client, repository } = makeHarness({ 'governedPrompt.backfillInitialDelayMs': 5000 });
    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(repository.findApprovedVersionSources).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4999);
    expect(client.screenRegions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
  });

  it('a module destroyed during the initial delay never starts the pass', async () => {
    const { service, repository } = makeHarness({ 'governedPrompt.backfillInitialDelayMs': 5000 });
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repository.findApprovedVersionSources).not.toHaveBeenCalled();
  });

  it('retries UNAVAILABLE sources with doubling backoff capped at the max, then stops once clean', async () => {
    const { service, client } = makeHarness({ 'governedPrompt.backfillRetryMinMs': 1000, 'governedPrompt.backfillRetryMaxMs': 3000 });
    const log = vi.spyOn((service as never as { logger: { log: (m: unknown) => void } }).logger, 'log');
    client.screenRegions.mockImplementation(unavailable as never);

    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ message: 'governed-prompt.backfill.retry_scheduled', unavailable: 1, delayMs: 1000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith({ message: 'governed-prompt.backfill.retry_scheduled', unavailable: 1, delayMs: 2000 });

    await vi.advanceTimersByTimeAsync(2000);
    await service.drainBackground();
    expect(log).toHaveBeenCalledWith({ message: 'governed-prompt.backfill.retry_scheduled', unavailable: 1, delayMs: 3000 });

    // The guardrail comes back: the next pass is clean and schedules nothing.
    client.screenRegions.mockImplementation((async () => allow) as never);
    await vi.advanceTimersByTimeAsync(3000);
    await service.drainBackground();
    const calls = client.screenRegions.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.screenRegions.mock.calls.length).toBe(calls);
  });

  it('defaults to 30 s', async () => {
    const { service, client } = makeHarness();
    const log = vi.spyOn((service as never as { logger: { log: (m: unknown) => void } }).logger, 'log');
    client.screenRegions.mockImplementation(unavailable as never);
    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(log).toHaveBeenCalledWith({ message: 'governed-prompt.backfill.retry_scheduled', unavailable: 1, delayMs: 30_000 });
  });

  it('a clean pass schedules nothing', async () => {
    const { service } = makeHarness();
    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a FAIL is a real verdict and is never retried', async () => {
    const { service, client } = makeHarness();
    client.screenRegions.mockResolvedValue(block);
    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
  });

  it('retries only the UNAVAILABLE sources', async () => {
    const { service, repository, client } = makeHarness({ 'governedPrompt.backfillRetryMinMs': 1000 });
    repository.findApprovedVersionSources.mockResolvedValue([
      { id: 'a', tenantId: TENANT, promptTemplateId: 'tpl-ok', content: 'Fine body.' },
      { id: 'b', tenantId: TENANT, promptTemplateId: 'tpl-down', content: 'Down body.' },
    ]);
    client.screenRegions.mockImplementation((async (_t: string, regions: Array<{ text: string }>) => {
      if (regions[0]!.text === 'Down body.') unavailable();
      return allow;
    }) as never);
    service.onApplicationBootstrap();
    await service.drainBackground();
    client.screenRegions.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    expect((client.screenRegions.mock.calls[0] as unknown as [string, Array<{ text: string }>])[1][0]!.text).toBe('Down body.');
  });

  it('is single-flight: a policy-version kick during a running pass queues one pass behind it', async () => {
    const { service, client } = makeHarness();
    let release: () => void = () => undefined;
    client.screenRegions.mockImplementationOnce((() => new Promise((resolve) => (release = () => resolve(allow)))) as never);
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    // Two kicks while the first pass is still running.
    (service as never as { startPass: () => void }).startPass();
    (service as never as { startPass: () => void }).startPass();
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(2);
  });

  it('stops retrying on module destroy', async () => {
    const { service, client } = makeHarness();
    client.screenRegions.mockImplementation(unavailable as never);
    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(vi.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
  });

  it('a changed SYSTEM policy version kicks a fresh pass', async () => {
    const { service, client } = makeHarness();
    service.onApplicationBootstrap();
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    client.fetchPolicyVersion.mockResolvedValue('pv-2');
    await vi.advanceTimersByTimeAsync(61_000); // past the version cache TTL
    await service.currentPolicyVersion(SYSTEM_TENANT_ID);
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(2);
  });
});
