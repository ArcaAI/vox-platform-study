/**
 * Settings registry screen + editor (TASK-799 Phase 4, E.1).
 *
 * `GET admin/settings/catalog` and `PUT admin/settings/registry/:key` have been
 * fully functional with exactly ONE console consumer, so 210 descriptors had an
 * API and no button. What follows pins the parts that make this a GOVERNANCE
 * screen rather than a key/value form: the right control per `dataType`, a
 * platform-wide write announced before the click, a non-writable tier declining
 * with a reason instead of 400-ing, and OCC that refuses rather than clobbers.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { SettingCatalog, SettingCatalogItem } from '../../api/types';
import { SettingsRegistryScreen } from '../settings-registry-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const NUMBER_KEY = 'rate-limit.maxRequests';
const FLAG_KEY = 'pipeline.harnessEnabled';
const ENV_KEY = 'storage.minio.endpoint';
const LIST_KEY = 'guardrail.policy.categories';

const ITEMS: SettingCatalogItem[] = [
  {
    key: NUMBER_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    category: 'Rate limits',
    label: 'Max requests',
    description: 'Requests allowed per window.',
  },
  {
    key: FLAG_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    category: 'Pipeline',
    globalOnly: true,
    killSwitch: true,
  },
  {
    key: ENV_KEY,
    tier: 'env',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'none',
    category: 'Storage',
  },
  {
    key: LIST_KEY,
    tier: 'global-kv',
    dataType: 'string[]',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    category: 'Guardrail',
    floorDirection: 'superset-is-stricter',
  },
];

const CATALOG: SettingCatalog = {
  items: ITEMS,
  categories: ['Guardrail', 'Pipeline', 'Rate limits', 'Storage'],
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const STORED: Record<string, { value: unknown; sourceScope: string; version: number }> = {
  [NUMBER_KEY]: { value: 100, sourceScope: 'global-kv', version: 3 },
  [FLAG_KEY]: { value: false, sourceScope: 'code-default', version: 0 },
  [ENV_KEY]: { value: 'http://localhost:9000', sourceScope: 'env', version: 0 },
  [LIST_KEY]: { value: ['pii'], sourceScope: 'global-kv', version: 2 },
};

/** Radix mounts focusable `aria-hidden` guards at body level; scan the sheet itself. */
function sheetContent(): HTMLElement {
  const element = document.querySelector('[data-slot="sheet-content"]');
  if (!(element instanceof HTMLElement)) throw new Error('sheet content not rendered');
  return element;
}

function stubFetch(opts: { elevated?: boolean; catalog?: SettingCatalog; onPut?: () => Response } = {}): RecordedCall[] {
  const { elevated = true, catalog = CATALOG } = opts;
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
      const [path] = call.url.split('?');

      if (path === '/api/auth/session') {
        return Response.json({ user: { id: 'u-1', roles: elevated ? ['SUPER_ADMIN'] : ['TENANT_ADMIN'] }, isElevated: elevated });
      }
      if (call.method === 'GET' && path === '/api/hope/admin/settings/catalog') {
        return Response.json(catalog);
      }
      if (path.startsWith('/api/hope/admin/settings/registry/')) {
        const key = decodeURIComponent(path.replace('/api/hope/admin/settings/registry/', ''));
        const stored = STORED[key] ?? { value: null, sourceScope: 'code-default', version: 0 };
        if (call.method === 'PUT') {
          return opts.onPut ? opts.onPut() : Response.json({ key, tier: 'global-kv', value: call.body, scope: 'system', version: stored.version + 1 });
        }
        // Mirrors the ETagInterceptor: no ETag for a non-positive version.
        return Response.json(
          { key, tier: 'global-kv', ...stored },
          stored.version > 0 ? { headers: { etag: `"${stored.version}"` } } : undefined,
        );
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

const putCalls = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'PUT');

/** Open the drawer on one key by its row action. */
async function openKey(label: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: label }));
  return screen.findByRole('dialog');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsRegistryScreen — the inventory', () => {
  it('groups keys by the server-side category taxonomy', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    // By ROLE, not by text: the category names also appear as <option>s in the
    // filter, and a bare text query cannot tell a heading from a filter choice.
    expect(await screen.findByRole('heading', { name: /Rate limits/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Pipeline/ })).toBeDefined();
    expect(screen.getByText(NUMBER_KEY)).toBeDefined();
  });

  it('fetches values LAZILY — rendering the list must not cost one request per key', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(NUMBER_KEY);
    expect(calls.filter((c) => c.url.includes('/settings/registry/'))).toHaveLength(0);
  });

  it('marks a platform-wide key before it is opened', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(FLAG_KEY);
    expect(screen.getByText('Platform-wide')).toBeDefined();
    expect(screen.getByText('Kill-switch')).toBeDefined();
  });

  it('marks a tighten-only key in the list', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(LIST_KEY);
    expect(screen.getByText('Tighten-only')).toBeDefined();
  });

  it('labels an env-tier key as not editable here, rather than offering a control', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(ENV_KEY);
    expect(screen.getByText('Deploy-time')).toBeDefined();
    // The action reads "View", not "Edit" — the affordance matches the reality.
    expect(screen.getByRole('button', { name: new RegExp(`View ${ENV_KEY}`) })).toBeDefined();
  });

  it('filters by search', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'rate-limit' } });

    await waitFor(() => expect(screen.queryByText(FLAG_KEY)).toBeNull());
    expect(screen.getByText(NUMBER_KEY)).toBeDefined();
  });

  it('filters to keys this lane can actually write', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(ENV_KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Editable here only' }));

    await waitFor(() => expect(screen.queryByText(ENV_KEY)).toBeNull());
    expect(screen.getByText(NUMBER_KEY)).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<SettingsRegistryScreen />);
    await screen.findByText(NUMBER_KEY);

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SettingRegistryDrawer — type-aware controls', () => {
  it('renders a numeric input for a number key and sends a NUMBER', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: unknown }).value).toBe(250);
  });

  it('renders a switch for a boolean key, not a text box', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${FLAG_KEY}`));

    expect(await within(dialog).findByRole('switch')).toBeDefined();
  });

  it('renders a line-per-entry textarea for a string[] key and sends an ARRAY', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${LIST_KEY}`));

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: 'pii\nphi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: unknown }).value).toEqual(['pii', 'phi']);
  });

  it('refuses a malformed number in the form rather than collecting a 400', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: 'lots' } });

    expect(await within(dialog).findByText(/is not a number/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(putCalls(calls)).toHaveLength(0);
  });
});

