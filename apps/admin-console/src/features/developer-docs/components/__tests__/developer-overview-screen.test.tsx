import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { DeveloperOverviewScreen } from '../developer-overview-screen';
import { SdkScreen } from '../sdk-screen';

/**
 * TASK-783 — the developer portal's prose screens.
 *
 * These carry the guidance a developer reads BEFORE the reference: the
 * credential classes, the error contract, and the two status codes whose
 * meaning here is not the obvious one (404-over-403 and the 428/412 OCC pair).
 * Getting those wrong in the docs is worse than omitting them, so they are
 * asserted rather than left to review.
 */

function stubHealth(version: string | null = '0.0.0-feat-loop.13e5e406'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      version === null ? new Response('nope', { status: 503 }) : Response.json({ status: 'healthy', service: 'api', version }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DeveloperOverviewScreen', () => {
  it('documents all three credential classes with the header each one uses', async () => {
    stubHealth();
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane={false} />);

    expect(await screen.findByText('X-API-Key: <key>')).toBeDefined();
    expect(screen.getByText('Authorization: Bearer <token>')).toBeDefined();
    expect(screen.getByText('X-Service-Account-Token: <token>')).toBeDefined();
  });

  it('states that an API key is rejected on the administration plane', () => {
    stubHealth();
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane={false} />);

    expect(screen.getByText(/Rejected with 403 on every \/admin route/i)).toBeDefined();
  });

  it('explains 404-over-403 rather than leaving it as "not found"', () => {
    stubHealth();
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane={false} />);

    expect(screen.getByText(/it belongs to another tenant/i)).toBeDefined();
  });

  it('explains the 428/412 optimistic-concurrency pair', () => {
    stubHealth();
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane={false} />);

    expect(screen.getByText(/requires If-Match and none was sent/i)).toBeDefined();
    expect(screen.getByText(/Never retry a 412 blindly/i)).toBeDefined();
  });

  it('shows the gateway build so a reader knows which deployment they are reading', async () => {
    stubHealth('0.0.0-feat-loop.13e5e406');
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane={false} />);

    expect(await screen.findByText(/Gateway build 0\.0\.0-feat-loop\.13e5e406/)).toBeDefined();
  });

  it('says the build is unavailable rather than showing a stale or invented one', async () => {
    stubHealth(null);
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane={false} />);

    expect(await screen.findByText(/Gateway build unavailable/)).toBeDefined();
  });

  it('reflects the caller’s plane entitlement in the footer', async () => {
    stubHealth();
    renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane />);

    expect(await screen.findByText('Business + administration planes')).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubHealth();
    const { container } = renderWithProviders(<DeveloperOverviewScreen canReadAdminPlane />);
    await screen.findByText('Your first call');

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SdkScreen', () => {
  it('separates the server SDK from the browser SDK', () => {
    renderWithProviders(<SdkScreen />);

    expect(screen.getByText('@arcaai/vox')).toBeDefined();
    expect(screen.getAllByText('@arcaai/vox-node').length).toBeGreaterThan(0);
    expect(screen.getByText(/Do not import it from server code/i)).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<SdkScreen />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
