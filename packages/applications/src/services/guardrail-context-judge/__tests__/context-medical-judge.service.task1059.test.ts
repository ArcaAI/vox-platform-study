/**
 * TASK-1059 C-0 / C-1 / OD-5 / OD-9 — the gateway's runtime medical judge over CONTEXT items.
 *
 * Context pieces are judged one region each (`scope: "context"`, `trust: "data"`), verdicts are
 * cached per `(tenant, policy version, sha256(text))`, an off-scope item is excluded with ONE
 * WARNING notice per consultation request, the generation is refused only when nothing is in scope,
 * and every failure to reach a verdict is fail-CLOSED.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContextJudgeUnavailableError } from '../IContextMedicalJudgeService';
import { CONTEXT_JUDGE_CACHE_TTL_SECONDS, CONTEXT_JUDGE_DEFAULT_POLICY_VERSION, ContextMedicalJudgeService } from '../context-medical-judge.service';

const TENANT = '7a000000-0000-0000-0000-000000000001';
const CONSULTATION = '7c000000-0000-0000-0000-000000000003';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type RegionVerdict = { key: string; is_medical: unknown; context_type?: string; confidence?: number };

function makeHarness(options: { cache?: boolean; notices?: boolean } = {}) {
  const store = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
  };
  const post = vi.fn();
  const httpService = { axiosRef: { post } };
  const configService = { get: vi.fn(() => 'http://guardrail.test') };
  const secrets = { getSecretOptional: vi.fn(async (key: string) => (key === 'INTERNAL_ACCESS_TOKEN' ? 'svc-token' : undefined)) };
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback) };
  const notices = { upsertByDedupeKey: vi.fn(async (entity: { id: string }) => ({ notice: entity, created: true })) };
  const service = new ContextMedicalJudgeService(
    httpService as never,
    configService as never,
    secrets as never,
    appSettings as never,
    options.cache === false ? undefined : (cache as never),
    options.notices === false ? undefined : (notices as never),
  );
  /** Answer the next judge call with one verdict per region key, from `verdictOf`. */
  const answer = (verdictOf: (key: string) => Partial<RegionVerdict> | null, extra: Record<string, unknown> = {}) =>
    post.mockImplementationOnce(async (_url: string, body: { regions: Array<{ key: string }> }) => ({
      data: {
        is_medical: true,
        confidence: 0.9,
        context_type: 'clinical',
        region_verdicts: body.regions
          .map((region) => {
            const verdict = verdictOf(region.key);
            return verdict === null ? null : { key: region.key, is_medical: true, context_type: 'clinical', confidence: 0.9, ...verdict };
          })
          .filter((entry) => entry !== null),
        ...extra,
      },
    }));
  return { service, post, cache, store, notices, answer };
}

const item = (id: string, text: string, kind: 'transcript' | 'case_note' | 'prior_visit' | 'attachment_text' | 'caller_input' = 'case_note') => ({
  id,
  kind,
  text,
});

