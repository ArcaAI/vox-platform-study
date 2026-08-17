/**
 * SMR proxy — runtime-profile parameter injection.
 *
 * Kept in its own file rather than extending the 1700-line
 * `smr-proxy.controller.test.ts`, so the injection contract reads as one unit.
 *
 * The contract, in priority order:
 *   1. CALLER WINS — a parameter present on the request body is never clobbered.
 *   2. Otherwise the resolved profile value is injected.
 *   3. With NO profile rows (the shipped seed state) the forwarded body is
 * BYTE-IDENTICAL to today's — silent-change guard.
 *   4. A throwing resolver is FAIL-OPEN for parameters (the request still
 *      goes out), in contrast to the fail-closed model-identity path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextProxyController } from '../text-proxy.controller';

const emptyProfile = {
  provider: 'lm-studio',
  modelSlug: 'gemma-4',
  temperature: null,
  topP: null,
  maxTokens: null,
  contextLength: null,
  maxConcurrent: null,
  tpmLimit: null,
  rpmLimit: null,
  timeoutS: null,
  keepAliveSeconds: null,
  extraJson: null,
  isEmpty: true,
};

function build(profileResolver?: { resolveProfile: ReturnType<typeof vi.fn> }) {
  const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { content: 'ok' } }), get: vi.fn() } };
  const cls = { get: vi.fn(() => 'tenant-abc'), getId: vi.fn(() => 'req-1') };
  const config = { getConfigValue: vi.fn(() => 'http://localhost:8862') };
  const selection = { resolveSmrSelection: vi.fn(async () => ({ provider: 'lm-studio', model: 'gemma-4' })) };

  const ctrl = new TextProxyController(
    http as any,
    { fetchByCodeName: vi.fn() } as any,
    cls as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { getObject: vi.fn() } as any,
    config as any,
    undefined, // secretsService (@Optional)
    selection as any, // HarnessPolicyService
    undefined, // aiModelService (@Optional)
    undefined, // aiTaskDefaultService (@Optional)
    profileResolver as any, // AiRuntimeProfileService (@Optional)
  );

  return { ctrl, http, selection };
}

const bodyOf = (http: ReturnType<typeof build>['http']) => http.axiosRef.post.mock.calls[0][1];

beforeEach(() => vi.clearAllMocks());

describe('SMR proxy — runtime-profile injection', () => {
  it('injects resolved parameters when the caller supplied none', async () => {
    const resolver = {
      resolveProfile: vi.fn(async () => ({
        ...emptyProfile,
        temperature: 0.2,
        maxTokens: 2048,
        timeoutS: 300,
        isEmpty: false,
      })),
    };
    const { ctrl, http } = build(resolver);

    await ctrl.generate({ prompt: 'p', stream: false } as any);

    const body = bodyOf(http);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(2048);
    expect(body.timeout_s).toBe(300);
  });

  it('NEVER clobbers a caller-supplied parameter', async () => {
    const resolver = {
      resolveProfile: vi.fn(async () => ({ ...emptyProfile, temperature: 0.2, maxTokens: 2048, isEmpty: false })),
    };
    const { ctrl, http } = build(resolver);

    await ctrl.generate({ prompt: 'p', stream: false, temperature: 0.9 } as any);

    const body = bodyOf(http);
    expect(body.temperature).toBe(0.9); // caller wins
    expect(body.max_tokens).toBe(2048); // absent → injected
  });

  it('leaves the body untouched when the profile is empty (silent-change guard)', async () => {
    const resolver = { resolveProfile: vi.fn(async () => ({ ...emptyProfile })) };
    const { ctrl, http } = build(resolver);

    await ctrl.generate({ prompt: 'p', stream: false } as any);

    const body = bodyOf(http);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.timeout_s).toBeUndefined();
  });

  it('leaves the body untouched when no profile resolver is wired at all', async () => {
    const { ctrl, http } = build(undefined);

    await ctrl.generate({ prompt: 'p', stream: false } as any);

    const body = bodyOf(http);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('is FAIL-OPEN — a throwing resolver still forwards the request', async () => {
    const resolver = {
      resolveProfile: vi.fn(async () => {
        throw new Error('db-down');
      }),
    };
    const { ctrl, http } = build(resolver);

    await expect(ctrl.generate({ prompt: 'p', stream: false } as any)).resolves.toBeDefined();

    expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    const body = bodyOf(http);
    expect(body.model).toBe('gemma-4'); // model identity still resolved
    expect(body.temperature).toBeUndefined(); // nothing injected
  });

  it('does not resolve a profile when the model identity is unknown', async () => {
    const resolver = { resolveProfile: vi.fn() };
    const { ctrl } = build(resolver);

    // Caller pinned a model, so the selection resolver is skipped; the profile
    // still resolves against the caller's own provider/model.
    await ctrl.generate({ prompt: 'p', stream: false, provider: 'azure', model: 'gpt-4o' } as any);

    expect(resolver.resolveProfile).toHaveBeenCalledWith('azure', 'gpt-4o');
  });
});
