/**
 * TASK-958 D-10 — a tenant holds SEVERAL accounts of one vendor.
 *
 * The tenant tier of `/ai-providers` stops being one card per provider and
 * becomes one card GROUP per provider: the default connection, its siblings,
 * and a button that creates another. What these cases pin is the DECISION, not
 * the markup:
 *
 *   (33) two cards under the OpenAI group, the default one badged — a tenant
 *        can see WHICH key is the one a SYSTEM-catalogue model spends;
 *   (34) the add dialog refuses a slug the gateway would refuse (the pattern is
 *        `^[a-z0-9][a-z0-9-]{1,62}$`, and slug is IMMUTABLE after create, so a
 *        client-side refusal is the last cheap place to catch a typo), and the
 *        create PUT names the `provider` explicitly — a slug that is not itself
 *        a provider id carries no provider for the gateway to infer (D-2);
 *   (38) 0 axe violations with the groups rendered AND the dialog open.
 *
 * The gateway half (Lanes A/B1) is not merged: these run against the §4.1
 * interface contract with stubbed responses, which is exactly what the contract
 * is for.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ProviderCredentialsTab } from '../provider-credentials-tab';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const TENANT = 'tnt-1';

/** One `AiProviderConnectionResponse`, in the §4.1 shape (id/slug/name/isDefault). */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'conn-default',
    tenantId: TENANT,
    service: 'llm',
    provider: 'openai',
    slug: 'openai',
    name: null,
    isDefault: true,
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    hasKey: false,
    keyVersion: null,
    enabled: false,
    extraJson: null,
    maxConcurrent: null,
    rpmLimit: null,
    tpmLimit: null,
    timeoutS: null,
    version: 0,
    ...over,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

/**
 * `GET :service` is the tenant's whole connection list; `GET :service/:slug` is
 * one row (a `version: 0` placeholder where none is stored). Everything else on
 * the tab (the platform-defaults panel) answers empty so the cases read as the
 * one behaviour each pins.
 */
function stubFetch(rows: Record<string, Record<string, unknown>> = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const raw = String(input);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url: raw, method, body });

      const url = new URL(raw, 'http://test.local');
      const segments = url.pathname.replace('/api/hope/admin/providers/', '').split('/');
      const [service, slug] = segments;

      if (slug === 'platform-defaults') return Response.json({ service, tenantId: TENANT, entitled: true, connections: [] });
      if (slug === undefined) return Response.json(Object.values(rows));
      if (method === 'PUT') {
        const created = row({ ...(rows[slug] ?? {}), ...body, id: `conn-${slug}`, slug, version: 1 });
        return Response.json(created, { headers: { etag: '"1"' } });
      }
      const stored = rows[slug];
      return Response.json(row({ service, provider: slug, slug, ...stored }), { headers: { etag: stored ? `"${stored.version ?? 1}"` : '"0"' } });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('ProviderCredentialsTab — one card GROUP per provider (33)', () => {
  it('renders the default connection and its sibling under the OpenAI group, with the default badged', async () => {
    stubFetch({
      openai: { id: 'conn-1', provider: 'openai', slug: 'openai', name: 'Production account', isDefault: true, hasKey: true, enabled: true, version: 3 },
      'openai-research': {
        id: 'conn-2',
        provider: 'openai',
        slug: 'openai-research',
        name: 'Research account',
        isDefault: false,
        hasKey: true,
        enabled: true,
        version: 2,
      },
    });
    renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);

    const group = await screen.findByRole('group', { name: 'OpenAI connections' });
    // Both cards read their own row, so the group is on screen before either has
    // a title — wait for the pair rather than for the first one to land.
    await waitFor(() => expect(within(group).getAllByRole('heading', { level: 3 })).toHaveLength(2));
    const headings = within(group).getAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(['OpenAI', 'OpenAI · Research account']);

    // The badge sits on the DEFAULT card, and only there — that is the row a
    // SYSTEM-catalogue model resolves through (D-3).
    const cards = headings.map((heading) => heading.closest('[aria-labelledby]') as HTMLElement);
    expect(within(cards[0]!).getByText('Default')).toBeDefined();
    expect(within(cards[1]!).queryByText('Default')).toBeNull();
    // The sibling offers the flip; the default does not (it already is).
    expect(within(cards[1]!).getByRole('button', { name: /Make .* the default OpenAI connection/ })).toBeDefined();
    expect(within(cards[0]!).queryByRole('button', { name: /Make .* the default/ })).toBeNull();
  });

  it('leaves a provider with no sibling exactly as it was — one card, no Default badge', async () => {
    stubFetch({ azure: { id: 'conn-3', provider: 'azure', slug: 'azure', isDefault: true, hasKey: true, enabled: true, version: 2 } });
    renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);

    const group = await screen.findByRole('group', { name: 'Azure OpenAI connections' });
    await waitFor(() => expect(within(group).getAllByRole('heading', { level: 3 })).toHaveLength(1));
    expect(within(group).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Azure OpenAI']);
    expect(within(group).queryByText('Default')).toBeNull();
  });
});

