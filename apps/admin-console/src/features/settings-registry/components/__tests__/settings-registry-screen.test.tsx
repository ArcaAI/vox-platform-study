/**
 * Settings registry screen + editor.
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
const FLAG_KEY = 'workflowExposure.enabled';
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
    // TASK-932 R-6 / D-6 — the lock is DERIVED SERVER-SIDE and projected onto
    // the catalog item. The console renders the reason verbatim rather than
    // re-deriving it, so the fixture carries what the gateway sends.
    locked: true,
    lockLabel: 'Bootstrap',
    lockReason:
      'Bootstrap / data-plane transport value, read from the process environment and fixed for the process lifetime. It changes by redeploying with a new value — never from an admin screen, for anyone.',
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

function stubFetch(opts: { elevated?: boolean; catalog?: SettingCatalog; onPut?: () => Response; workingTenant?: string | null } = {}): RecordedCall[] {
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

      // The grid persists per-user layout via `users/me/settings` — no saved
      // layout in tests. The adapter is a module-level singleton with an
      // in-flight-promise cache, so leaving this unhandled makes one test's
      // rejected load bleed into the next one's first paint.
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
      if (path === '/api/auth/session') {
        return Response.json({
          user: { id: 'u-1', roles: elevated ? ['SUPER_ADMIN'] : ['TENANT_ADMIN'] },
          isElevated: elevated,
          effectiveIsElevated: elevated,
          // TASK-932 R-6 — a TENANT override is only addressable when a working
          // tenant is selected: the write lane takes the target from CLS, never
          // from a caller-supplied id, so offering the scope without one would
          // produce a 400 on save. `opts.workingTenant: null` exercises the
          // unscoped platform admin.
          workingTenantId: opts.workingTenant === null ? null : 'tnt-1',
          workingTenantName: opts.workingTenant === null ? null : (opts.workingTenant ?? 'ArcaAI'),
        });
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

/**
 * Open the drawer on one key by clicking its ROW.
 *
 * Not by the row's action button: the grid virtualises and lays its columns out
 * by measured width, and jsdom reports zero for both — so the trailing actions
 * column is not reliably present. The row click is the primary affordance
 * anyway (the button is the keyboard-reachable duplicate of it).
 */
async function openKey(key: string) {
  const cell = await screen.findByText(key);
  const row = cell.closest('[data-slot="data-grid-row"]');
  if (!(row instanceof HTMLElement)) throw new Error(`no grid row for ${key}`);
  fireEvent.click(row);
  return screen.findByRole('dialog');
}

afterEach(async () => {
  // A test that leaves the drawer open (several below never click Cancel/Save
  // through to a close) hands `cleanup()` a mounted Radix `Sheet` mid-open.
  // Force-unmounting it there races the next test's own mount — `cleanup()`
  // tears down the React tree synchronously, but the Radix portal's own
  // dismiss/unmount effects are still pending, and the NEXT test's
  // `findByRole('dialog')` can lose that race and time out on a screen that
  // never got the previous dialog fully torn down. Close it the way a user
  // would (Escape) and wait for it to actually leave the DOM before
  // `cleanup()` runs. `waitFor` (not `waitForElementToBeRemoved`) because
  // Escape can close the dialog synchronously within the `fireEvent` itself —
  // `waitForElementToBeRemoved` throws when the element is already gone on
  // its first check, `waitFor` just resolves immediately in that case.
  const dialog = screen.queryByRole('dialog');
  if (dialog) {
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsRegistryScreen — the inventory', () => {
  // TASK-932 R-7 — the screen is an `AdminDataGrid` now, like `/settings`, so
  // the category taxonomy renders as GROUP ROWS rather than as one `<Table>` per
  // category. The taxonomy is still the server's; only the rendering moved.
  it('groups keys by the server-side category taxonomy', async () => {
    stubFetch();
    const { container } = renderWithProviders(<SettingsRegistryScreen />);

    expect(await screen.findByText(NUMBER_KEY)).toBeDefined();
    expect(container.querySelectorAll('[data-slot="data-grid-group-row"]').length).toBeGreaterThan(0);
    expect(screen.getByRole('grid', { name: 'Settings registry' })).toBeDefined();
  });

  it('offers the grid toolbar (omni search + facets) instead of a bespoke filter row', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(NUMBER_KEY);
    // The four facets (Category / Tier / Max scope / Editability) collapse into
    // this control below a ~1024px GRID CONTAINER, and jsdom has no width — so
    // the chips themselves are asserted in `task-932-settings-registry.spec.ts`,
    // where the viewport is real. What is checkable here is that the screen no
    // longer ships its own filter row.
    expect(screen.getByRole('button', { name: /Filter/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Editable here only' })).toBeNull();
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

  it('marks a LOCKED key as locked, rather than offering a control', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(ENV_KEY);
    // The action reads "Locked", not "Edit" — the affordance matches the
    // reality, and the reality is the SERVER's (`locked` is derived there).
    expect(screen.getByRole('button', { name: new RegExp(`Locked ${ENV_KEY}`) })).toBeDefined();
  });

  it('filters by search', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'rate-limit' } });

    await waitFor(() => expect(screen.queryByText(FLAG_KEY)).toBeNull());
    expect(screen.getByText(NUMBER_KEY)).toBeDefined();
  });

  it('shows the whole catalog by default — filtering is opt-in through the facets', async () => {
    // The old screen shipped a single "Editable here only" toggle. It is
    // replaced by the Editability facet (Editable here / Locked / Managed
    // elsewhere), asserted above; the facet's own interaction is a popover and
    // is covered end to end in `task-932-settings-registry.spec.ts`.
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    await screen.findByText(ENV_KEY);
    expect(screen.getByText(NUMBER_KEY)).toBeDefined();
    expect(screen.getByText(LIST_KEY)).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<SettingsRegistryScreen />);
    await screen.findByText(NUMBER_KEY);

    expect(await axe(container)).toHaveNoViolations();
  });

  it('m3 — mounting at ?key=<key> opens the drawer for that key', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />, { searchParams: `?key=${NUMBER_KEY}` });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(NUMBER_KEY)).toBeDefined();
  });

  it('m3 — an unknown ?key= leaves the drawer closed', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />, { searchParams: '?key=no-such-key' });

    await screen.findByText(NUMBER_KEY);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SettingRegistryDrawer — type-aware controls', () => {
  it('renders a numeric input for a number key and sends a NUMBER', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: unknown }).value).toBe(250);
  });

  it('renders a switch for a boolean key, not a text box', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(FLAG_KEY);

    expect(await within(dialog).findByRole('switch')).toBeDefined();
  });

  it('renders a line-per-entry textarea for a string[] key and sends an ARRAY', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(LIST_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: 'pii\nphi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: unknown }).value).toEqual(['pii', 'phi']);
  });

  it('refuses a malformed number in the form rather than collecting a 400', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: 'lots' } });

    expect(await within(dialog).findByText(/is not a number/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(putCalls(calls)).toHaveLength(0);
  });

  // A regression pin for the interleaving that produced the flake: a test
  // opens a drawer and never closes it (deliberately, below — most of the
  // tests in this file behave exactly this way), so `afterEach` is the only
  // thing that can leave the next test a clean slate. Order matters here —
  // these two `it`s must run back to back — so keep them adjacent rather than
  // relying on file order elsewhere in the suite.
  it('leaves its drawer open on purpose, to drive the next test', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    await openKey(NUMBER_KEY);
    // No close, no Cancel, no Save-then-close — `afterEach` inherits an open
    // Radix `Sheet` exactly like the tests above.
  });

  it('still finds a dialog for a DIFFERENT key after the previous test left one open', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);

    const dialog = await openKey(FLAG_KEY);
    expect(within(dialog).getByText(FLAG_KEY)).toBeDefined();
  });
});

