/**
 * TASK-812 (D-10) — the endpoint-sequence ordering editor.
 *
 * What these tests pin is the thing the defect was ABOUT: an admin can ORDER the stage and ADD
 * to it. Before this ticket the sequence was a code literal and the only tenant-facing control
 * was an agent's `neverActions`, which could subtract and nothing else — so a test that only
 * proved "you can remove a step" would pass against the defect.
 *
 * The reorder controls are BUTTONS, not a drag handle (WCAG 2.5.7's single-pointer requirement),
 * and each is named after the step it moves — which is why the assertions here address them by
 * accessible name rather than by position.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { EndpointSequenceEditor } from '../endpoint-sequence-editor';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KEY = 'consultation.endpoint.actions';
const URL = `/api/hope/admin/settings/registry/${encodeURIComponent(KEY)}?scope=tenant`;

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubFetch(opts: { value?: unknown; version?: number; source?: string } = {}) {
  const { value = ['livedoc.stop', 'harness.finalize'], version = 4, source = 'tenant' } = opts;
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
      if (call.url === '/api/auth/session') {
        return Response.json({ user: { id: 'u-1', roles: ['SUPER_ADMIN'] }, isElevated: true });
      }
      if (call.method === 'GET' && call.url.startsWith(URL)) {
        return Response.json(
          { key: KEY, tier: 'global-kv', value, source, version },
          version > 0 ? { headers: { etag: `"${version}"` } } : undefined,
        );
      }
      if (call.method === 'PUT') {
        return Response.json({ key: KEY, tier: 'global-kv', value: call.body, scope: 'tenant', version: version + 1 });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

const putCalls = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'PUT');

/** The action keys, in the order they currently render (read off `data-action`, not the copy). */
function renderedOrder(): string[] {
  return screen.getAllByRole('listitem').map((item) => item.getAttribute('data-action') ?? '');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EndpointSequenceEditor', () => {
  it('renders the stored sequence in its authored order', async () => {
    stubFetch({ value: ['session.timeout', 'harness.finalize', 'summary.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Record how the session ended');
    expect(renderedOrder()).toEqual(['session.timeout', 'harness.finalize', 'summary.finalize']);
  });

  it('ORDER — moving a step later reorders the list and saves the new order (D-10)', async () => {
    const calls = stubFetch({ value: ['summary.finalize', 'harness.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Lock every document');
    fireEvent.click(screen.getByRole('button', { name: 'Move Lock every document later' }));
    expect(renderedOrder()).toEqual(['harness.finalize', 'summary.finalize']);

    fireEvent.click(screen.getByRole('button', { name: 'Save sequence' }));
    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: string[] }).value).toEqual(['harness.finalize', 'summary.finalize']);
  });

  it('EXTEND — a step absent from the sequence can be appended (the lever neverActions never had)', async () => {
    const calls = stubFetch({ value: ['harness.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Generate the clinical note');
    // The picker offers only steps NOT already in the sequence.
    expect(screen.queryByRole('option', { name: 'Generate the clinical note' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Add a step'));
    fireEvent.click(await screen.findByRole('option', { name: 'Capture clinician feedback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Append' }));

    expect(renderedOrder()).toEqual(['harness.finalize', 'feedback.capture']);

    fireEvent.click(screen.getByRole('button', { name: 'Save sequence' }));
    await waitFor(() => expect(putCalls(calls)).toHaveLength(1));
    expect((putCalls(calls)[0].body as { value: string[] }).value).toEqual(['harness.finalize', 'feedback.capture']);
  });

  it('SUBTRACT — a step can still be removed', async () => {
    stubFetch({ value: ['harness.finalize', 'feedback.capture'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Capture clinician feedback');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Capture clinician feedback' }));
    expect(renderedOrder()).toEqual(['harness.finalize']);
  });

  it('the first step cannot move earlier and the last cannot move later', async () => {
    stubFetch({ value: ['harness.finalize', 'summary.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Generate the clinical note');
    expect(screen.getByRole('button', { name: 'Move Generate the clinical note earlier' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Move Lock every document later' }).hasAttribute('disabled')).toBe(true);
  });

  it('Save is disabled until something actually changes, and Discard restores the stored order', async () => {
    stubFetch({ value: ['harness.finalize', 'summary.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Generate the clinical note');
    expect(screen.getByRole('button', { name: 'Save sequence' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Move Lock every document earlier' }));
    expect(screen.getByRole('button', { name: 'Save sequence' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(renderedOrder()).toEqual(['harness.finalize', 'summary.finalize']);
  });

  it('an unset key shows the platform default as the code-default source, never an empty stage', async () => {
    // `failMode: 'open-to-default'` — "nobody configured this" must not mean "close consultations
    // without finalizing them", and the badge has to say WHERE the shown value came from.
    stubFetch({
      value: ['livedoc.stop', 'session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture'],
      version: 0,
      source: 'code-default',
    });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Platform default (nothing saved yet)');
    expect(renderedOrder()).toHaveLength(5);
  });

  it('drops a stored key outside the closed vocabulary rather than offering it', async () => {
    stubFetch({ value: ['harness.finalize', 'not.an.action'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Generate the clinical note');
    expect(renderedOrder()).toEqual(['harness.finalize']);
  });

  it('an emptied sequence warns that consultations will close without finalizing', async () => {
    stubFetch({ value: ['harness.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Generate the clinical note');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Generate the clinical note' }));

    expect(screen.getByText('No endpoint steps')).toBeDefined();
    expect(screen.getByText(/without finalizing or locking any document/)).toBeDefined();
  });

  // The ORDERING invariant (§7a owner note 1). `harness.finalize` writes the note;
  // `summary.finalize` locks every document of the consultation. Inverted, a consultation closes
  // on an empty record — so the server refuses that write and this warning says so first. The
  // warning is ADVISORY; the enforcement is `endpointOrderProblem` on the descriptor.
  it('warns when the documents would be locked before the note is written', async () => {
    stubFetch({ value: ['summary.finalize', 'harness.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Lock every document');
    expect(screen.getByText('Documents are locked before the note is written')).toBeDefined();
  });

  it('does not warn for the platform default order', async () => {
    stubFetch({ value: ['livedoc.stop', 'session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Lock every document');
    expect(screen.queryByText('Documents are locked before the note is written')).toBeNull();
  });

  // Advisory means LIVE: it has to track the draft the admin is building, not the stored value,
  // or it would only ever appear for an order that was already saved.
  it('clears the warning as soon as the order is corrected', async () => {
    stubFetch({ value: ['summary.finalize', 'harness.finalize'] });
    renderWithProviders(<EndpointSequenceEditor scope="tenant" />);

    await screen.findByText('Documents are locked before the note is written');
    fireEvent.click(screen.getByRole('button', { name: 'Move Lock every document later' }));

    expect(renderedOrder()).toEqual(['harness.finalize', 'summary.finalize']);
    expect(screen.queryByText('Documents are locked before the note is written')).toBeNull();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<EndpointSequenceEditor scope="tenant" />);
    await screen.findByText('Stop live documentation');
    expect(await axe(container)).toHaveNoViolations();
  });
});
