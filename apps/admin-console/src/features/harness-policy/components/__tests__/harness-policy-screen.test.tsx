/**
 * TDD screen tests for frame 36 (Harness Policy & Live Config): effective
 * resolve + comparison grid render, the If-Match OCC save, elevated-only
 * Live config / Global default tabs, the NoTenant gate and the error state —
 * against a URL-branching fetch stub covering the BFF session route.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { HarnessPolicy } from '../../api/types';
import { HarnessPolicyScreen } from '../harness-policy-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function policy(overrides: Partial<HarnessPolicy> = {}): HarnessPolicy {
  return {
    id: 'hp-1',
    tenantId: 'tnt-1',
    source: 'tenant',
    entityFaithfulnessThreshold: 1,
    coverageThreshold: 0.8,
    citationPresenceThreshold: 1,
    numericDoseThreshold: 1,
    groundednessThreshold: 0.8,
    safetyEnabled: true,
    phiEnabled: true,
    phiFailClosed: true,
    textProvider: 'lm-studio',
    textModel: 'gemma-4-medical',
    maxRegen: 2,
    gateSlaSeconds: 86400,
    gateEscalationSeconds: 43200,
    toolAllowlist: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 7,
    ...overrides,
  };
}

const GLOBAL_POLICY = policy({ id: 'hp-sys', tenantId: '00000000-0000-0000-0000-000000000000', source: 'system-default', maxRegen: 1, version: 3 });

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  // WorkingTenantGate now reads the effective identity; this
  // fixture never impersonates, so it mirrors the operator fields.
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const TENANT_ADMIN_SESSION = {
  ...SESSION,
  user: { ...SESSION.user, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  effectiveUser: { ...SESSION.effectiveUser, username: 'tenant_admin', roles: ['TENANT_ADMIN'] },
  effectiveIsElevated: false,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface StubOptions {
  session?: typeof SESSION;
  tenantPolicy?: HarnessPolicy;
  custom?: (call: RecordedCall) => Response | undefined;
}

function stubFetch({ session = SESSION, tenantPolicy = policy(), custom }: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.url === '/api/auth/session') return Response.json(session);
      if (call.method === 'GET' && call.url === '/api/hope/admin/harness/policy') {
        return Response.json(tenantPolicy, { headers: tenantPolicy.version > 0 ? { etag: `"${tenantPolicy.version}"` } : {} });
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/harness/policy/global') {
        return Response.json(GLOBAL_POLICY, { headers: { etag: `"${GLOBAL_POLICY.version}"` } });
      }
      if (call.method === 'GET' && call.url === '/api/hope/admin/harness/live/config') {
        return Response.json({ enabled: true, envDefault: true, source: 'env-default' });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HarnessPolicyScreen', () => {
  it('renders the resolve card, the tenant-vs-global grid and the save panel from the stub', async () => {
    stubFetch();
    renderWithProviders(<HarnessPolicyScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Harness Policy & Live Config' })).toBeDefined();
    expect(await screen.findByText('Effective policy resolve')).toBeDefined();
    expect(screen.getByText('tenant row')).toBeDefined();
    // Comparison grid: tenant 2 vs global default 1 for maxRegen.
    expect(screen.getByRole('table', { name: 'Tenant vs global default settings' })).toBeDefined();
    expect(await screen.findByText('maxRegen')).toBeDefined();
    // The OCC save panel renders with the WORM change-note input.
    expect(screen.getByLabelText('Max regen budget')).toBeDefined();
    expect(screen.getByLabelText('Reason')).toBeDefined();
    expect(screen.getByRole('button', { name: /Save · If-Match/ })).toBeDefined();
  });

  it('saves a sparse patch with If-Match and expectedVersion from the read ETag', async () => {
    const calls = stubFetch({
      custom: (call) => {
        if (call.method === 'PATCH' && call.url === '/api/hope/admin/harness/policy') {
          return Response.json(policy({ maxRegen: 3, version: 8 }), { headers: { etag: '"8"' } });
        }
        return undefined;
      },
    });
    renderWithProviders(<HarnessPolicyScreen />);
    const maxRegen = await screen.findByLabelText('Max regen budget');

    fireEvent.change(maxRegen, { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'raise regen budget' } });
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toBe('/api/hope/admin/harness/policy');
    expect(patch?.headers.get('if-match')).toBe('"7"');
    expect(patch?.body).toEqual({ maxRegen: 3, reason: 'raise regen budget', expectedVersion: 7 });
  });

  it('shows the OCC conflict alert with reload-merge when the PATCH returns 412', async () => {
    stubFetch({
      custom: (call) => {
        if (call.method === 'PATCH') return Response.json({ message: 'Precondition Failed' }, { status: 412 });
        return undefined;
      },
    });
    renderWithProviders(<HarnessPolicyScreen />);

    fireEvent.change(await screen.findByLabelText('Max regen budget'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save · If-Match/ }));

    expect(await screen.findByText(/412 Precondition Failed/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload latest' })).toBeDefined();
    // Local edits are kept for the reload-merge.
    expect((screen.getByLabelText('Max regen budget') as HTMLInputElement).value).toBe('5');
  });

  it('shows the inherited empty state with the customize CTA when no tenant row exists', async () => {
    stubFetch({ tenantPolicy: policy({ id: null, source: 'system-default', version: 3 }) });
    renderWithProviders(<HarnessPolicyScreen />);

    expect(await screen.findByText('No tenant override yet')).toBeDefined();
    expect(screen.queryByLabelText('Max regen budget')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Customize for tenant' }));
    expect(await screen.findByLabelText('Max regen budget')).toBeDefined();
  });

  it('hides the Live config and Global default tabs from a non-elevated session', async () => {
    stubFetch({ session: TENANT_ADMIN_SESSION });
    renderWithProviders(<HarnessPolicyScreen />);

    expect(await screen.findByRole('tab', { name: 'Tenant policy' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Global default' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Live config' })).toBeNull();
    // Tenant admins also never fetch the platform-asserted global read.
    await screen.findByText('Effective policy resolve');
    expect(screen.getByText(/visible to super admins only/)).toBeDefined();
  });

  // The elevated tabs still MOUNT for an elevated session —
  // they just read now instead of editing (the editor moved to
  // /agentic-policy). The kill-switch STATE is still surfaced here.
  it('shows the elevated tabs and reports the live-engine state read-only', async () => {
    stubFetch();
    renderWithProviders(<HarnessPolicyScreen />, { searchParams: '?tab=live' });

    expect(await screen.findByText('Live documentation engine')).toBeDefined();
    expect(screen.getByText('Engine enabled')).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Global default' })).toBeDefined();
  });

  it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
    stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
    renderWithProviders(<HarnessPolicyScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Harness Policy & Live Config' })).toBeDefined();
    expect(screen.queryByText('Effective policy resolve')).toBeNull();
  });

  it('surfaces a block error with retry when the policy read fails', async () => {
    let attempts = 0;
    stubFetch({
      custom: (call) => {
        if (call.method === 'GET' && call.url === '/api/hope/admin/harness/policy') {
          attempts += 1;
          if (attempts === 1) return Response.json({ message: 'harness unavailable' }, { status: 503 });
        }
        return undefined;
      },
    });
    renderWithProviders(<HarnessPolicyScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('harness unavailable')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Effective policy resolve')).toBeDefined();
  });

  /**
   * `/agentic-policy` (tier 10-19) is now the ONE
   * authoritative editor for the SYSTEM global-default row and the live engine
   * config. Both screens used to edit the same two backend rows. Here those
   * tabs demote to read-only summaries with a deep link, so there is no second
   * form that can race the first.
   */
  describe('M-02 demoted Global default / Live config tabs', () => {
    it('renders the global default as a read-only summary with no save form', async () => {
      stubFetch();
      renderWithProviders(<HarnessPolicyScreen />, { searchParams: '?tab=global' });

      await screen.findByRole('heading', { name: /global default/i });
      expect(screen.queryByRole('form', { name: 'Policy save panel' })).toBeNull();
      expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    });

    it('deep-links the global default tab to the agentic-policy editor', async () => {
      stubFetch();
      renderWithProviders(<HarnessPolicyScreen />, { searchParams: '?tab=global' });

      const link = await screen.findByRole('link', { name: /edit in agentic policy/i });
      expect(link.getAttribute('href')).toBe('/agentic-policy?tab=policy');
    });

    it('renders the live config as a read-only summary deep-linking to the engine tab', async () => {
      stubFetch();
      renderWithProviders(<HarnessPolicyScreen />, { searchParams: '?tab=live' });

      const link = await screen.findByRole('link', { name: /edit in agentic policy/i });
      expect(link.getAttribute('href')).toBe('/agentic-policy?tab=engine');
      expect(screen.queryByRole('switch')).toBeNull();
    });
  });

  /**
   * The three safety/PHI switches became
   * super-admin-only server-side. The TENANT tab must render them disabled
   * with a visible reason rather than letting a tenant admin flip a switch
   * that 403s on save (rule 11 §5: a disabled control needs a visible reason).
 */
  describe('E3-L1 locked safety/PHI switches', () => {
    // Every key the TENANT route rejects must render read-only.
    // Mirrors TENANT_LOCKED_POLICY_KEYS in ../policy-fields.ts, by rendered
    // label. `Safety provider`/`Safety model` and (TASK-881) `Text-generation
    // provider`/`Text-generation model` are absent because their controls were
    // deleted with their columns — see ../policy-fields.ts and policy-fields.test.ts.
    const LOCKED = ['Safety guardrail', 'PHI detection', 'PHI fail-closed'];

    it.each(LOCKED)('renders %s disabled on the tenant tab', async (label) => {
      stubFetch({ session: TENANT_ADMIN_SESSION });
      renderWithProviders(<HarnessPolicyScreen />);

      const control = (await screen.findByLabelText(label)) as HTMLInputElement;
      // Primitive-agnostic: the Radix Switch exposes `data-disabled`,
      // while a native <input> exposes the `disabled` property. The
      // assertion is "not editable", not "built from one primitive".
      const isDisabled = control.disabled === true || control.getAttribute('data-disabled') !== null;
      expect(isDisabled, `${label} should be read-only for a tenant admin`).toBe(true);
    });

    it('explains why the locked switches cannot be edited', async () => {
      stubFetch({ session: TENANT_ADMIN_SESSION });
      renderWithProviders(<HarnessPolicyScreen />);

      await screen.findByLabelText('Safety guardrail');
      // One hint per locked field, with the exact copy the form renders.
      expect(screen.getAllByText('Super Admins only')).toHaveLength(LOCKED.length);
    });

    it('leaves the tenant-writable clinical thresholds editable', async () => {
      stubFetch({ session: TENANT_ADMIN_SESSION });
      renderWithProviders(<HarnessPolicyScreen />);

      const coverage = await screen.findByLabelText('Coverage');
      expect((coverage as HTMLInputElement).disabled).toBe(false);
    });
  });
});
