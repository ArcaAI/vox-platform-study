/**
 * TASK-1050 W2b on the gateway → TEXT egress enrichment.
 *
 * F1 (TASK-1049): the platform/contract pieces a composer emitted are registered BEFORE the governance
 * lookup, AWAITED with a bound (`governedPrompt.platformRegistrationWaitMs`), so the first call of a new
 * piece set is governed. On timeout or failure the call proceeds exactly as before (screened as
 * untrusted) and the outcome is counted (`governed_prompt_platform_registration_total{outcome}`).
 *
 * Correlation (README §9.6): `region_items` is stated only from the composer's hint (a caller's copy is
 * discarded), and `guardrailCorrelationHeaders` renders the trusted `X-Hope-*` correlation the gateway
 * sets itself; `stripHopeInternalHeaders` removes every caller-supplied `x-hope-*` header first.
 */
import { createHash } from 'node:crypto';
import { register } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '../../../interfaces';
import type { IGovernedPromptRegistry } from '../../governed-prompt/IGovernedPromptRegistry';
import { GOVERNED_PROMPT_PLATFORM_REGISTRATION_TOTAL } from '../../governed-prompt/governed-prompt.metrics';
import { guardrailCorrelationHeaders, stripHopeInternalHeaders } from '../guardrail-correlation';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';

const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-a' : undefined)) } as unknown as ClsService<IActiveUserContext>;
const PIECES = [{ kind: 'PLATFORM' as const, sourceType: 'PLATFORM' as const, sourceId: null, sourceKey: 'platform-rules@1', text: 'PLATFORM RULES' }];

function registry(register: () => Promise<void>): { reg: IGovernedPromptRegistry; order: string[] } {
  const order: string[] = [];
  const reg = {
    screenAndRegister: vi.fn(),
    areGoverned: vi.fn(async () => {
      order.push('areGoverned');
      return false;
    }),
    currentPolicyVersion: vi.fn(async () => 'pv-1'),
    registerPlatformPieces: vi.fn(async () => {
      await register();
      order.push('registered');
    }),
  } as unknown as IGovernedPromptRegistry;
  return { reg, order };
}

function service(reg: IGovernedPromptRegistry, settings: Record<string, unknown> = {}): TextRequestEnrichmentService {
  const appSettings = { getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in settings ? settings[key] : fallback)) };
  return new TextRequestEnrichmentService(cls, undefined, undefined, undefined, undefined, reg, appSettings as never);
}

// A governance that matches the body's system prompt, so the registry IS asked (`areGoverned`).
const governance = {
  pieces: [{ kind: 'PLATFORM' as const, key: 'platform-rules@1', digest: createHash('sha256').update('S', 'utf8').digest('hex') }],
  composedDigest: createHash('sha256').update('S', 'utf8').digest('hex'),
};

