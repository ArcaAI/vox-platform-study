/**
 * Platform Releases screen (TASK-648 §6). Built against the FROZEN contract
 * `docs/implementation/TASK-648-Service-Version-And-Release-Registry/
 * contracts/service-release.api.yaml` — the backend does not exist yet
 * (units U4/U5/U6 build it concurrently), so fetch is stubbed to that shape.
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { ReleasesScreen } from '../releases-screen';

const TAGGED_RELEASE = {
  id: 'rel-1',
  serviceName: 'smr',
  version: '2.1.0',
  releaseTag: 'SMR-2.1.0',
  gitBranch: 'dev-2.1',
  gitCommitSha: '0ab258f9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  buildAt: '2026-08-09T10:00:00.000Z',
  imageRepository: 'registry.example/smr',
  imageDigest: 'sha256:abcdef',
  ciPipelineUrl: 'https://gitlab.example/pipelines/1',
  changelog: [
    { type: 'feat', scope: 'TASK-643', ticket: 'TASK-643', subject: 'add funding attribution', sha: '0ab258f9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', breaking: false },
    { type: 'fix', scope: null, ticket: null, subject: 'correct rounding', sha: '1bef59c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', breaking: false },
  ],
};

const UNTAGGED_RELEASE = {
  id: 'rel-2',
  serviceName: 'api',
  version: '0.0.0-dev-2-1.0ab258f9',
  releaseTag: null,
  gitBranch: 'dev-2.1',
  gitCommitSha: '0ab258f9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  buildAt: '2026-08-09T09:00:00.000Z',
  imageRepository: 'registry.example/api',
  imageDigest: null,
  ciPipelineUrl: null,
  changelog: null,
};

const CURRENT = [
  {
    serviceName: 'smr',
    environment: 'dev',
    release: TAGGED_RELEASE,
    instanceCount: 2,
    liveness: 'live',
    startedAt: '2026-08-09T10:05:00.000Z',
    lastSeenAt: '2026-08-09T11:50:00.000Z',
  },
  {
    serviceName: 'api',
    environment: 'dev',
    release: UNTAGGED_RELEASE,
    instanceCount: 1,
    liveness: 'stale',
    startedAt: '2026-08-01T09:05:00.000Z',
    lastSeenAt: '2026-08-01T09:20:00.000Z',
  },
];

function stubFetch({ current = CURRENT, history = { data: [TAGGED_RELEASE, UNTAGGED_RELEASE], count: 2, limit: 50, page: 1 } } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/hope/admin/service-releases/current')) return Response.json(current);
      if (url.includes('/api/hope/admin/service-releases')) return Response.json(history);
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReleasesScreen', () => {
  it('renders a tagged release as its real version', async () => {
    stubFetch();
    renderWithProviders(<ReleasesScreen />);

    expect(await screen.findByText('2.1.0')).toBeDefined();
  });

  it('never renders an untagged build as a version number — outline badge with branch · sha8', async () => {
    stubFetch();
    renderWithProviders(<ReleasesScreen />);

    expect(await screen.findByText('dev-2.1 · 0ab258f9')).toBeDefined();
    expect(screen.queryByText('0.0.0-dev-2-1.0ab258f9')).toBeNull();
  });

  it('shows the drift banner when a service has no live instance', async () => {
    stubFetch();
    renderWithProviders(<ReleasesScreen />);

    expect(await screen.findByRole('alert')).toBeDefined();
  });

  it('opens the detail drawer with the Changes tab on row click', async () => {
    stubFetch();
    renderWithProviders(<ReleasesScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'smr' }));

    const dialog = await screen.findByRole('dialog');
    const changesTab = within(dialog).getByRole('tab', { name: 'Changes' });
    expect(changesTab).toBeDefined();

    // Radix tabs activate on focus (automatic activation) — focus then click mirrors a real click.
    fireEvent.focus(changesTab);
    fireEvent.click(changesTab);
    expect(await within(dialog).findByText('add funding attribution')).toBeDefined();
    expect(within(dialog).getByText('(TASK-643)')).toBeDefined();
  });

  it('shows an Empty state when no service has registered', async () => {
    stubFetch({ current: [], history: { data: [], count: 0, limit: 50, page: 1 } });
    renderWithProviders(<ReleasesScreen />);

    expect(await screen.findByText('No services registered')).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ReleasesScreen />);
    await screen.findByText('2.1.0');

    expect(await axe(container)).toHaveNoViolations();
  });
});
