/**
 * Read-only effective HarnessPolicy summary.
 * Renders resolved values + a per-key "who controls this" label; asserts NO
 * mutating controls exist anywhere on the card (per the TDD test list item
 * 5: "effective-config view... no mutating controls present").
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { HarnessPolicySummary } from '../../api/harness-policy-summary-types';
import { EffectiveHarnessPolicyCard } from '../effective-harness-policy-card';

function policy(overrides: Partial<HarnessPolicySummary> = {}): HarnessPolicySummary {
  return {
    id: 'hp-1',
    tenantId: 'tnt-1',
    source: 'tenant',
    entityFaithfulnessThreshold: 0.8,
    coverageThreshold: 0.75,
    citationPresenceThreshold: 0.6,
    numericDoseThreshold: 0.9,
    groundednessThreshold: 0.7,
    safetyEnabled: true,
    phiEnabled: true,
    phiFailClosed: true,
    textProvider: null,
    textModel: null,
    maxRegen: 2,
    gateSlaSeconds: 300,
    gateEscalationSeconds: 600,
    toolAllowlist: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 4,
    ...overrides,
  };
}

function stubFetch(row: HarnessPolicySummary): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === '/api/hope/admin/harness/policy') return Response.json(row);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('EffectiveHarnessPolicyCard', () => {
  it('renders every resolved value with a tenant/super-admin "controlled by" badge', async () => {
    stubFetch(policy());
    renderWithProviders(<EffectiveHarnessPolicyCard />);

    expect(await screen.findByText('Entity faithfulness threshold')).toBeDefined();
    expect(screen.getByText('0.8')).toBeDefined();
    expect(screen.getByText('Safety guardrail')).toBeDefined();
    expect(screen.getAllByText('tenant').length).toBeGreaterThan(0);
    // TENANT_LOCKED_POLICY_KEYS count: 3 safety/PHI toggles + textProvider/textModel
    // Safety provider/model left with their columns in
    expect(screen.getAllByText('super admin').length).toBe(5);
  });

  it('is read-only — no inputs, switches or save controls anywhere on the card', async () => {
    stubFetch(policy());
    renderWithProviders(<EffectiveHarnessPolicyCard />);

    await screen.findByText('Entity faithfulness threshold');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    // The one button on the card is a plain-href deep link to the owning editor.
    const link = screen.getByRole('link', { name: /edit tenant-controlled values/i });
    expect(link.getAttribute('href')).toBe('/harness/policy');
  });

  it('exposes the scrollable policy table as a named, keyboard-reachable region', async () => {
    stubFetch(policy());
    renderWithProviders(<EffectiveHarnessPolicyCard />);

    await screen.findByText('Entity faithfulness threshold');
    const region = screen.getByRole('region', { name: 'Effective harness policy' });
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('surfaces an error state with retry when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    renderWithProviders(<EffectiveHarnessPolicyCard />);

    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch(policy());
    const { container } = renderWithProviders(<EffectiveHarnessPolicyCard />);

    await screen.findByText('Entity faithfulness threshold');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
