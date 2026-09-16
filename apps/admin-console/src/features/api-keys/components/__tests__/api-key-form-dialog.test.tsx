/**
 * The create-key dialog.
 *
 * It used to open on 99 scope checkboxes — an admin issuing a key for a clinic
 * app had to know, one checkbox at a time, which 19 of them that means. Purpose
 * comes first now: four radio cards, three of which carry a preset the platform
 * declares once (`API_KEY_SCOPE_PRESETS` in `@arcaai/types`, served on
 * `GET admin/api-keys/scopes`) and one — Custom — that says "choose them
 * yourself".
 *
 * The checklist did not go away and is not read-only: a preset is a starting
 * point, so every scope stays editable behind one disclosure that reports how
 * many are selected. The control counts below are the contract.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { API_KEY_SCOPE_PRESETS } from '@arcaai/types';
import { renderWithProviders } from '@/test/render';
import { ApiKeyFormDialog } from '../api-key-form-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CATALOG = {
  categories: {
    Consultation: [
      { scope: 'consultation:session:read', description: 'Read consultations.' },
      { scope: 'consultation:session:write', description: 'Open and update consultations.' },
    ],
    Tenant: [{ scope: 'tenant:context-schema:read', description: "Read the tenant's context schema." }],
    Catalogue: [
      { scope: 'agent:definition:read', description: 'List published agents.' },
      { scope: 'workflow:definition:read', description: 'List published workflows.' },
    ],
    Admin: [{ scope: 'admin:tenant:manage', description: 'Never reachable by an API key.' }],
  },
  presets: API_KEY_SCOPE_PRESETS,
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response | undefined): RecordedCall[] {
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

function stubScopes(custom: (call: RecordedCall) => Response | undefined = () => undefined): RecordedCall[] {
  return stubFetch((call) => {
    if (call.url.includes('/admin/api-keys/scopes')) return Response.json(CATALOG);
    return custom(call);
  });
}

/**
 * Everything an admin can operate without opening the scopes disclosure. The
 * dialog's own X is chrome, not a control the form offers, so it is excluded —
 * as is a `RadioGroupItem`'s hidden bubble `<input type="radio">`, which is one
 * control with its `<button role="radio">`, not two.
 */
function visibleControlCount(): number {
  return document.querySelectorAll(
    '[role="dialog"] input:not([type="hidden"]):not([aria-hidden="true"]), [role="dialog"] textarea, [role="dialog"] button:not([data-slot="dialog-close"])',
  ).length;
}

/** Preset labels carry parentheses; match them literally. */
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApiKeyFormDialog — create', () => {
  it('asks for a purpose first, rendering every preset from the response rather than a local copy', async () => {
    stubScopes();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} />);

    for (const preset of API_KEY_SCOPE_PRESETS) {
      expect(await screen.findByRole('radio', { name: literal(preset.label) })).toBeDefined();
      expect(screen.getByText(preset.description)).toBeDefined();
    }
    expect(screen.getByRole('radio', { name: /Custom/ })).toBeDefined();
    expect(screen.getByText('Choose individual permissions yourself.')).toBeDefined();
  });

  it('shows nine controls before the scopes disclosure is opened', async () => {
    stubScopes();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} />);
    await screen.findByRole('radio', { name: /Consultation app/ });

    // 4 purpose radios + Name + Expires + the scopes disclosure trigger + Cancel + Create.
    expect(visibleControlCount()).toBe(9);
    expect(screen.queryByRole('checkbox', { name: /consultation:session:read/ })).toBeNull();
  });

  it('pre-checks a preset’s scopes and reports the count on the disclosure', async () => {
    stubScopes();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Type generation/ }));

    expect(screen.getByRole('button', { name: /Show all scopes \(3 selected\)/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Show all scopes \(3 selected\)/ }));
    const codegen = API_KEY_SCOPE_PRESETS.find((preset) => preset.key === 'types-codegen')!;
    for (const scope of codegen.scopes) {
      expect((screen.getByRole('checkbox', { name: new RegExp(scope) }) as HTMLElement).getAttribute('data-state')).toBe('checked');
    }
    expect(screen.getByRole('checkbox', { name: /admin:tenant:manage/ }).getAttribute('data-state')).toBe('unchecked');
  });

  it('keeps the checklist editable — a preset is a starting point, not a lock', async () => {
    stubScopes();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Type generation/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show all scopes/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /consultation:session:read/ }));

    expect(screen.getByRole('button', { name: /Show all scopes \(4 selected\)/ })).toBeDefined();
  });

  it('starts Custom with nothing selected and refuses to create until at least one scope is picked', async () => {
    stubScopes();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'svc_reporting' } });

    expect(screen.getByRole('button', { name: /Show all scopes \(0 selected\)/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create key' }).hasAttribute('disabled')).toBe(true);
  });

  it('posts the name, the selected scopes and the expiry', async () => {
    const calls = stubScopes((call) => {
      if (call.url.includes('/admin/api-keys') && call.method === 'POST') {
        return Response.json({ apiKey: { id: 'k-1' }, rawKey: 'hope_sk_live_x' });
      }
      return undefined;
    });
    const onCreated = vi.fn();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} onCreated={onCreated} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Agents & workflows/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'svc_runner' } });
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2027-01-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = calls.find((call) => call.method === 'POST');
    const body = post?.body as { keyName: string; scopes: string[]; expiresAt?: string };
    expect(body.keyName).toBe('svc_runner');
    expect(body.scopes).toEqual([...API_KEY_SCOPE_PRESETS.find((preset) => preset.key === 'agents-and-workflows')!.scopes]);
    expect(body.expiresAt).toContain('2027-01-31');
  });

  it('opens an EDIT on the scope checklist, with no purpose step', async () => {
    stubScopes();
    renderWithProviders(
      <ApiKeyFormDialog
        initial={{
          id: 'k-1',
          keyName: 'svc_reporting',
          keyPrefix: 'hope_sk',
          keyType: 'SDK',
          keyStatus: 'ACTIVE',
          scopes: ['consultation:session:read'],
          usageCount: 0,
          projectId: null,
          resourceStatus: 'ENABLED',
          resourceStatusUpdatedAt: null,
          resourceStatusUpdatedBy: null,
          createdBy: null,
          updatedBy: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }}
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Edit API key' })).toBeDefined();
    expect(screen.queryByRole('radio', { name: /Consultation app/ })).toBeNull();
    // An existing key's scopes are what the dialog is FOR, so the list is open.
    expect(await screen.findByRole('checkbox', { name: /consultation:session:read/ })).toBeDefined();
  });

  it('has no axe violations closed or with the scopes open', async () => {
    stubScopes();
    renderWithProviders(<ApiKeyFormDialog initial={null} onOpenChange={() => {}} />);
    await screen.findByRole('radio', { name: /Consultation app/ });

    const dialog = screen.getByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();

    fireEvent.click(within(dialog).getByRole('button', { name: /Show all scopes/ }));
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
