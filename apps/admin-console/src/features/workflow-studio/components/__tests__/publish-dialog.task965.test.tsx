/**
 * TASK-965 WS-1 (O-3) — the published step of `PublishDialog` explains the three legitimate
 * outcomes that used to collapse into one "reopen to retry" error: the version was published
 * WITHOUT activation, the palette is not exposable on the public invoke surface, or the tenant's
 * exposure gate is off (a 404 from `GET workflows/{slug}/schema`).
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { PublishDialog } from '../publish-dialog';

function stubFetch(status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => (status === 200 ? Response.json({ slug: 'discharge-summary', versionNumber: 3, triggerKinds: ['api'], protocols: ['http'], modes: ['async'] }) : Response.json({ message: 'Not found.' }, { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('PublishDialog — published, explained (TASK-965 WS-1)', () => {
  it('published without activation: says the active version keeps serving and does not fetch the schema', async () => {
    const fetchMock = stubFetch();
    renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" activated={false} />);

    expect(await screen.findByText(/not active/i)).toBeTruthy();
    expect(screen.queryByText(/couldn.t resolve/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-exposable palette: names the palette rule instead of an error, and does not fetch', async () => {
    const fetchMock = stubFetch();
    renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" exposable={false} />);

    expect(await screen.findByText(/not exposable/i)).toBeTruthy();
    expect(screen.queryByText(/couldn.t resolve/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 404 from the schema route names the exposure gate rather than asking for a retry that cannot succeed', async () => {
    stubFetch(404);
    renderWithProviders(<PublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} published slug="discharge-summary" />);

    expect(await screen.findByText(/workflow exposure/i)).toBeTruthy();
    expect(screen.queryByText(/reopen this dialog to retry/i)).toBeNull();
  });
});
