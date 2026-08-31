/**
 * TEXT proxy — a forwarded body must never leave `provider` undefined.
 *
 * ─── The defect this file pins ──────────────────────────────────────────────
 *
 * `apps/text` carries `_HARDCODED_DEFAULT_PROVIDER = "lm-studio"`
 * (`src/text/models/requests.py`), which is a rule-00 violation on its own — an
 * engine name is never a literal in code. It has survived because the gateway
 * only ever resolved `{provider, model}` when the MODEL was absent
 * (`applyTextModelSelection`). So a caller that PINS a model and OMITS the
 * provider reached TEXT with `provider: undefined` and silently inherited the
 * literal: its request was routed to LM Studio whatever engine that model
 * actually lives on.
 *
 * `model` has no such default — TEXT 422s when it is missing
 * (`api/endpoints/generate.py`). The asymmetry IS the defect: one half of the
 * selection fails loudly, the other half guesses.
 *
 * ─── The contract these tests fix ───────────────────────────────────────────
 *
 *   1. Model absent  → resolve BOTH, as before. The pair must stay coherent, so
 *      a caller-supplied provider is still replaced here (unchanged behaviour).
 *   2. Model pinned, provider absent → fill the PROVIDER from the tenant's own
 *      resolved selection. The caller's model is never touched.
 *   3. Provider pinned → never touched, whatever else is set.
 *   4. The gateway never forwards an undefined/empty `provider`.
 *
 * Consequence worth stating: selection is `failMode: closed`
 * (`09-infrastructure-devops.md` §Configuration Tiers), and
 * `resolveTextSelection` throws when it cannot resolve. So a tenant with a
 * pinned model and no resolvable default now surfaces an error instead of being
 * silently routed to LM Studio. That is the intended fail-closed behaviour, not
 * a regression — and with the LM Studio deployment at `replicas: 0` the silent
 * route was not working anyway.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextProxyController } from '../text-proxy.controller';

function build(resolved: { provider: string; model: string } | Error = { provider: 'vllm', model: 'medgemma-27b' }) {
  const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { content: 'ok' } }), get: vi.fn() } };
  const cls = { get: vi.fn(() => 'tenant-abc'), getId: vi.fn(() => 'req-1') };
  const config = { getConfigValue: vi.fn(() => 'http://localhost:8862') };
  const selection = {
    resolveTextSelection: vi.fn(async () => {
      if (resolved instanceof Error) throw resolved;
      return resolved;
    }),
  };

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
  );

  return { ctrl, http, selection };
}

const bodyOf = (http: ReturnType<typeof build>['http']) => http.axiosRef.post.mock.calls[0][1];

beforeEach(() => vi.clearAllMocks());

describe('TEXT proxy — provider is never left for apps/text to guess', () => {
  it('fills the provider when the caller pins a model but omits the provider', async () => {
    const { ctrl, http, selection } = build();

    await ctrl.generate({ prompt: 'p', stream: false, model: 'whisper-large-v3' } as any);

    // The bug: this resolver was never consulted on a model-pinned request.
    expect(selection.resolveTextSelection).toHaveBeenCalledTimes(1);
    const body = bodyOf(http);
    expect(body.provider).toBe('vllm');
    // The caller chose the MODEL — it must survive untouched.
    expect(body.model).toBe('whisper-large-v3');
  });

  it('never forwards an undefined provider on a model-pinned request', async () => {
    const { ctrl, http } = build();

    await ctrl.generate({ prompt: 'p', stream: false, model: 'whisper-large-v3' } as any);

    const body = bodyOf(http);
    expect(body.provider).toBeDefined();
    expect(String(body.provider).length).toBeGreaterThan(0);
  });

  it('leaves a caller-supplied provider alone', async () => {
    const { ctrl, http, selection } = build();

    await ctrl.generate({ prompt: 'p', stream: false, model: 'gpt-4o', provider: 'azure-openai' } as any);

    expect(selection.resolveTextSelection).not.toHaveBeenCalled();
    const body = bodyOf(http);
    expect(body.provider).toBe('azure-openai');
    expect(body.model).toBe('gpt-4o');
  });

  it('resolves BOTH halves when the model is absent, so the pair stays coherent', async () => {
    const { ctrl, http } = build();

    // A provider without a model cannot be honoured on its own: the resolved
    // model belongs to the resolved provider, so both move together.
    await ctrl.generate({ prompt: 'p', stream: false, provider: 'ollama' } as any);

    const body = bodyOf(http);
    expect(body.provider).toBe('vllm');
    expect(body.model).toBe('medgemma-27b');
  });

  it('fails closed when a model-pinned request has no resolvable selection', async () => {
    const { ctrl, http } = build(new Error('No AiTaskDefault for text.finalize'));

    await expect(ctrl.generate({ prompt: 'p', stream: false, model: 'orphan-model' } as any)).rejects.toThrow();
    // Nothing reached TEXT, so nothing inherited its hardcoded provider literal.
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('does nothing when no selection resolver is wired (fixtures without HarnessPolicyService)', async () => {
    const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { content: 'ok' } }), get: vi.fn() } };
    const ctrl = new TextProxyController(
      http as any,
      { fetchByCodeName: vi.fn() } as any,
      { get: vi.fn(() => 'tenant-abc'), getId: vi.fn(() => 'req-1') } as any,
      { findById: vi.fn() } as any,
      { findById: vi.fn() } as any,
      { findById: vi.fn() } as any,
      { findById: vi.fn() } as any,
      { findById: vi.fn() } as any,
      { getObject: vi.fn() } as any,
      { getConfigValue: vi.fn(() => 'http://localhost:8862') } as any,
    );

    await expect(ctrl.generate({ prompt: 'p', stream: false, model: 'x' } as any)).resolves.toBeDefined();
  });
});
