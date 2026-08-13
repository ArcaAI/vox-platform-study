/**
 * Credential-gated provider reconcilers.
 *
 * Replaces the stub-registry suite: availability is no longer hardcoded,
 * so what is worth testing is that the TWO gates (client implemented,
 * credential provisioned) are reported separately and that nothing here can
 * fail the sweep closed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderReconcilerRegistry,
  CredentialGatedReconciler,
  PROVIDER_RECONCILER_SPECS,
  summarizeAvailability,
  type ProviderReconcilerSpec,
} from '../provider-reconciler-registry';

const WINDOW = { start: new Date('2026-08-06T00:00:00.000Z'), end: new Date('2026-08-07T00:00:00.000Z') };

const noSecrets = async () => undefined;
const withSecret = async () => 'sk-readonly-test';

function spec(overrides: Partial<ProviderReconcilerSpec> = {}): ProviderReconcilerSpec {
  return { provider: 'testvendor', secretKey: 'TEST_COST_API_KEY', endpointHint: 'GET /usage', ...overrides };
}

describe('PROVIDER_RECONCILER_SPECS', () => {
  it('covers the providers the platform can be BILLED by, and no self-hosted engine', () => {
    const providers = PROVIDER_RECONCILER_SPECS.map((s) => s.provider);
    expect(providers).toEqual(expect.arrayContaining(['openai', 'anthropic', 'azure', 'azure-speech']));
    // Self-hosted engines have no vendor bill to reconcile against — including
    // one would produce a permanent, meaningless drift alert.
    for (const selfHosted of ['whisper_cpp', 'kokoro', 'indic_parler', 'lm-studio', 'gliner']) {
      expect(providers).not.toContain(selfHosted);
    }
  });

  it('names a concrete secret key and endpoint for every provider, so provisioning is unambiguous', () => {
    for (const s of PROVIDER_RECONCILER_SPECS) {
      expect(s.secretKey.length).toBeGreaterThan(0);
      expect(s.endpointHint.length).toBeGreaterThan(0);
    }
  });
});

describe('CredentialGatedReconciler.checkAvailability', () => {
  it('reports NO CLIENT distinctly from NO CREDENTIAL — they need different actions', async () => {
    const noClient = new CredentialGatedReconciler(spec(), withSecret);
    const noCredential = new CredentialGatedReconciler(spec({ fetchControlTotal: async () => null }), noSecrets);

    const a = await noClient.checkAvailability();
    const b = await noCredential.checkAvailability();

    expect(a.available).toBe(false);
    expect(b.available).toBe(false);
    if (!a.available) expect(a.reason).toMatch(/client not implemented/i);
    if (!b.available) expect(b.reason).toMatch(/no credential at TEST_COST_API_KEY/i);
  });

  it('is available once BOTH gates pass', async () => {
    const ready = new CredentialGatedReconciler(spec({ fetchControlTotal: async () => null }), withSecret);
    expect((await ready.checkAvailability()).available).toBe(true);
  });

  it('does not mistake a secrets-backend OUTAGE for an unprovisioned credential', async () => {
    const broken = new CredentialGatedReconciler(
      spec({ fetchControlTotal: async () => null }),
      async () => {
        throw new Error('vault sealed');
      },
    );
    const availability = await broken.checkAvailability();
    expect(availability.available).toBe(false);
    // The distinction matters: "unprovisioned" invites an operator to create a
    // second credential that was never the problem.
    if (!availability.available) expect(availability.reason).toMatch(/secrets lookup failed.*vault sealed/i);
  });

  it('never throws for any gate — reconciliation must not fail the sweep closed', async () => {
    for (const reconciler of buildProviderReconcilerRegistry(noSecrets).values()) {
      await expect(reconciler.checkAvailability()).resolves.toBeDefined();
    }
  });
});

describe('CredentialGatedReconciler.fetchControlTotal', () => {
  it('passes the credential and window through to the vendor client', async () => {
    const fetchControlTotal = vi.fn(async () => ({ provider: 'testvendor', windowStart: WINDOW.start, windowEnd: WINDOW.end, unit: 'tokens', quantity: 42 }));
    const reconciler = new CredentialGatedReconciler(spec({ fetchControlTotal }), withSecret);

    const total = await reconciler.fetchControlTotal(WINDOW.start, WINDOW.end);

    expect(total?.quantity).toBe(42);
    expect(fetchControlTotal).toHaveBeenCalledWith('sk-readonly-test', { start: WINDOW.start, end: WINDOW.end });
  });

  it('throws rather than shipping a fake zero when a caller skips the availability check', async () => {
    const reconciler = new CredentialGatedReconciler(spec(), withSecret); // no client
    // A silent `null` here would enter a drift comparison as 0 and read as
    // "the vendor billed nothing", which is a very different claim.
    await expect(reconciler.fetchControlTotal(WINDOW.start, WINDOW.end)).rejects.toThrow(/no client/i);
  });
});

describe('summarizeAvailability', () => {
  it('produces one row per provider, all unavailable while no credentials are provisioned', async () => {
    const summary = await summarizeAvailability(buildProviderReconcilerRegistry(noSecrets));

    expect(summary).toHaveLength(PROVIDER_RECONCILER_SPECS.length);
    expect(summary.every((row) => row.available === false)).toBe(true);
    expect(summary.map((row) => row.provider)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'azure']));
  });
});