describe('SettingRegistryDrawer — governance surfaced before the click', () => {
  it('announces that a system-scope write changes every tenant', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${FLAG_KEY}`));

    expect(await within(dialog).findByText(/changes the platform for every tenant/i)).toBeDefined();
  });

  it('shows which tier actually answered — the "why is it this value" question', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    expect(await within(dialog).findByText('platform (SYSTEM)')).toBeDefined();
  });

  it('offers no editing controls for a non-writable tier, and says which owner has it', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`View ${ENV_KEY}`));

    expect(await within(dialog).findByText(/not editable here/)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('demands an explicit confirmation before a kill-switch is turned ON', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${FLAG_KEY}`));

    fireEvent.click(await within(dialog).findByRole('switch'));

    expect(await within(dialog).findByText(/safe position is OFF/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: unknown }).value).toBe(true);
  });

  it('states the tighten-only rule on a floored key at tenant scope', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${LIST_KEY}`));

    // Switch to the tenant row — the floor only applies below the platform value.
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'This tenant only' }));

    expect(await within(dialog).findByText(/only ADD to the platform list/)).toBeDefined();
  });

  it('offers a tenant admin no system-scope option at all', async () => {
    stubFetch({ elevated: false, catalog: { items: [ITEMS[0]], categories: ['Rate limits'] } });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    await within(dialog).findByLabelText('New value');
    expect(within(dialog).queryByText(/changes the platform for every tenant/i)).toBeNull();
  });
});

describe('SettingRegistryDrawer — optimistic concurrency', () => {
  it('sends If-Match from the prior read', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(putCalls(calls)[0].headers.get('if-match')).toBe('"3"');
  });

  it('omits If-Match on a FIRST write — there is no row to precondition against', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${FLAG_KEY}`));

    fireEvent.click(await within(dialog).findByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(putCalls(calls)[0].headers.get('if-match')).toBeNull();
  });

  it('carries the chosen scope in the body, so the write lands on the intended row', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'This tenant only' }));
    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { scope: string }).scope).toBe('tenant');
  });

  it('surfaces a 412 as a conflict and does NOT retry the stale write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/412 Precondition Failed/)).toBeDefined();
    expect(putCalls(calls)).toHaveLength(1);
  });

  it('surfaces a 428 as a stale-tab precondition error rather than forcing the write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'precondition required' }, { status: 428 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/428 Precondition Required/)).toBeDefined();
    expect(putCalls(calls)).toHaveLength(1);
  });

  it('re-reads the winning value after a conflict instead of resubmitting', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));

    const readsBefore = calls.filter((c) => c.method === 'GET' && c.url.includes('/settings/registry/')).length;
    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/settings/registry/')).length).toBeGreaterThan(readsBefore),
    );
  });

  it('has no axe violations with the editor open', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(new RegExp(`Edit ${NUMBER_KEY}`));
    await within(dialog).findByLabelText('New value');

    expect(await axe(sheetContent())).toHaveNoViolations();
  });
});
