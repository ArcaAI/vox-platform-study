/**
 * DD-11's "new version available" affordance (TASK-810 task 14).
 *
 * The point under test is not the rendering — it is that the rail distinguishes
 * THREE states and only flags one of them. An out-of-band prompt edit moves no
 * node's pin on purpose; if the resulting drift is invisible, the two-path
 * design silently becomes "nothing ever updates". Equally, if an UNPINNED node
 * were flagged too, the badge would appear on correct configurations and admins
 * would learn to ignore it.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { NodePromptBinding } from '../../../api/types';
import { PromptBindingsRail } from '../prompt-bindings-rail';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function binding(overrides: Partial<NodePromptBinding> = {}): NodePromptBinding {
  return {
    nodeId: 'generate_note',
    nodeType: 'prompt.template_ref',
    promptTemplateId: '11111111-1111-4111-8111-111111111111',
    promptTemplateName: 'SOAP note generation',
    pinnedVersionNumber: 4,
    latestVersionNumber: 5,
    hasNewVersion: true,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
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

const pathOf = (call: RecordedCall) => new URL(call.url, 'http://test.local').pathname;

function stubRail(bindings: NodePromptBinding[], extra: (call: RecordedCall) => Response | undefined = () => undefined): RecordedCall[] {
  return stubFetch((call) => {
    const path = pathOf(call);
    if (path === '/api/hope/admin/workflow-definitions/def-1/prompt-bindings') return Response.json(bindings);
    if (path.endsWith('/versions') && path.includes('/admin/prompt-templates/')) {
      return Response.json([
        { id: 'pv-4', versionNumber: 4, content: 'Old wording.' },
        { id: 'pv-5', versionNumber: 5, content: 'Reviewed wording from the library.' },
      ]);
    }
    return extra(call);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  cleanup();
});

describe('PromptBindingsRail (DD-11)', () => {
  it('flags a node that is pinned BEHIND its template, naming the version it could adopt', async () => {
    stubRail([binding()]);
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);

    expect(await screen.findByText('New v5 available')).toBeDefined();
    expect(screen.getByText(/Pinned to v4 · template at v5/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Review and adopt v5/ })).toBeDefined();
  });

  it('does NOT flag an UNPINNED node — following the template is a legitimate choice, not drift', async () => {
    stubRail([binding({ pinnedVersionNumber: null, hasNewVersion: false })]);
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);

    expect(await screen.findByText(/Follows template — no pin/)).toBeDefined();
    expect(screen.queryByText(/New v5 available/)).toBeNull();
    // No summary badge either — nothing in this graph is behind. (Matched
    // exactly: the rail's explanatory copy legitimately uses the word "behind"
    // to describe why the list exists.)
    expect(screen.queryByText(/^\d+ behind/)).toBeNull();
    // Still editable — it just is not reported as stale.
    expect(screen.getByRole('button', { name: 'Edit prompt for this node' })).toBeDefined();
  });

  it('does NOT flag a node pinned to the CURRENT version', async () => {
    stubRail([binding({ pinnedVersionNumber: 5, hasNewVersion: false })]);
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);

    expect(await screen.findByText(/Pinned to v5 · template at v5/)).toBeDefined();
    expect(screen.queryByText(/available/)).toBeNull();
  });

  it('summarises how many nodes are behind, counting only the flagged ones', async () => {
    stubRail([
      binding({ nodeId: 'a' }),
      binding({ nodeId: 'b' }),
      binding({ nodeId: 'c', pinnedVersionNumber: null, hasNewVersion: false }),
      binding({ nodeId: 'd', pinnedVersionNumber: 5, hasNewVersion: false }),
    ]);
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);

    expect(await screen.findByText('2 behind their templates')).toBeDefined();
  });

  it('re-pins ONE node through PUT :id/nodes/:nodeId/prompt, If-Match gated, opening on the template’s latest content', async () => {
    const calls = stubRail([binding()], (call) => {
      if (pathOf(call) === '/api/hope/admin/workflow-definitions/def-1/nodes/generate_note/prompt' && call.method === 'PUT') {
        return Response.json(
          { id: 'def-1', version: 8, promptVersionMinted: false, promptVersionNumber: 5, previousPromptVersionNumber: 4 },
          { headers: { etag: '"8"' } },
        );
      }
      return undefined;
    });
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);

    fireEvent.click(await screen.findByRole('button', { name: /Review and adopt v5/ }));

    const dialog = await screen.findByRole('dialog');
    // The admin sees what they would adopt BEFORE adopting it.
    await waitFor(() => expect((within(dialog).getByLabelText('Prompt content') as HTMLTextAreaElement).value).toBe('Reviewed wording from the library.'));

    // Saving that content UNCHANGED is the ADOPT path since §7b item 1 — the label says so,
    // rather than promising a v6 the server will not mint.
    fireEvent.click(within(dialog).getByRole('button', { name: /Adopt v5 for this node/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    // If-Match carries the WORKFLOW DEFINITION's version — this PUT rewrites the graph.
    expect(put?.headers['if-match']).toBe('"7"');
    expect(put?.body).toEqual({ content: 'Reviewed wording from the library.', expectedVersion: 7 });
    // `promptVersionNumber` is server-stamped; submitting one would be rejected by `forbidNonWhitelisted`.
    expect(Object.hasOwn(put?.body as object, 'promptVersionNumber')).toBe(false);
  });

  it('touches only the targeted node — the PUT names one nodeId and carries no other binding', async () => {
    const calls = stubRail([binding({ nodeId: 'first' }), binding({ nodeId: 'second' })], (call) => {
      if (call.method === 'PUT') {
        return Response.json(
          { id: 'def-1', version: 8, promptVersionMinted: false, promptVersionNumber: 5, previousPromptVersionNumber: 4 },
          { headers: { etag: '"8"' } },
        );
      }
      return undefined;
    });
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);

    const rows = await screen.findAllByRole('button', { name: /Review and adopt v5/ });
    fireEvent.click(rows[1]);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect((within(dialog).getByLabelText('Prompt content') as HTMLTextAreaElement).value).not.toBe(''));
    fireEvent.click(within(dialog).getByRole('button', { name: /Adopt v5 for this node/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(pathOf(put as RecordedCall)).toBe('/api/hope/admin/workflow-definitions/def-1/nodes/second/prompt');
  });

  it('disables editing on a read-only (PUBLISHED) definition — a published graph is immutable', async () => {
    stubRail([binding()]);
    renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' readOnly />);

    const button = await screen.findByRole('button', { name: /Review and adopt v5/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a Skeleton while bindings load, never a spinner', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('has no axe violations in both themes (rail, and the editor dialog)', async () => {
    stubRail([binding(), binding({ nodeId: 'unpinned', pinnedVersionNumber: null, hasNewVersion: false })]);
    const light = renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);
    await screen.findByText('New v5 available');
    expect(await axe(light.container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole('button', { name: /Review and adopt v5/ }));
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
    cleanup();

    document.documentElement.classList.add('dark');
    stubRail([binding(), binding({ nodeId: 'unpinned', pinnedVersionNumber: null, hasNewVersion: false })]);
    const dark = renderWithProviders(<PromptBindingsRail definitionId="def-1" etag='"7"' />);
    await screen.findByText('New v5 available');
    expect(await axe(dark.container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole('button', { name: /Review and adopt v5/ }));
    expect(await axe(await screen.findByRole('dialog'))).toHaveNoViolations();
  });
});
