/**
 * Frame 13 — Entitlements & plans screen. fetch is stubbed at the network
 * boundary (the api layer has its own tests); assertions cover the list
 * states, the enforcement kill-switch confirm, the plan editor PATCH with
 * expectedVersion (+ 412 OCC alert), and the tenant override lifecycle.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { EntitlementCapabilities, PlanEntitlement, TenantEntitlement } from '../../api/types';
import { LIMIT_FIELDS } from '../plan-meta';
import { EntitlementsScreen } from '../entitlements-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function planEntitlement(overrides: Partial<PlanEntitlement> = {}): PlanEntitlement {
  return {
    id: 'pe-1',
    plan: 'STARTER',
    maxUsers: 5,
    maxDepartments: 2,
    maxPromptTemplates: 10,
    maxAsrPipelines: 1,
    maxApiKeys: 2,
    maxWorkflowDefinitions: 3,
    maxAiProviderConnections: 4,
    storageQuotaBytes: 107374182400,
    maxConcurrentSessions: 2,
    monthlyConsultations: 200,
    monthlyTranscriptionMinutes: 1200,
    monthlySummaries: 400,
    monthlyWorkflowInvocations: 500,
    monthlySttSessionSeconds: 36000,
    monthlyLlmTokens: 2000000,
    monthlyTtsCharacters: 150000,
    monthlyNlpTextUnits: 8000,
    monthlyEmbeddingTokens: 500000,
    modelTier: 'standard',
    rateLimitTier: 'basic',
    version: 3,
    ...overrides,
  };
}

const PLANS: PlanEntitlement[] = [
  planEntitlement(),
  planEntitlement({
    id: 'pe-2',
    plan: 'PRO',
    maxUsers: 50,
    monthlyTranscriptionMinutes: 12000,
    modelTier: 'advanced',
    rateLimitTier: 'elevated',
    version: 5,
  }),
  planEntitlement({
    id: 'pe-3',
    plan: 'ENTERPRISE',
    maxUsers: null,
    storageQuotaBytes: null,
    monthlyTranscriptionMinutes: null,
    modelTier: 'premium',
    rateLimitTier: 'unlimited',
    version: 2,
  }),
];

const CAPABILITIES: EntitlementCapabilities = {
  tenantId: 't-1',
  plan: 'PRO',
  gated: true,
  enforcementEnabled: true,
  quantities: [
    { key: 'maxUsers', limit: 50, used: 42, remaining: 8, unlimited: false, nearLimit: true, exceeded: false },
    { key: 'maxApiKeys', limit: 10, used: 12, remaining: 0, unlimited: false, nearLimit: false, exceeded: true },
  ],
  meters: [{ key: 'monthlyConsultations', limit: 2000, used: 150, remaining: 1850, unlimited: false, nearLimit: false, exceeded: false }],
  features: { platformDefaultCredential: false, paletteStt: true, agenticLoop: true },
  modelTier: 'advanced',
  rateLimitTier: 'elevated',
  rateLimitPerMinute: 120,
  trial: { isTrial: false, trialEndsAt: null, daysRemaining: null, expired: false },
};

const OVERRIDE: TenantEntitlement = {
  id: 'ovr-1',
  tenantId: 't-1',
  maxUsers: 60,
  maxDepartments: null,
  maxPromptTemplates: null,
  maxAsrPipelines: null,
  maxApiKeys: null,
  maxWorkflowDefinitions: null,
  maxAiProviderConnections: null,
  storageQuotaBytes: null,
  maxConcurrentSessions: null,
  monthlyConsultations: null,
  monthlyTranscriptionMinutes: null,
  monthlySummaries: null,
  monthlyWorkflowInvocations: null,
  monthlySttSessionSeconds: null,
  monthlyLlmTokens: null,
  monthlyTtsCharacters: null,
  monthlyNlpTextUnits: null,
  monthlyEmbeddingTokens: null,
  modelTier: null,
  rateLimitTier: null,
  rateLimitPerMinute: null,
  version: 4,
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

/** Read paths through the proxy that every test starts from. */
function defaultHandler(call: RecordedCall): Response | undefined {
  const path = new URL(call.url, 'http://test.local').pathname;
  if (call.method !== 'GET') return undefined;
  // Layout persistence reads GET users/me/settings on mount; tests have no saved layout.
  if (path.endsWith('/users/me/settings')) return Response.json([]);
  if (path === '/api/hope/admin/entitlements/enabled') return Response.json({ enabled: true });
  if (path === '/api/hope/admin/entitlements/plans') return Response.json(PLANS);
  if (path === '/api/hope/admin/entitlements/plans/PRO') return Response.json(PLANS[1]);
  if (path === '/api/hope/admin/entitlements/tenants/t-1') return Response.json(CAPABILITIES);
  if (path === '/api/hope/admin/entitlements/tenants/t-1/override') return Response.json(OVERRIDE);
  return undefined;
}

