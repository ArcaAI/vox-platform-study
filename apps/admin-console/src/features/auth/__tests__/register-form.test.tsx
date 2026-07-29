import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegisterForm } from '../components/register-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillAndSubmit(email: string, password: string, tenantName: string, displayName?: string) {
  fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/tenant name/i), { target: { value: tenantName } });
  if (displayName !== undefined) {
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: displayName } });
  }
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
}

describe('RegisterForm', () => {
  it('renders email, password, tenant name and optional display name fields', () => {
    render(<RegisterForm />);
    expect(screen.getByLabelText(/^email/i)).toBeDefined();
    expect(screen.getByLabelText(/^password/i)).toBeDefined();
    expect(screen.getByLabelText(/tenant name/i)).toBeDefined();
    expect(screen.getByLabelText(/display name/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /create account/i })).toBeDefined();
  });

  it('submits to the BFF register route and shows the check-your-email confirmation', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<RegisterForm />);
    fillAndSubmit('doc@example.com', 'S3cret!Pass', 'Acme Health', 'Dr. Doc');

    expect(await screen.findByText(/check your email/i)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/register');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'doc@example.com',
      password: 'S3cret!Pass',
      tenantName: 'Acme Health',
      displayName: 'Dr. Doc',
    });
  });

  it('omits displayName from the payload when left blank', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<RegisterForm />);
    fillAndSubmit('doc@example.com', 'S3cret!Pass', 'Acme Health');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ email: 'doc@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' });
  });

  it('shows the SAME confirmation even when the BFF errors (anti-enumeration: never reveal account existence)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'boom' }, { status: 500 })),
    );

    render(<RegisterForm />);
    fillAndSubmit('doc@example.com', 'S3cret!Pass', 'Acme Health');

    expect(await screen.findByText(/check your email/i)).toBeDefined();
  });

  it('surfaces a 404 (registration disabled) distinctly instead of the generic confirmation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'Not found' }, { status: 404 })),
    );

    render(<RegisterForm />);
    fillAndSubmit('doc@example.com', 'S3cret!Pass', 'Acme Health');

    expect(await screen.findByText(/registration is not currently available/i)).toBeDefined();
  });
});
