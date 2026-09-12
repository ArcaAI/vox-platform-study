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
import { useDeleteProviderConnection } from '../../api/hooks';
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
function stubFetch(
  rows: Record<string, Record<string, unknown>> = {},
  /** A refusal the gateway answers a create with, for the cases that pin how one is rendered. */
  fail?: { putStatus: number; putBody: Record<string, unknown> },
): RecordedCall[] {
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
      if (method === 'DELETE') {
        // The row really leaves the LIST — which is what unmounts a sibling's
        // card when the mutation invalidates it, and therefore the whole point
        // of the silent-removal case below.
        delete rows[slug!];
        return new Response(null, { status: 204 });
      }
      if (method === 'PUT') {
        if (fail) return Response.json(fail.putBody, { status: fail.putStatus });
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

  /**
   * TASK-958 — the gateway's 400 `CONNECTION_SLUG_RESERVED`, mirrored.
   *
   * A slug equal to ANY known provider id belongs to that provider's DEFAULT
   * connection, and `platform-defaults` is a ROUTE segment on the same family —
   * a row named after it would be unaddressable. Neither is caught by the
   * duplicate check: the group only knows the slugs of ITS OWN provider, so
   * naming an OpenAI sibling `sarvam` looked perfectly valid here and came back
   * a 400 with a slug the admin has already mentally committed to.
   */
  it.each(['sarvam', 'azure', 'platform-defaults'])('refuses the reserved slug %s before it is sent', async (reserved) => {
    const { calls, dialog } = await openDialog();

    fireEvent.change(within(dialog).getByLabelText(/Connection id/), { target: { value: reserved } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create connection' }));
    });

    expect(within(dialog).getByRole('alert').textContent).toMatch(/reserved/i);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('renders the gateway CONNECTION_SLUG_RESERVED refusal as guidance when one still arrives', async () => {
    const calls = stubFetch(
      { openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 } },
      {
        putStatus: 400,
        putBody: { statusCode: 400, code: 'CONNECTION_SLUG_RESERVED', message: "'vertex' names a provider and cannot be a connection slug." },
      },
    );
    renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);
    const group = await screen.findByRole('group', { name: 'OpenAI connections' });
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Add another OpenAI connection' }));
    });
    const dialog = await screen.findByRole('dialog');

    // A slug the CLIENT mirror does not know about — only the gateway refuses it.
    fireEvent.change(within(dialog).getByLabelText(/Connection id/), { target: { value: 'gemini' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create connection' }));
    });

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/names a provider/));
    // Guidance, not just the raw refusal: say what to do about it.
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Choose a name/i);
    expect(calls.some((call) => call.method === 'PUT')).toBe(true);
  });
});

/**
 * TASK-958 G4 — the three defects Lane F recorded against the running console,
 * each pinned here at the level the e2e spec cannot reach cheaply.
 */