function stubEntitlements(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('EntitlementsScreen', () => {
  it('renders the enforcement toggle and plan rows with entitlement summaries', async () => {
    stubEntitlements();
    renderWithProviders(<EntitlementsScreen />);

    expect(await screen.findByText('Pro')).toBeDefined();
    expect(screen.getByText('Starter')).toBeDefined();
    expect(screen.getByText('Enterprise')).toBeDefined();
    expect(screen.getByText(/3 plans/)).toBeDefined();
    expect(screen.getByText(/5 users/)).toBeDefined();
    expect(screen.getAllByText(/100 GB storage/).length).toBeGreaterThan(0);
    expect(screen.getByText(/unlimited users/i)).toBeDefined();
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
  });

  it('shows no plan-feature column — TASK-883 left the plan row with no display flag', async () => {
    stubEntitlements();
    renderWithProviders(<EntitlementsScreen />);

    await screen.findByText('Enterprise');
    // The column rendered `featureDnaReports` / `featureVoiceEnrollment` /
    // `featureMonitoringAccess`; with those columns gone it could only ever
    // render an em dash, so the column went too rather than becoming a
    // permanently empty one.
    expect(screen.queryByText('DNA reports')).toBeNull();
    expect(screen.queryByText('Voice enrollment')).toBeNull();
    expect(screen.queryByText('Monitoring access')).toBeNull();
  });

  it('keeps the layout skeleton while the queries are in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<EntitlementsScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows the neutral empty state when no plans are defined yet', async () => {
    stubEntitlements((call) => {
      if (call.method === 'GET' && call.url.endsWith('/admin/entitlements/plans')) return Response.json([]);
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    expect(await screen.findByText(/no plan entitlements yet/i)).toBeDefined();
  });

  it('renders the block error state and retries the plans request', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'GET' && call.url.endsWith('/admin/entitlements/plans')) {
        return Response.json({ message: 'Service unavailable' }, { status: 503 });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(/service unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith('/admin/entitlements/plans')).length).toBe(2));
  });

  it('disabling enforcement asks for confirmation before PUTting the kill-switch', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'PUT' && call.url.endsWith('/admin/entitlements/enabled')) return Response.json({ enabled: false });
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /disable enforcement/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/admin/entitlements/enabled'));
      expect(put?.body).toEqual({ enabled: false });
    });
  });

  it('opens the plan editor on row click and PATCHes with the row expectedVersion', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO')) {
        return Response.json({ ...PLANS[1], maxUsers: 60, version: 6 });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByText('Pro'));
    const dialog = await screen.findByRole('dialog');

    const maxUsers = (await within(dialog).findByLabelText('Max users')) as HTMLInputElement;
    expect(maxUsers.value).toBe('50');
    fireEvent.change(maxUsers, { target: { value: '60' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO'));
      expect(patch?.body).toEqual(expect.objectContaining({ maxUsers: 60, expectedVersion: 5 }));
    });
  });

  it('edits the workflow and provider-connection ceilings alongside the older plan limits', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO')) {
        return Response.json({ ...PLANS[1], version: 6 });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByText('Pro'));
    const dialog = await screen.findByRole('dialog');

    const workflowDefinitions = (await within(dialog).findByLabelText('Max published workflow definitions')) as HTMLInputElement;
    const providerConnections = within(dialog).getByLabelText('Max AI provider connections') as HTMLInputElement;
    const workflowInvocations = within(dialog).getByLabelText('Monthly workflow invocations') as HTMLInputElement;
    expect([workflowDefinitions.value, providerConnections.value, workflowInvocations.value]).toEqual(['3', '4', '500']);

    fireEvent.change(workflowDefinitions, { target: { value: '12' } });
    fireEvent.change(providerConnections, { target: { value: '6' } });
    // Empty is the unlimited sentinel the other limits already use.
    fireEvent.change(workflowInvocations, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO'));
      expect(patch?.body).toEqual(
        expect.objectContaining({
          maxWorkflowDefinitions: 12,
          maxAiProviderConnections: 6,
          monthlyWorkflowInvocations: null,
          expectedVersion: 5,
        }),
      );
    });
  });

  it('edits the five monthly service allowances', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO')) {
        return Response.json({ ...PLANS[1], version: 6 });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByText('Pro'));
    const dialog = await screen.findByRole('dialog');

    const sttSeconds = (await within(dialog).findByLabelText('Monthly STT session seconds')) as HTMLInputElement;
    const llmTokens = within(dialog).getByLabelText('Monthly LLM tokens') as HTMLInputElement;
    const ttsCharacters = within(dialog).getByLabelText('Monthly TTS characters') as HTMLInputElement;
    const nlpTextUnits = within(dialog).getByLabelText('Monthly NLP text units') as HTMLInputElement;
    const embeddingTokens = within(dialog).getByLabelText('Monthly embedding tokens') as HTMLInputElement;
    expect([sttSeconds.value, llmTokens.value, ttsCharacters.value, nlpTextUnits.value, embeddingTokens.value]).toEqual([
      '36000',
      '2000000',
      '150000',
      '8000',
      '500000',
    ]);

    fireEvent.change(llmTokens, { target: { value: '9000000' } });
    // These are bigint columns on the gateway; the form still sends a number.
    fireEvent.change(sttSeconds, { target: { value: '72000' } });
    fireEvent.change(embeddingTokens, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO'));
      expect(patch?.body).toEqual(
        expect.objectContaining({
          monthlySttSessionSeconds: 72000,
          monthlyLlmTokens: 9000000,
          monthlyTtsCharacters: 150000,
          monthlyNlpTextUnits: 8000,
          monthlyEmbeddingTokens: null,
          expectedVersion: 5,
        }),
      );
    });
  });

  it('files each limit under its own section, as a labelled group', async () => {
    stubEntitlements();
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByText('Pro'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Max users');

    // <fieldset> is an ARIA group named by its <legend>, so the sections are
    // reachable by assistive tech rather than being visual headings only.
    const quantities = within(dialog).getByRole('group', { name: 'Quantity ceilings' });
    const meters = within(dialog).getByRole('group', { name: 'Monthly meters' });
    const tiers = within(dialog).getByRole('group', { name: 'Tiers' });

    expect(within(quantities).getByLabelText('Max users')).toBeDefined();
    expect(within(quantities).getByLabelText('Storage quota (bytes)')).toBeDefined();
    expect(within(meters).getByLabelText('Monthly LLM tokens')).toBeDefined();
    expect(within(tiers).getByLabelText('Model tier')).toBeDefined();
    // A meter must not also appear among the ceilings.
    expect(within(quantities).queryByLabelText('Monthly LLM tokens')).toBeNull();
  });

  it('surfaces the OCC conflict alert when the plan update returns 412', async () => {
    stubEntitlements((call) => {
      if (call.method === 'PATCH' && call.url.endsWith('/admin/entitlements/plans/PRO')) {
        return Response.json({ message: 'Precondition failed' }, { status: 412 });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByText('Pro'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Max users');
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/412 precondition failed/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /reload latest/i })).toBeDefined();
  });

  it('loads a tenant on the overrides tab and renders its effective capabilities', async () => {
    stubEntitlements();
    renderWithProviders(<EntitlementsScreen />, { searchParams: '?tab=overrides&tenant=t-1' });

    expect(await screen.findByText('maxUsers')).toBeDefined();
    expect(screen.getByText('42 / 50')).toBeDefined();
    expect(screen.getByText(/near limit/i)).toBeDefined();
    expect(screen.getByText(/exceeded/i)).toBeDefined();
    const editor = (await screen.findByLabelText(/override json/i)) as HTMLTextAreaElement;
    expect(editor.value).toContain('"maxUsers": 60');
  });

  // The two lists are maintained by hand and have drifted apart twice, so pin
  // the invariant rather than the individual keys: every limit the plan form
  // renders must also be settable per tenant.
  it('exposes every plan limit as a key of the override document', async () => {
    stubEntitlements();
    renderWithProviders(<EntitlementsScreen />, { searchParams: '?tab=overrides&tenant=t-1' });

    const editor = (await screen.findByLabelText(/override json/i)) as HTMLTextAreaElement;
    const parsed = JSON.parse(editor.value) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(LIMIT_FIELDS.map((field) => field.key)));
  });

  it('upserts the tenant override with the existing row version behind a confirm', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'PUT' && call.url.endsWith('/admin/entitlements/tenants/t-1/override')) {
        return Response.json({ ...OVERRIDE, maxUsers: 25, version: 5 });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />, { searchParams: '?tab=overrides&tenant=t-1' });

    const editor = await screen.findByLabelText(/override json/i);
    fireEvent.change(editor, { target: { value: '{"maxUsers": 25}' } });
    fireEvent.click(screen.getByRole('button', { name: /save override/i }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /apply override/i }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/admin/entitlements/tenants/t-1/override'));
      expect(put?.body).toEqual({ maxUsers: 25, expectedVersion: 4 });
    });
  });

  it('clears the tenant override behind a destructive confirm', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'DELETE' && call.url.endsWith('/admin/entitlements/tenants/t-1/override')) {
        return Response.json({ cleared: true });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />, { searchParams: '?tab=overrides&tenant=t-1' });

    fireEvent.click(await screen.findByRole('button', { name: /clear override/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /clear override/i }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/admin/entitlements/tenants/t-1/override'))).toBe(true),
    );
  });

  it('triggers a plan downgrade for the loaded tenant behind a confirm', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/entitlements/tenants/t-1/downgrade')) {
        return Response.json({
          tenantId: 't-1',
          fromPlan: 'PRO',
          toPlan: 'STARTER',
          enforcementEnabled: true,
          disabled: [],
          totalDisabled: 3,
        });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />, { searchParams: '?tab=overrides&tenant=t-1' });

    fireEvent.click(await screen.findByRole('button', { name: /trigger downgrade/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /trigger downgrade/i }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/admin/entitlements/tenants/t-1/downgrade'));
      expect(post?.body).toEqual({ plan: 'STARTER' });
    });
  });

  /*
   * Frame 13 had no axe scan of its own. One per rendered surface: the grid,
   * and the plan editor the three limit fields above landed in.
   */
  it('has no axe violations on the plans tab', async () => {
    stubEntitlements();
    const { container } = renderWithProviders(<EntitlementsScreen />);
    await screen.findByText('Pro');

    expect(await axe(container)).toHaveNoViolations();
  });

  // Scoped to the dialog, as every other open-overlay scan in this app is:
  // while a modal is open Radix marks the page behind it `aria-hidden` and
  // traps focus in JS, which axe reads statically as hidden-but-focusable.
  it('has no axe violations in the plan editor', async () => {
    stubEntitlements();
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByText('Pro'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Max AI provider connections');

    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('runs the trial-expiry sweep from the header behind a confirm', async () => {
    const calls = stubEntitlements((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/entitlements/trial-expiry/run')) {
        return Response.json({ examined: 5, downgraded: 2, tenantIds: ['t-8', 't-9'] });
      }
      return undefined;
    });
    renderWithProviders(<EntitlementsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: /run trial expiry/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /run trial expiry/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/admin/entitlements/trial-expiry/run'))).toBe(true));
  });
});