describe('ProviderCredentialsTab — the add-connection dialog (34)', () => {
  async function openDialog() {
    const calls = stubFetch({ openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 } });
    renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);
    const group = await screen.findByRole('group', { name: 'OpenAI connections' });
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Add another OpenAI connection' }));
    });
    return { calls, dialog: await screen.findByRole('dialog') };
  }

  it('refuses a slug the gateway would refuse, and sends nothing', async () => {
    const { calls, dialog } = await openDialog();

    fireEvent.change(within(dialog).getByLabelText(/Connection id/), { target: { value: 'Bad Slug!' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create connection' }));
    });

    expect(within(dialog).getByRole('alert').textContent).toMatch(/lowercase/i);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('accepts a valid slug and PUTs it at its own path, naming the provider', async () => {
    const { calls, dialog } = await openDialog();

    fireEvent.change(within(dialog).getByLabelText(/Connection id/), { target: { value: 'openai-research' } });
    fireEvent.change(within(dialog).getByLabelText(/Display name/), { target: { value: 'Research account' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create connection' }));
    });

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(new URL(put.url, 'http://test.local').pathname).toBe('/api/hope/admin/providers/llm/openai-research');
    expect(put.body).toMatchObject({ provider: 'openai', name: 'Research account', enabled: false, expectedVersion: 0 });
  });

  it('refuses a slug the group already holds rather than PUT-ing over it', async () => {
    const { calls, dialog } = await openDialog();

    fireEvent.change(within(dialog).getByLabelText(/Connection id/), { target: { value: 'openai' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create connection' }));
    });

    expect(within(dialog).getByRole('alert').textContent).toMatch(/already/i);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('ProviderCredentialsTab — accessibility (38)', () => {
  it('has no axe violations with the card groups rendered', async () => {
    stubFetch({
      openai: { id: 'conn-1', provider: 'openai', slug: 'openai', name: 'Production account', isDefault: true, hasKey: true, enabled: true, version: 3 },
      'openai-research': { id: 'conn-2', provider: 'openai', slug: 'openai-research', name: 'Research account', isDefault: false, hasKey: true, enabled: true, version: 2 },
    });
    const { container } = renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);
    await screen.findByRole('group', { name: 'OpenAI connections' });

    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });

  it('has no axe violations with the add dialog open (dark theme)', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch({ openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 } });
      renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);
      const group = await screen.findByRole('group', { name: 'OpenAI connections' });
      await act(async () => {
        fireEvent.click(within(group).getByRole('button', { name: 'Add another OpenAI connection' }));
      });

      /*
       * The DIALOG is the scan target while it is open, and deliberately so.
       * Radix marks the rest of the page `aria-hidden` for the duration; in a
       * browser that background is also inert, but jsdom has no inertness, so a
       * whole-document scan reports `aria-hidden-focus` against Radix's own
       * modal mechanism rather than against anything authored here. The
       * dialog-closed scan above covers the page.
       */
      const dialog = await screen.findByRole('dialog');
      expect(await axe(dialog)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
