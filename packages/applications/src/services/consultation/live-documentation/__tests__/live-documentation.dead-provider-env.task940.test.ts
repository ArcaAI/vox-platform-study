/**
 * TASK-940 Lane 2 — `LIVE_DOC_TEXT_PROVIDER` / `LIVE_DOC_TEXT_MODEL` were dead,
 * and dead against a rule this service states in its own comments.
 *
 * Both were read in the constructor into `this.textProvider` / `this.textModel`,
 * and all three TEXT call sites then did:
 *
 *     let provider = this.textProvider;
 *     let model = this.textModel;
 *     if (this.harnessPolicyService) ({ provider, model } = await …resolveTextSelection(…));
 *
 * `harnessPolicyService` is `@Optional()`, but `live-documentation.service.module.ts`
 * imports `HarnessPolicyServiceModule`, so in the real DI graph the branch that
 * DISCARDS the env value is the only branch ever taken. The env seed was
 * reachable only from a hand-constructed, non-DI instance — i.e. from tests.
 *
 * That is not merely dead code. The comment directly above one of those sites
 * already said the opposite of what the env read implied:
 *
 *   "provider/model SELECTION is never substituted with an env default — the
 *    tenant's assigned TEXT_GENERATION agent selects (TASK-876; the node
 *    `llmBinding` is retired)."
 *
 * and `09-infrastructure-devops.md` §"No hardcoded configuration" makes it a
 * rule rather than a preference: an engine or model id is not an env var.
 *
 * So the fix is deletion, not declaration. Declaring these two in
 * `turbo.json#globalEnv` would have hashed a value that cannot influence any
 * deployment into every task's cache key, and would have published a model
 * override in `.env.sample` that the agent cascade silently overrules — which is
 * exactly the "config theatre" the env-sync generator's own header warns about.
 *
 * These tests pin the deletion so it cannot be quietly reintroduced.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';

/** The retired names. A read of either is the regression. */
const RETIRED = ['LIVE_DOC_TEXT_PROVIDER', 'LIVE_DOC_TEXT_MODEL'] as const;

function buildService() {
  const cacheService = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  // Every retired name is SET here. A service that still reads one would observe
  // a value, so this fixture fails loudly rather than passing vacuously.
  const env: Record<string, string> = { LIVE_DOC_TEXT_PROVIDER: 'env-provider', LIVE_DOC_TEXT_MODEL: 'env-model' };
  const configService = { get: vi.fn((key: string) => env[key]) };

  // Deliberately NO harnessPolicyService — the only construction shape in which
  // the deleted env fallback could ever have been observable.
  const service = new LiveDocumentationService(
    { axiosRef: { post: vi.fn().mockResolvedValue({ data: {} }) } } as never,
    configService as never,
    cacheService as never,
    redisSubscriber as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { resolveEffective: vi.fn().mockResolvedValue({ value: undefined, sourceScope: 'code-default' }) } as never,
  );
  return { service, configService };
}

describe('LiveDocumentationService — retired provider/model env reads (TASK-940)', () => {
  it('never consults the retired provider/model env names', () => {
    const { configService } = buildService();

    const consulted = configService.get.mock.calls.map(([key]) => key);

    for (const name of RETIRED) {
      expect(consulted, `${name} must no longer be read — the agent cascade selects`).not.toContain(name);
    }
  });

  it('keeps reading the env names that ARE still live, so this is a surgical deletion', () => {
    // Guards the opposite failure: a sweep that removed the whole constructor
    // block would also pass the assertion above while breaking every deployment
    // that legitimately pins one of these.
    const { configService } = buildService();

    const consulted = configService.get.mock.calls.map(([key]) => key);

    expect(consulted).toContain('LIVE_DOC_ENABLED');
    expect(consulted).toContain('LIVE_DOC_HEARTBEAT_MS');
  });

  it('holds no provider/model field for an env value to land in', () => {
    // The structural half: even if a future edit re-read the env, there is no
    // longer a field for it to seed, so the three call sites cannot regress to
    // preferring it over `resolveTextSelection`.
    const { service } = buildService();

    expect('textProvider' in (service as unknown as Record<string, unknown>)).toBe(false);
    expect('textModel' in (service as unknown as Record<string, unknown>)).toBe(false);
  });
});
