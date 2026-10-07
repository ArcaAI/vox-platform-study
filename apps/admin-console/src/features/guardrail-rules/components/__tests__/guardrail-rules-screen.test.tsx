/** TASK-1050 W3a — tenant guardrail rules screen. */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { GuardrailCheckState, TenantGuardrailPolicy } from '../../api/types';
import { GuardrailRulesScreen } from '../guardrail-rules-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TENANT = 't-1';

function check(overrides: Partial<GuardrailCheckState> & { checkId: string }): GuardrailCheckState {
  return {
    label: overrides.checkId,
    description: `${overrides.checkId} description`,
    directions: ['inbound'],
    enabled: true,
    action: 'warn',
    allowedActions: ['ignore', 'warn', 'block'],
    locked: false,
    lockReason: null,
    editable: true,
    inherited: false,
    setBy: 'tenant_admin',
    ...overrides,
  };
}

function policy(overrides: Partial<TenantGuardrailPolicy> = {}): TenantGuardrailPolicy {
  return {
    tenantId: TENANT,
    version: 3,
    directions: { inbound: { enabled: true }, outbound: { enabled: false } },
    checks: [
      check({ checkId: 'prompt_safety', label: 'Prompt safety', directions: ['inbound'], action: 'block', inherited: true }),
      check({ checkId: 'pii_leak', label: 'PHI leakage', directions: ['outbound'], enabled: false }),
      check({
        checkId: 'medical_validation',
        label: 'Medical validation',
        directions: ['outbound'],
        locked: true,
        lockReason: 'catalogue',
        editable: false,
      }),
      check({ checkId: 'toxicity', label: 'Toxicity', directions: ['inbound', 'outbound'], locked: true, lockReason: 'platform', editable: false }),
    ],
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(put?: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/auth/session')) {
        return Response.json({
          user: { id: 'u-1', username: 'a', email: 'a@x', roles: ['TENANT_ADMIN'], tenantId: TENANT },
          isElevated: false,
          workingTenantId: null,
          workingTenantName: null,
          impersonatingUserId: null,
          impersonatingUsername: null,
          effectiveUser: { id: 'u-1', username: 'a', email: 'a@x', roles: ['TENANT_ADMIN'], tenantId: TENANT, departmentId: null },
          effectiveIsElevated: false,
          effectiveTenantId: TENANT,
        });
      }
      calls.push({
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      if (method === 'PUT') return put ? put() : Response.json({ ...policy(), version: 4 });
      return Response.json(policy());
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function loaded() {
  await waitFor(() => expect(screen.getByRole('switch', { name: /Prompt safety/ })).toBeDefined());
}

const puts = (calls: Call[]) => calls.filter((call) => call.method === 'PUT');

describe('GuardrailRulesScreen', () => {
  it('renders directions, counts and checks from the GET', async () => {
    stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();

    expect(screen.getByText('Inbound')).toBeDefined();
    expect(screen.getByText('Outbound')).toBeDefined();
    // inbound: prompt_safety + toxicity; outbound: medical + toxicity (pii_leak is off)
    expect(screen.getAllByText('2 active checks')).toHaveLength(2);
    expect(screen.getByText('Inherited')).toBeDefined();
    expect(screen.getByRole('switch', { name: /PHI leakage/ }).getAttribute('data-state')).toBe('unchecked');
  });

  it('labels a switched-off direction "Off (monitor only)"', async () => {
    stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();
    expect(screen.getAllByText('Off (monitor only)')).toHaveLength(1);
  });

  it('sends only the changed enabled flags with If-Match', async () => {
    const calls = stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: /PHI leakage/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]!.body).toEqual({ checks: { pii_leak: { enabled: true } } });
    expect(puts(calls)[0]!.headers['if-match']).toBe('"3"');
    await waitFor(() => expect(screen.getByText('Changes apply immediately.')).toBeDefined());
  });

  it('sends a direction toggle as a directions entry', async () => {
    const calls = stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();

    fireEvent.click(screen.getByRole('switch', { name: 'Outbound' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]!.body).toEqual({ directions: { outbound: { enabled: true } } });
  });

  it('keeps Save disabled until something changed, and toggling back clears the change', async () => {
    stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();
    const save = screen.getByRole('button', { name: 'Save rules' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: /PHI leakage/ }));
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: /PHI leakage/ }));
    expect(save.disabled).toBe(true);
  });

  it('disables a locked row with its visible reason', async () => {
    stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();

    const catalogue = screen.getByRole('switch', { name: /Medical validation/ }) as HTMLButtonElement;
    expect(catalogue.disabled).toBe(true);
    expect(document.getElementById(catalogue.getAttribute('aria-describedby')!)?.textContent).toBe('Required by the platform');

    const platform = screen.getByRole('switch', { name: /Toxicity/ }) as HTMLButtonElement;
    expect(platform.disabled).toBe(true);
    expect(document.getElementById(platform.getAttribute('aria-describedby')!)?.textContent).toBe('Locked by your platform administrator');
  });

  it('shows the platform action as a read-only badge, never a control', async () => {
    stubFetch();
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();

    expect(screen.getByText('Platform action: Block')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('toasts on 412', async () => {
    stubFetch(() => Response.json({ statusCode: 412, message: 'Version mismatch' }, { status: 412 }));
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();
    fireEvent.click(screen.getByRole('switch', { name: /PHI leakage/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Changed by someone else — reload'));
  });

  it('shows the OD-8 refusal inline on 400', async () => {
    stubFetch(() => Response.json({ statusCode: 400, message: 'Inbound screening needs at least one enabled check' }, { status: 400 }));
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();
    fireEvent.click(screen.getByRole('switch', { name: /Prompt safety/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least one enabled check/));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts the refused fields on 403', async () => {
    stubFetch(() =>
      Response.json({ statusCode: 403, message: 'Platform-only field', code: 'GUARDRAIL_FIELD_PLATFORM_ONLY', fields: ['checks.pii_leak.action'] }, { status: 403 }),
    );
    renderWithProviders(<GuardrailRulesScreen />);
    await loaded();
    fireEvent.click(screen.getByRole('switch', { name: /PHI leakage/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0]![0]).toContain('checks.pii_leak.action');
  });
});
