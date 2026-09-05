/**
 * Screen tests for the credential-policy surface.
 *
 * The behaviour that carries risk here is the PARTIAL write: the gateway writes
 * one GlobalSetting row per supplied field, so sending an unchanged field bumps
 * a row's version and emits a sys-event for a non-change. Most of what follows
 * pins that, plus the two failure directions (server clamp wins, failed write
 * re-seeds from truth).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { SecurityPolicy } from '../../api/types';
import { SecurityPolicyScreen } from '../security-policy-screen';

const POLICY: SecurityPolicy = {
  password: {
    minLength: 12,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSpecial: true,
    maxAgeDays: 0,
  },
  secret: { byteLength: 32, encoding: 'hex' },
  bounds: {
    minByteLength: 16,
    maxByteLength: 64,
    pinnedEncodings: { apiKey: 'hex', storageAccessKey: 'base64url' },
    governedSurfaces: ['serviceAccountClientSecret', 'apiKey', 'webhookSigningSecret', 'storageAccessKey'],
  },
};

interface RecordedCall {
  method: string;
  body: unknown;
}

function stubFetch(handler: (method: string, body: unknown) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, body });
      return handler(method, body);
    }),
  );
  return calls;
}

const writes = (calls: RecordedCall[]) => calls.filter((call) => call.method === 'PUT');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SecurityPolicyScreen', () => {
  it('renders the effective policy in both cards', async () => {
    stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    // TASK-886 — the screen now hosts two platform-security surfaces, so the h1
    // names the screen and the tabs name the surfaces. The credential tab is the
    // default, so everything below it is unchanged.
    expect(screen.getByRole('heading', { level: 1, name: 'Security policy' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Credential policy' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Guardrail availability' })).toBeDefined();
    expect(((await screen.findByLabelText('Minimum length')) as HTMLInputElement).value).toBe('12');
    expect((screen.getByLabelText('Rotation window (days)') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Entropy (bytes)') as HTMLInputElement).value).toBe('32');
    expect(screen.getByRole('switch', { name: 'Special character' }).getAttribute('data-state')).toBe('checked');
  });

  it('mirrors the loaded layout with skeletons while the policy is in flight', () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const { container } = renderWithProviders(<SecurityPolicyScreen />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('publishes the entropy bounds and the governed surfaces from the server, not from constants', async () => {
    stubFetch(() => Response.json({ ...POLICY, bounds: { ...POLICY.bounds, minByteLength: 24, maxByteLength: 48 } }));
    renderWithProviders(<SecurityPolicyScreen />);

    const entropy = (await screen.findByLabelText('Entropy (bytes)')) as HTMLInputElement;
    expect(entropy.min).toBe('24');
    expect(entropy.max).toBe('48');
    expect(screen.getByText('webhookSigningSecret')).toBeDefined();
  });

  it('names the surfaces whose alphabet is pinned, so the ignored setting is never a surprise', async () => {
    stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);
    expect(await screen.findByText(/apiKey is always hex/)).toBeDefined();
    expect(screen.getByText(/storageAccessKey is always base64url/)).toBeDefined();
  });

  it('keeps Save disabled until something actually changes', async () => {
    stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    const input = await screen.findByLabelText('Minimum length');
    const save = screen.getByRole('button', { name: 'Save policy' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '14' } });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  });

  it('sends ONLY the changed fields', async () => {
    const calls = stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    fireEvent.change(await screen.findByLabelText('Minimum length'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Digit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({ passwordMinLength: 16, passwordRequireDigit: false });
  });

  it('sends nothing for a field edited back to its saved value', async () => {
    const calls = stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    const input = await screen.findByLabelText('Minimum length');
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.change(input, { target: { value: '12' } });

    expect((screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes(calls)).toHaveLength(0);
  });

  it('discards changes back to the saved policy without writing', async () => {
    const calls = stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    const input = (await screen.findByLabelText('Minimum length')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect(input.value).toBe('12'));
    expect(writes(calls)).toHaveLength(0);
  });

  it('adopts the SERVER answer after a save — the platform, not the form, has the last word', async () => {
    // The operator asks for 33 bytes; the server answers with what it stored.
    stubFetch((method) => Response.json(method === 'PUT' ? { ...POLICY, secret: { ...POLICY.secret, byteLength: 40 } } : POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    const entropy = (await screen.findByLabelText('Entropy (bytes)')) as HTMLInputElement;
    fireEvent.change(entropy, { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(entropy.value).toBe('40'));
    expect((screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks an out-of-bounds entropy at the field, before any request is made', async () => {
    const calls = stubFetch(() => Response.json(POLICY));
    renderWithProviders(<SecurityPolicyScreen />);

    // Below the platform floor the server would clamp anyway — the field refuses
    // first, so the operator is corrected instead of silently overruled.
    const entropy = (await screen.findByLabelText('Entropy (bytes)')) as HTMLInputElement;
    fireEvent.change(entropy, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(entropy.checkValidity()).toBe(false));
    expect(writes(calls)).toHaveLength(0);
  });

  it('re-seeds from the server after a FAILED write — the PUT is not transactional', async () => {
    let refetched = false;
    stubFetch((method) => {
      if (method === 'PUT') return new Response(JSON.stringify({ message: 'nope' }), { status: 403 });
      // The refetch the failure triggers answers with a partially-applied policy.
      if (refetched) return Response.json({ ...POLICY, password: { ...POLICY.password, minLength: 14 } });
      refetched = true;
      return Response.json(POLICY);
    });
    renderWithProviders(<SecurityPolicyScreen />);

    const input = (await screen.findByLabelText('Minimum length')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(input.value).toBe('14'));
  });

  it('surfaces a load failure with a retry instead of an empty form', async () => {
    stubFetch(() => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
    renderWithProviders(<SecurityPolicyScreen />);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch(() => Response.json(POLICY));
    const { container } = renderWithProviders(<SecurityPolicyScreen />);
    await screen.findByLabelText('Minimum length');

    expect(await axe(container)).toHaveNoViolations();
  });
});
