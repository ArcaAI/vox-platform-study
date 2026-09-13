/**
 * TASK-965 — `IntegrationPanel`, the console-shared "how developers reach this" surface for a
 * published agent or workflow. Everything derives from the lineage (slug, task/palette, active
 * flag), never from a publish response, so it can be rendered at any later time.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { IntegrationPanel } from '../integration-panel';

function stubSchemaFetch(status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    status === 200 ? Response.json({ slug: 'discharge-summary', versionNumber: 3, modes: ['async', 'blocking', 'stream', 'socket'] }) : Response.json({ message: 'Not found.' }, { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('IntegrationPanel — agent', () => {
  it('renders the task-shaped endpoint, the vox-node snippet and the API-keys link', async () => {
    // Hosted in a landmark, as the drawer/dialog hosts it in the app — axe's `region` rule
    // otherwise flags the bare document body, not the panel.
    renderWithProviders(
      <main>
        <IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" versionNumber={2} isActive />
      </main>,
    );

    expect(screen.getByText('POST /agents/clinic-summarizer/invocations')).toBeTruthy();
    expect(screen.getByText(/\?mode=blocking/)).toBeTruthy();
    expect(screen.getByRole('group', { name: /vox-node/i }).textContent).toContain("hope.agents.invoke('clinic-summarizer'");
    expect((screen.getByRole('link', { name: /api keys/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/api-keys');
    expect(await axe(screen.getByRole('main'))).toHaveNoViolations();
  });

  it('a speech agent gets the transcriptions route; NER shares the invocations route without the stream note', () => {
    const { unmount } = renderWithProviders(<IntegrationPanel kind="agent" slug="asr" task="SPEECH_TO_TEXT" />);
    expect(screen.getByText('POST /agents/asr/transcriptions')).toBeTruthy();
    unmount();

    renderWithProviders(<IntegrationPanel kind="agent" slug="ner" task="NAMED_ENTITY_RECOGNITION" />);
    expect(screen.getByText('POST /agents/ner/invocations')).toBeTruthy();
    expect(screen.queryByText(/\?mode=stream/)).toBeNull();
  });

  it('says the endpoint resolves the ACTIVE version when this one is not it', () => {
    renderWithProviders(<IntegrationPanel kind="agent" slug="clinic-summarizer" task="TEXT_GENERATION" versionNumber={3} isActive={false} />);
    expect(screen.getByText(/published, not active/i)).toBeTruthy();
    expect(screen.getByText('POST /agents/clinic-summarizer/invocations')).toBeTruthy();
  });
});

describe('IntegrationPanel — workflow', () => {
  it('reads the run contract: endpoint, the ?mode= set without socket, the snippet and the link', async () => {
    stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);

    expect(await screen.findByText('POST /workflows/discharge-summary/runs')).toBeTruthy();
    expect(screen.getByText('async')).toBeTruthy();
    expect(screen.getByText('stream')).toBeTruthy();
    expect(screen.queryByText('socket')).toBeNull();
    expect(screen.getByRole('group', { name: /vox-node/i }).textContent).toContain('discharge-summary');
    expect((screen.getByRole('link', { name: /api keys/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/api-keys');
  });

  it('not active: explains and never fetches', () => {
    const fetchMock = stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" isActive={false} />);
    expect(screen.getByText(/published, not active/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-exposable palette: names the palette rule and never fetches', () => {
    const fetchMock = stubSchemaFetch();
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" exposable={false} paletteKey="stt" />);
    expect(screen.getByText(/not exposable/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 404 names the exposure gate rather than a retry', async () => {
    stubSchemaFetch(404);
    renderWithProviders(<IntegrationPanel kind="workflow" slug="discharge-summary" />);
    expect(await screen.findByText(/workflow exposure/i)).toBeTruthy();
  });
});
