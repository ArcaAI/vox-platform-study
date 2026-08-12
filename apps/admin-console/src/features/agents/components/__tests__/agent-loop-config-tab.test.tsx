/**
 * Loop config tab (TASK-667, budgets un-locked TASK-678 OP-6): subscribed
 * kinds/write scope sourced from the resolved context schema, tenant-writable
 * budgets (both a tenant admin and a global admin can edit them — see the
 * TASK-678 README Decisions section), the C25 typed-acknowledgement gate on
 * weakening a clinical check, the PRIMARY conflict warning, and an axe scan.
 * Rendered through the drawer (the Loop config tab is one of its four tabs)
 * so the OCC/session plumbing matches production exactly.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { DepartmentAgent } from '../../api/types';
import { DepartmentAgentDetailDrawer } from '../agent-detail-drawer';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<DepartmentAgent> = {}): DepartmentAgent {
  return {
    id: 'da-1',
    departmentId: 'd-1',
    name: 'Cardiology SOAP',
    slug: 'cardiology-soap',
    promptTemplateId: 'pt-1',
    pinnedVersionNumber: null,
    dnaStylePolicy: 'INHERIT',
    isDefault: false,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    version: 2,
    role: 'SPECIALIST',
    ...overrides,
  };
}

const SESSION = {
  user: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'] },
  isElevated: false,
  workingTenantId: 'tnt-1',
  workingTenantName: 'Sunrise Medical Group',
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'tenant_admin', email: 'admin@arca.ai', roles: ['TENANT_ADMIN'], tenantId: 'tnt-1', departmentId: null },
  effectiveIsElevated: false,
  effectiveTenantId: 'tnt-1',
};

const GLOBAL_ADMIN_SESSION = { ...SESSION, isElevated: true, effectiveIsElevated: true };

const RESOLVED_SCHEMA = {
  schemaId: 'ccs-1',
  versionNumber: 3,
  definition: {
    kinds: [
      { key: 'referral_letter', label: 'Referral letter', primitive: 'DOCUMENT' },
      { key: 'triage_form', label: 'Triage form', primitive: 'STRUCTURED' },
    ],
    outputs: [{ key: 'soap_note', label: 'SOAP note', primitive: 'STRUCTURED' }],
  },
  etag: '"ccs-1:3"',
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
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
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

const pathnameOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

async function chooseSelectOption(triggerLabel: string, optionName: string): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name: triggerLabel });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function baseHandler(
  currentAgent: DepartmentAgent,
  call: RecordedCall,
  options: { session?: typeof SESSION; siblings?: DepartmentAgent[] } = {},
): Response | undefined {
  const path = pathnameOf(call);
  if (call.method === 'GET' && path === '/api/auth/session') {
    return Response.json(options.session ?? SESSION);
  }
  if (call.method === 'GET' && path === `/api/hope/admin/department-agents/${currentAgent.id}`) {
    return Response.json(currentAgent, { headers: { etag: `"${currentAgent.version}"` } });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/prompt-templates') {
    return Response.json({ data: [], count: 0, limit: 200, page: 1 });
  }
  if (call.method === 'GET' && path === '/api/hope/admin/harness/golden-sets') {
    return Response.json({ items: [], total: 0 });
  }
  if (call.method === 'GET' && path === '/api/hope/tenant/me/context-schema') {
    return Response.json(RESOLVED_SCHEMA);
  }
  if (call.method === 'GET' && path === '/api/hope/admin/department-agents') {
    const siblings = options.siblings ?? [];
    return Response.json({ data: siblings, count: siblings.length, limit: 200, page: 0 });
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('LoopConfigTab', () => {
  it('offers subscribed-kind and write-scope checkboxes ONLY for keys declared in the resolved context schema', async () => {
    stubFetch((call) => baseHandler(agent(), call));
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    const drawer = await screen.findByRole('dialog');
    // Schema declares exactly these two kinds and one output — nothing else appears.
    expect(await within(drawer).findByLabelText(/Referral letter/)).toBeDefined();
    expect(within(drawer).getByLabelText(/Triage form/)).toBeDefined();
    expect(within(drawer).getByLabelText(/SOAP note/)).toBeDefined();
    expect(within(drawer).queryByLabelText(/unknown_kind/)).toBeNull();
  });

  it('renders a fail-closed message and no pickable kinds when the department has no resolved schema', async () => {
    stubFetch((call) => {
      if (pathnameOf(call) === '/api/hope/tenant/me/context-schema') {
        return Response.json({ schemaId: null, versionNumber: null, definition: null, etag: '"none"' });
      }
      return baseHandler(agent(), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    expect(await screen.findByText(/No consultation context schema is configured/)).toBeDefined();
    expect(screen.queryByLabelText(/Referral letter/)).toBeNull();
    expect(screen.queryByLabelText(/SOAP note/)).toBeNull();
  });

  // TASK-678 (OP-6) — Budgets are tenant-writable, matching the server's
  // `TENANT_TIER_HARNESS_OVERRIDE_KEYS` allow-list (which was never
  // role-gated for these three keys). The earlier "locked for a non-elevated
  // caller" behavior was a console guarantee the server never enforced; see
  // the ticket README's Decisions section.
  it('does not lock the Budgets fields for a non-elevated (tenant admin) caller — no "Global admins only" hint', async () => {
    stubFetch((call) => baseHandler(agent(), call, { session: SESSION }));
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    const maxRegen = (await screen.findByLabelText('Max regen budget')) as HTMLInputElement;
    expect(maxRegen.disabled).toBe(false);
    expect(screen.queryByText('Global admins only')).toBeNull();
  });

  it('a tenant admin CAN change Budgets — the PATCH carries harnessOverrides', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/admin/department-agents/da-1') {
        return Response.json(agent({ version: 3 }), { headers: { etag: '"3"' } });
      }
      return baseHandler(agent({ harnessOverrides: { toolAllowlist: ['ner'] } }), call, { session: SESSION });
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    const maxRegen = (await screen.findByLabelText('Max regen budget')) as HTMLInputElement;
    expect(maxRegen.disabled).toBe(false);
    fireEvent.change(maxRegen, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save loop configuration' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as Record<string, unknown>).harnessOverrides).toEqual({ toolAllowlist: ['ner'], maxRegen: 5 });
  });

  it('lets a global admin edit Budgets too, and the PATCH carries them merged into existing harnessOverrides', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/admin/department-agents/da-1') {
        return Response.json(agent({ version: 3 }), { headers: { etag: '"3"' } });
      }
      return baseHandler(agent({ harnessOverrides: { toolAllowlist: ['ner'] } }), call, { session: GLOBAL_ADMIN_SESSION });
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    const maxRegen = (await screen.findByLabelText('Max regen budget')) as HTMLInputElement;
    expect(maxRegen.disabled).toBe(false);
    fireEvent.change(maxRegen, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save loop configuration' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as Record<string, unknown>).harnessOverrides).toEqual({ toolAllowlist: ['ner'], maxRegen: 5 });
  });

  it('warns inline when picking PRIMARY while another agent already holds it in the department', async () => {
    const otherPrimary = agent({ id: 'da-2', name: 'Nephrology Primary', role: 'PRIMARY' });
    stubFetch((call) => baseHandler(agent(), call, { siblings: [agent(), otherPrimary] }));
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    await screen.findByLabelText('Loop role');
    await chooseSelectOption('Loop role', 'Primary (owns the note)');

    expect(await screen.findByText(/Nephrology Primary.*already PRIMARY/)).toBeDefined();
  });

  it('requires the C25 typed acknowledgement before saving a transition to the RELAXED guardrail profile, and records it in the PATCH', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/admin/department-agents/da-1') {
        return Response.json(agent({ version: 3 }), { headers: { etag: '"3"' } });
      }
      return baseHandler(agent({ guardrailProfile: 'STANDARD' }), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    await screen.findByRole('combobox', { name: 'Guardrail profile' });
    await chooseSelectOption('Guardrail profile', 'Relaxed');
    fireEvent.click(screen.getByRole('button', { name: 'Save loop configuration' }));

    // The dialog blocks the save until the exact phrase is typed.
    expect(await screen.findByText(/Weakening a clinical check/)).toBeDefined();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    const confirmButton = screen.getByRole('button', { name: 'Save anyway' });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'nope' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'WEAKEN' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as Record<string, unknown>).guardrailProfile).toBe('RELAXED');
  });

  it('does NOT require acknowledgement when the transition does not weaken a clinical check', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PATCH' && pathnameOf(call) === '/api/hope/admin/department-agents/da-1') {
        return Response.json(agent({ version: 3 }), { headers: { etag: '"3"' } });
      }
      return baseHandler(agent({ guardrailProfile: 'STANDARD' }), call);
    });
    renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    await screen.findByRole('combobox', { name: 'Guardrail profile' });
    await chooseSelectOption('Guardrail profile', 'Strict');
    fireEvent.click(screen.getByRole('button', { name: 'Save loop configuration' }));

    expect(screen.queryByText(/Weakening a clinical check/)).toBeNull();
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
  });

  it('has no axe violations on the Loop config tab', async () => {
    stubFetch((call) => baseHandler(agent(), call));
    const { container } = renderWithProviders(
      <DepartmentAgentDetailDrawer
        agentId="da-1"
        creating={false}
        departmentLabel="CARD"
        onOpenChange={() => {}}
        onCreated={() => {}}
        onRequestDelete={() => {}}
        onSetDefault={() => {}}
      />,
      { searchParams: '?catab=loop' },
    );

    await screen.findByLabelText(/Referral letter/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Loop config tab in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      stubFetch((call) => baseHandler(agent(), call));
      const { container } = renderWithProviders(
        <DepartmentAgentDetailDrawer
          agentId="da-1"
          creating={false}
          departmentLabel="CARD"
          onOpenChange={() => {}}
          onCreated={() => {}}
          onRequestDelete={() => {}}
          onSetDefault={() => {}}
        />,
        { searchParams: '?catab=loop' },
      );

      await screen.findByLabelText(/Referral letter/);
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
