/**
 * TASK-886 — the guardrail-availability tab.
 *
 * The behaviour that carries risk here is the pair of REFUSALS. The gateway
 * enforces both (403 tighten-only, 400 both-directions), and the client mirrors
 * them so an admin is told before the round-trip — but a mirror that disagrees
 * with the server is worse than none, so these tests pin the mirror's shape, not
 * a convenience.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { GuardrailAvailability, GuardrailPolicyCatalogueEntry } from '../../api/types';
import { GuardrailAvailabilityTab } from '../guardrail-availability-tab';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = 't-1';

const CATALOGUE: GuardrailPolicyCatalogueEntry[] = [
  {
    id: 'jailbreak_detection',
    label: 'Jailbreak / prompt injection',
    description: 'Both directions.',
    directions: ['inbound', 'outbound'],
    threshold: null,
  },
  { id: 'prompt_safety', label: 'Prompt safety', description: 'Inbound only.', directions: ['inbound'], threshold: null },
  {
    id: 'pii_leak',
    label: 'PHI / PII leakage',
    description: 'Outbound only.',
    directions: ['outbound'],
    threshold: { field: 'minScore', floorDirection: 'lower-is-stricter', minimum: 0, maximum: 1 },
  },
];

function availability(overrides: Partial<GuardrailAvailability> = {}): GuardrailAvailability {
  return {
    tenantId: TENANT,
    version: 0,
    policies: {},
    effective: {
      jailbreak_detection: { enabled: true },
      prompt_safety: { enabled: true },
      pii_leak: { enabled: true, minScore: 0.5 },
    },
    effectiveSourceTenantId: SYSTEM,
    reason: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(row = availability()): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, headers });
      if (url.includes('/api/auth/session')) {
        return Response.json({
          user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'], tenantId: null },
          isElevated: true,
          workingTenantId: TENANT,
          workingTenantName: 'Sunrise',
          impersonatingUserId: null,
          impersonatingUsername: null,
          effectiveUser: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
          effectiveIsElevated: true,
          effectiveTenantId: TENANT,
        });
      }
      if (url.includes('/catalogue')) return Response.json(CATALOGUE);
      if (method === 'PUT') return Response.json({ ...row, version: row.version + 1 });
      return Response.json(row);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GuardrailAvailabilityTab', () => {
  it('seeds from the EFFECTIVE set and says which tier supplied it', async () => {
    stubFetch();
    renderWithProviders(<GuardrailAvailabilityTab />);

    // A tenant with no row must not render as "nothing is screened" — it renders
    // what actually applies to it.
    await waitFor(() => expect(screen.getByText('Inheriting the platform default set')).toBeDefined());
    expect(screen.getByRole('switch', { name: /Jailbreak/ }).getAttribute('data-state')).toBe('checked');
    expect((screen.getByLabelText('minScore') as HTMLInputElement).value).toBe('0.5');
  });

  it('surfaces the tighten-only rule as a disabled Save with a visible reason', async () => {
    stubFetch();
    renderWithProviders(<GuardrailAvailabilityTab />);
    await waitFor(() => expect(screen.getByLabelText('minScore')).toBeDefined());

    // 0.9 > the 0.5 platform floor, and lower is stricter — a loosening write.
    fireEvent.change(screen.getByLabelText('minScore'), { target: { value: '0.9' } });

    const save = screen.getByRole('button', { name: 'Save availability' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // The reason is programmatically associated, not merely adjacent (rule 11 §5),
    // so it is read off the association rather than by scanning the page.
    const describedBy = save.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/may only be tightened/);
  });

  it('accepts a TIGHTER threshold', async () => {
    const calls = stubFetch();
    renderWithProviders(<GuardrailAvailabilityTab />);
    await waitFor(() => expect(screen.getByLabelText('minScore')).toBeDefined());

    fireEvent.change(screen.getByLabelText('minScore'), { target: { value: '0.2' } });
    const save = screen.getByRole('button', { name: 'Save availability' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    const write = calls.find((call) => call.method === 'PUT')!;
    // The If-Match token carries the version the client read; `"0"` creates.
    expect(write.headers['if-match']).toBe('"0"');
    expect((write.body as { policies: Record<string, { minScore?: number }> }).policies.pii_leak?.minScore).toBe(0.2);
  });

  it('refuses a selection that would leave a screening direction ungated', async () => {
    stubFetch();
    renderWithProviders(<GuardrailAvailabilityTab />);
    await waitFor(() => expect(screen.getByRole('switch', { name: /Jailbreak/ })).toBeDefined());

    // Turn off everything that runs outbound: the response side would be ungated.
    fireEvent.click(screen.getByRole('switch', { name: /Jailbreak/ }));
    fireEvent.click(screen.getByRole('switch', { name: /PHI/ }));

    const save = screen.getByRole('button', { name: 'Save availability' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(document.getElementById(save.getAttribute('aria-describedby')!)?.textContent).toMatch(/outbound screening would have no check/);
  });

  it('allows narrowing to the single both-directions policy', async () => {
    stubFetch();
    renderWithProviders(<GuardrailAvailabilityTab />);
    await waitFor(() => expect(screen.getByRole('switch', { name: /Prompt safety/ })).toBeDefined());

    fireEvent.click(screen.getByRole('switch', { name: /Prompt safety/ }));
    fireEvent.click(screen.getByRole('switch', { name: /PHI/ }));

    expect((screen.getByRole('button', { name: 'Save availability' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<GuardrailAvailabilityTab />);
    await waitFor(() => expect(screen.getByLabelText('minScore')).toBeDefined());
    expect(await axe(container)).toHaveNoViolations();
  });
});