describe('ContextMedicalJudgeService.judge', () => {
  it('answers an empty item list with no call and no refusal', async () => {
    const { service, post } = makeHarness();
    await expect(service.judge({ tenantId: TENANT, items: [] })).resolves.toEqual({ verdicts: [], inScopeIds: [], excludedIds: [], refused: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('packs every uncached item as one data region of a scope="context" judge call, with the internal headers', async () => {
    const { service, post, answer } = makeHarness();
    answer(() => ({}));
    const result = await service.judge({
      tenantId: TENANT,
      requestId: 'req-1',
      items: [item('encounter:1', 'Patient reports chest pain.', 'transcript'), item('cn-1', 'BP checked, follow up in 2 weeks.')],
    });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0]!;
    expect(url).toBe('http://guardrail.test/api/medical/validate');
    expect(body).toMatchObject({
      text: '',
      scope: 'context',
      request_id: 'req-1',
      regions: [
        { key: 'encounter:1', text: 'Patient reports chest pain.', trust: 'data' },
        { key: 'cn-1', text: 'BP checked, follow up in 2 weeks.', trust: 'data' },
      ],
    });
    expect(config.headers).toMatchObject({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': TENANT, 'X-Request-Id': 'req-1' });
    expect(config.timeout).toBeGreaterThan(0);

    expect(result.verdicts).toEqual([
      { id: 'encounter:1', digest: sha('Patient reports chest pain.'), inScope: true, contextType: 'clinical', confidence: 0.9, cached: false },
      { id: 'cn-1', digest: sha('BP checked, follow up in 2 weeks.'), inScope: true, contextType: 'clinical', confidence: 0.9, cached: false },
    ]);
    expect(result).toMatchObject({ inScopeIds: ['encounter:1', 'cn-1'], excludedIds: [], refused: false });
  });

  it('caches each verdict per tenant, policy version and digest for 24 h, and serves a repeat from the cache without a call', async () => {
    const { service, post, cache, answer } = makeHarness();
    answer(() => ({}));
    await service.judge({ tenantId: TENANT, items: [item('cn-1', 'Fever for three days.')] });
    expect(cache.setex).toHaveBeenCalledWith(
      `ctxjudge:${TENANT}:${CONTEXT_JUDGE_DEFAULT_POLICY_VERSION}:${sha('Fever for three days.')}`,
      CONTEXT_JUDGE_CACHE_TTL_SECONDS,
      expect.any(String),
    );
    expect(CONTEXT_JUDGE_CACHE_TTL_SECONDS).toBe(86_400);

    const again = await service.judge({ tenantId: TENANT, items: [item('cn-2', 'Fever for three days.')] });
    expect(post).toHaveBeenCalledTimes(1);
    expect(again.verdicts[0]).toMatchObject({ id: 'cn-2', inScope: true, cached: true });
    expect(again.inScopeIds).toEqual(['cn-2']);
  });

  it('sends only the uncached items, and a repeated text in one request once', async () => {
    const { service, post, answer } = makeHarness();
    answer(() => ({}));
    await service.judge({ tenantId: TENANT, items: [item('a', 'Cough since Monday.')] });
    answer(() => ({}));
    const result = await service.judge({
      tenantId: TENANT,
      items: [item('a', 'Cough since Monday.'), item('b', 'Wheeze on exam.'), item('c', 'Wheeze on exam.')],
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![1].regions).toEqual([{ key: 'b', text: 'Wheeze on exam.', trust: 'data' }]);
    expect(result.verdicts.map((verdict) => [verdict.id, verdict.cached, verdict.inScope])).toEqual([
      ['a', true, true],
      ['b', false, true],
      ['c', false, true],
    ]);
  });

  it('keys the cache by the policy version guardrail reports on `stats`, and looks up under it next time', async () => {
    const { service, post, cache, answer } = makeHarness();
    answer(() => ({}), { stats: { policy_version: 'pv-9' } });
    await service.judge({ tenantId: TENANT, items: [item('a', 'Headache.')] });
    expect(cache.setex).toHaveBeenCalledWith(`ctxjudge:${TENANT}:pv-9:${sha('Headache.')}`, CONTEXT_JUDGE_CACHE_TTL_SECONDS, expect.any(String));

    const again = await service.judge({ tenantId: TENANT, items: [item('b', 'Headache.')] });
    expect(post).toHaveBeenCalledTimes(1);
    expect(again.verdicts[0]!.cached).toBe(true);
  });

  it('works without a cache (every item judged)', async () => {
    const { service, post, answer } = makeHarness({ cache: false });
    answer(() => ({}));
    answer(() => ({}));
    await service.judge({ tenantId: TENANT, items: [item('a', 'Rash.')] });
    await service.judge({ tenantId: TENANT, items: [item('a', 'Rash.')] });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('excludes an off-scope item and raises ONE inbound WARNING notice on the consultation (OD-9)', async () => {
    const { service, notices, answer } = makeHarness();
    answer((key) => (key === 'cn-2' ? { is_medical: false, context_type: 'general', confidence: 0.8 } : {}));
    const result = await service.judge({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      requestId: 'req-7',
      items: [item('encounter:1', 'Chest pain on exertion.', 'transcript'), item('cn-2', 'Please book my flight to Goa.')],
    });

    expect(result).toMatchObject({ inScopeIds: ['encounter:1'], excludedIds: ['cn-2'], refused: false });
    expect(result.verdicts[1]).toMatchObject({ id: 'cn-2', inScope: false, contextType: 'general', confidence: 0.8 });
    expect(notices.upsertByDedupeKey).toHaveBeenCalledTimes(1);
    const notice = notices.upsertByDedupeKey.mock.calls[0]![0] as Record<string, unknown>;
    expect(notice).toMatchObject({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      type: 'WARNING',
      direction: 'INBOUND',
      action: 'warn',
      itemIds: ['cn-2'],
      messageKey: 'guardrail.warning.generic',
    });
    expect(notice.checks).toEqual([{ checkId: 'medical_validation', category: 'not_medical', severity: 'low' }]);
    // PHI-free: the item text never reaches the notice row.
    expect(JSON.stringify(notice)).not.toContain('Goa');

    // The same consultation request raising again is the same notice (dedupe key).
    answer((key) => (key === 'cn-3' ? { is_medical: false } : {}));
    await service.judge({ tenantId: TENANT, consultationId: CONSULTATION, requestId: 'req-7', items: [item('cn-3', 'Weather is nice.')] });
    const second = notices.upsertByDedupeKey.mock.calls[1]![0] as { id: string; dedupeKey: string };
    expect(second.id).toBe((notice as { id: string }).id);
  });

  it('raises no notice without a consultation', async () => {
    const { service, notices, answer } = makeHarness();
    answer(() => ({ is_medical: false }));
    const result = await service.judge({ tenantId: TENANT, items: [item('input:message', 'Tell me a joke.', 'caller_input')] });
    expect(result.excludedIds).toEqual(['input:message']);
    expect(notices.upsertByDedupeKey).not.toHaveBeenCalled();
  });

  it('a notice write failure never fails the judgement', async () => {
    const { service, notices, answer } = makeHarness();
    notices.upsertByDedupeKey.mockRejectedValueOnce(new Error('db down'));
    answer((key) => (key === 'b' ? { is_medical: false } : {}));
    const result = await service.judge({ tenantId: TENANT, consultationId: CONSULTATION, items: [item('a', 'Dyspnoea.'), item('b', 'Football scores.')] });
    expect(result.excludedIds).toEqual(['b']);
  });

  it('refuses when at least one item was judged and none is in scope', async () => {
    const { service, answer } = makeHarness();
    answer(() => ({ is_medical: false, context_type: 'general' }));
    const result = await service.judge({ tenantId: TENANT, items: [item('a', 'Stock tips.'), item('b', 'Holiday plans.')] });
    expect(result).toMatchObject({ inScopeIds: [], excludedIds: ['a', 'b'], refused: true });
  });

  it('fails CLOSED on a transport error / 5xx', async () => {
    const { service, post } = makeHarness();
    post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    await expect(service.judge({ tenantId: TENANT, items: [item('a', 'Nausea.')] })).rejects.toBeInstanceOf(ContextJudgeUnavailableError);
  });

  it('fails CLOSED when a region has no verdict or an undetermined one (version skew)', async () => {
    const { service, answer } = makeHarness();
    answer((key) => (key === 'b' ? null : {}));
    await expect(service.judge({ tenantId: TENANT, items: [item('a', 'Nausea.'), item('b', 'Vomiting.')] })).rejects.toBeInstanceOf(
      ContextJudgeUnavailableError,
    );
    answer(() => ({ is_medical: null }));
    await expect(service.judge({ tenantId: TENANT, items: [item('c', 'Diarrhoea.')] })).rejects.toBeInstanceOf(ContextJudgeUnavailableError);
  });

  it('fails CLOSED when guardrail answers without `region_verdicts` at all', async () => {
    const { service, post } = makeHarness();
    post.mockResolvedValueOnce({ data: { is_medical: true, confidence: 1, context_type: 'clinical' } });
    await expect(service.judge({ tenantId: TENANT, items: [item('a', 'Nausea.')] })).rejects.toBeInstanceOf(ContextJudgeUnavailableError);
  });

  it('never caches a verdict from a failed call', async () => {
    const { service, post, cache } = makeHarness();
    post.mockRejectedValueOnce(new Error('timeout of 120000ms exceeded'));
    await expect(service.judge({ tenantId: TENANT, items: [item('a', 'Nausea.')] })).rejects.toBeInstanceOf(ContextJudgeUnavailableError);
    expect(cache.setex).not.toHaveBeenCalled();
  });
});