describe('SettingRegistryDrawer — governance surfaced before the click', () => {
  it('announces that a system-scope write changes every tenant', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(FLAG_KEY);

    expect(await within(dialog).findByText(/changes the platform for every tenant/i)).toBeDefined();
  });

  it('shows which tier actually answered — the "why is it this value" question', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    expect(await within(dialog).findByText('platform (SYSTEM)')).toBeDefined();
  });

  it('offers no editing controls for a non-writable tier, and says which owner has it', async () => {
    stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(ENV_KEY);

    expect(await within(dialog).findByText(/not editable here/)).toBeDefined();
    // The reason comes from the SERVER, verbatim — the console keeps no second
    // copy of the rule that produced it.
    expect(within(dialog).getByText(/fixed for the process lifetime/)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('demands an explicit confirmation before a kill-switch is turned ON', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(FLAG_KEY);

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
    const dialog = await openKey(LIST_KEY);

    // Switch to the tenant row — the floor only applies below the platform value.
    // The scope control NAMES the tenant a tenant-scope write lands on:
    // "This tenant only" leaves the admin to remember which one, and TASK-932
    // R-6 is precisely the class of bug where the row read and the row written
    // were different and nothing on screen said so.
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'ArcaAI override' }));

    expect(await within(dialog).findByText(/only ADD to the platform list/)).toBeDefined();
  });

  it('offers a tenant admin no system-scope option at all', async () => {
    stubFetch({ elevated: false, catalog: { items: [ITEMS[0]], categories: ['Rate limits'] } });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    await within(dialog).findByLabelText('New value');
    expect(within(dialog).queryByText(/changes the platform for every tenant/i)).toBeNull();
  });
});

describe('SettingRegistryDrawer — optimistic concurrency', () => {
  it('sends If-Match from the prior read', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect(putCalls(calls)[0].headers.get('if-match')).toBe('"3"');
  });

  it('omits If-Match on a FIRST write — there is no row to precondition against', async () => {
    const calls = stubFetch();
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(FLAG_KEY);

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
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.click(await within(dialog).findByRole('radio', { name: 'ArcaAI override' }));
    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { scope: string }).scope).toBe('tenant');
  });

  it('surfaces a 412 as a conflict and does NOT retry the stale write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/412 Precondition Failed/)).toBeDefined();
    expect(putCalls(calls)).toHaveLength(1);
  });

  it('M2 — keeps the typed edit after a 412, since the alert says it is kept locally', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await within(dialog).findByText(/412 Precondition Failed/);
    expect(putCalls(calls)).toHaveLength(1);
    expect((within(dialog).getByLabelText('New value') as HTMLInputElement).value).toBe('250');
  });

  it('surfaces a 428 as a stale-tab precondition error rather than forcing the write', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'precondition required' }, { status: 428 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

    fireEvent.change(await within(dialog).findByLabelText('New value'), { target: { value: '250' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/428 Precondition Required/)).toBeDefined();
    expect(putCalls(calls)).toHaveLength(1);
  });

  it('re-reads the winning value after a conflict instead of resubmitting', async () => {
    const calls = stubFetch({ onPut: () => Response.json({ message: 'conflict' }, { status: 412 }) });
    renderWithProviders(<SettingsRegistryScreen />);
    const dialog = await openKey(NUMBER_KEY);

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
    const dialog = await openKey(NUMBER_KEY);
    await within(dialog).findByLabelText('New value');

    expect(await axe(sheetContent())).toHaveNoViolations();
  });
});