describe('ProviderCredentialsTab — removing a connection is never silent (D-1)', () => {
  const SIBLING_TITLE = 'OpenAI · Research account';

  function twoConnections() {
    return {
      openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 },
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
    } as Record<string, Record<string, unknown>>;
  }

  async function removeCard(heading: string, rows: Record<string, Record<string, unknown>>) {
    stubFetch(rows);
    renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);
    const group = await screen.findByRole('group', { name: 'OpenAI connections' });
    await waitFor(() => expect(within(group).getByRole('heading', { level: 3, name: heading })).toBeDefined());
    const cardElement = within(group).getByRole('heading', { level: 3, name: heading }).closest('[aria-labelledby]') as HTMLElement;

    fireEvent.click(within(cardElement).getByRole('button', { name: /^Remove the/ }));
    await act(async () => {
      fireEvent.click(within(cardElement).getByRole('button', { name: 'Confirm remove' }));
    });
    return group;
  }

  /**
   * THE defect, at the level that actually reproduces it.
   *
   * A sibling's card is unmounted by the refetch its own delete triggers, and a
   * `mutate(…, { onSuccess })` callback belongs to the OBSERVER — TanStack Query
   * v5 checks `hasListeners()` before running it, so an unmounted card is told
   * nothing and tells the user nothing. jsdom does NOT reproduce that race (the
   * screen case below passes either way: the stubbed fetch resolves in a
   * microtask, so React has not committed the unmount by the time the mutation
   * notifies), which is why the contract is pinned here instead: unmount the
   * caller mid-flight and the success handler must still run.
   */
  it('runs its success handler even when the caller unmounted mid-flight — the per-call callback does not', async () => {
    stubFetch(twoConnections());
    const onRemoved = vi.fn();
    const perCallSuccess = vi.fn();
    let remove: (() => void) | null = null;

    function DeleteProbe() {
      const mutation = useDeleteProviderConnection({ onRemoved });
      remove = () => mutation.mutate({ service: 'llm', slug: 'openai-research', tenantId: TENANT }, { onSuccess: perCallSuccess });
      return null;
    }

    const { unmount } = renderWithProviders(<DeleteProbe />);
    await act(async () => {
      remove!();
      // Exactly what the group does to a sibling's card when the row leaves the list.
      unmount();
    });

    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(perCallSuccess).not.toHaveBeenCalled();
  });

  /** And the screen says it, in the sibling's own words. */
  it('tells the admin a SIBLING was removed, and withdraws its card', async () => {
    const group = await removeCard(SIBLING_TITLE, twoConnections());

    await waitFor(() => expect(within(group).getAllByRole('heading', { level: 3 })).toHaveLength(1));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(`${SIBLING_TITLE} connection removed`);
  });

  /** And the card that does NOT unmount still says it once — not twice. */
  it('reports the DEFAULT connection’s removal exactly once', async () => {
    await removeCard('OpenAI', { openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 } });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('OpenAI connection removed — the platform default serves this provider again');
  });
});

describe('ProviderCredentialsTab — two editors, two sets of control names (D-2)', () => {
  /**
   * The console-side mirror of `expectDistinctControlNames`: with two accounts of
   * one vendor, every page-level control name in the OpenAI group must be unique,
   * or a screen-reader user hears "Add model" twice with no way to tell which
   * account it adds to.
   */
  it('gives every control in a two-card group a name of its own', async () => {
    stubFetch({
      openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 },
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
    await waitFor(() => expect(within(group).getAllByRole('heading', { level: 3 })).toHaveLength(2));

    const counts = new Map<string, number>();
    for (const button of within(group).getAllByRole('button')) {
      const name = (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, ' ').trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
    expect([...counts.keys()]).toEqual(expect.arrayContaining(['Add model to OpenAI', `Add model to OpenAI · Research account`]));
  });
});

describe('ProviderCredentialsTab — the add dialog gives focus back (D-3)', () => {
  async function openDialogFrom(): Promise<{ addButton: HTMLElement }> {
    stubFetch({ openai: { id: 'conn-1', provider: 'openai', slug: 'openai', isDefault: true, hasKey: true, enabled: true, version: 3 } });
    renderWithProviders(<ProviderCredentialsTab service="llm" tenantId={TENANT} tier="tenant" />);
    const group = await screen.findByRole('group', { name: 'OpenAI connections' });
    const addButton = within(group).getByRole('button', { name: 'Add another OpenAI connection' });
    await act(async () => {
      fireEvent.click(addButton);
    });
    await screen.findByRole('dialog');
    // Radix moved focus INTO the dialog, so the restore below is a real move.
    expect(document.activeElement).not.toBe(addButton);
    return { addButton };
  }

  it('returns focus to the trigger after Escape', async () => {
    const { addButton } = await openDialogFrom();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(addButton);
  });

  it('returns focus to the trigger after Cancel', async () => {
    const { addButton } = await openDialogFrom();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(addButton);
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