async function outcomeCount(outcome: string): Promise<number> {
  const metric = await register.getSingleMetric(GOVERNED_PROMPT_PLATFORM_REGISTRATION_TOTAL)?.get();
  return metric?.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

describe('F1 — platform-piece registration is awaited, bounded', () => {
  afterEach(() => vi.useRealTimers());

  it('registers BEFORE the governance lookup, so the first call can be governed', async () => {
    const { reg, order } = registry(async () => undefined);
    const before = await outcomeCount('registered');
    await service(reg).applyEgressSafety({ provider: 'lm-studio', system_prompt: 'S' }, { systemGovernance: { governance, platformPieces: PIECES } });
    expect(order).toEqual(['registered', 'areGoverned']);
    expect(await outcomeCount('registered')).toBe(before + 1);
  });

  it('a registration slower than the bound is abandoned (it finishes in the background) and counted as timeout', async () => {
    let finish: () => void = () => undefined;
    const { reg, order } = registry(() => new Promise<void>((resolve) => (finish = resolve)));
    const before = await outcomeCount('timeout');
    await service(reg, { 'governedPrompt.platformRegistrationWaitMs': 10 }).applyEgressSafety(
      { provider: 'lm-studio', system_prompt: 'S' },
      { systemGovernance: { governance, platformPieces: PIECES } },
    );
    expect(order).toEqual(['areGoverned']);
    expect(await outcomeCount('timeout')).toBe(before + 1);
    finish();
  });

  it('a failing registration never fails the call (counted as failed)', async () => {
    const { reg } = registry(async () => Promise.reject(new Error('guardrail down')));
    const before = await outcomeCount('failed');
    const body = await service(reg).applyEgressSafety(
      { provider: 'lm-studio', system_prompt: 'S' } as Record<string, unknown>,
      { systemGovernance: { governance, platformPieces: PIECES } },
    );
    expect(body.system_governance).toBeUndefined();
    expect(await outcomeCount('failed')).toBe(before + 1);
  });
});

describe('region_items and the correlation headers', () => {
  it('states region_items from the composer`s hint and discards a caller-supplied copy', async () => {
    const enrichment = new TextRequestEnrichmentService(cls);
    const forged = await enrichment.applyEgressSafety({ provider: 'p', region_items: { transcript: [{ itemId: 'x', itemVersion: 1 }] } } as Record<string, unknown>);
    expect(forged.region_items).toBeUndefined();
    const stated = await enrichment.applyEgressSafety({ provider: 'p' } as Record<string, unknown>, {
      regionItems: { transcript: [{ itemId: 'ci-1', itemVersion: 3 }], empty: [] },
    });
    expect(stated.region_items).toEqual({ transcript: [{ itemId: 'ci-1', itemVersion: 3 }] });
  });

  it('states agent_slug and response_items only from trusted hints; a caller`s copies are discarded', async () => {
    const enrichment = new TextRequestEnrichmentService(cls);
    const forged = await enrichment.applyEgressSafety({
      provider: 'p',
      agent_slug: 'someone-elses-agent',
      response_items: [{ itemId: 'not-mine', itemVersion: 1 }],
    } as Record<string, unknown>);
    expect(forged.agent_slug).toBeUndefined();
    expect(forged.response_items).toBeUndefined();
    const stated = await enrichment.applyEgressSafety({ provider: 'p' } as Record<string, unknown>, {
      agentSlug: 'scribe',
      responseItems: [{ itemId: 'note-1', itemVersion: 2 }, { itemId: '', itemVersion: 1 }],
    });
    expect(stated.agent_slug).toBe('scribe');
    expect(stated.response_items).toEqual([{ itemId: 'note-1', itemVersion: 2 }]);
  });

  it('bounds agent_slug (≤ 200) and response_items (≤ 64) to what TEXT accepts', async () => {
    const enrichment = new TextRequestEnrichmentService(cls);
    const body = await enrichment.applyEgressSafety({ provider: 'p' } as Record<string, unknown>, {
      agentSlug: 'x'.repeat(201),
      responseItems: Array.from({ length: 70 }, (_, index) => ({ itemId: `i-${index}`, itemVersion: 1 })),
    });
    expect(body.agent_slug).toBeUndefined();
    expect((body.response_items as unknown[]).length).toBe(64);
  });

  it('correlationHeaders renders the consultation from the hint plus the caller-known fields', () => {
    const enrichment = new TextRequestEnrichmentService(cls);
    expect(enrichment.correlationHeaders({ consultationId: 'c-9', correlation: { runId: 'r-1', itemId: 'i-2' } })).toEqual({
      'X-Hope-Consultation-Id': 'c-9',
      'X-Hope-Run-Id': 'r-1',
      'X-Hope-Item-Id': 'i-2',
    });
  });

  it('renders only the known, non-empty correlation fields under their canonical names', () => {
    expect(guardrailCorrelationHeaders({ consultationId: 'c-1', itemId: 'i-1', runKey: 'rk', runId: '', nodeId: undefined })).toEqual({
      'X-Hope-Consultation-Id': 'c-1',
      'X-Hope-Item-Id': 'i-1',
      'X-Hope-Run-Key': 'rk',
    });
  });

  it('strips every x-hope-* header a caller sent, whatever the case, and nothing else', () => {
    expect(
      stripHopeInternalHeaders({ 'X-Hope-Guardrail-Override': 'n-1', 'x-hope-consultation-id': 'forged', 'X-HOPE-RUN-ID': 'r', 'X-Request-Id': 'req', Accept: 'a' }),
    ).toEqual({ 'X-Request-Id': 'req', Accept: 'a' });
  });
});
