import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceProbe } from '../../api';
import { DevServiceDownHint } from '../dev-service-down-hint';

afterEach(cleanup);

function probes(entries: Record<string, string>): Record<string, ServiceProbe> {
  return Object.fromEntries(Object.entries(entries).map(([key, status]) => [key, { status, service: key }]));
}

describe('DevServiceDownHint', () => {
  it('points the developer at pnpm dev:doctor and names the down service', () => {
    render(<DevServiceDownHint enabled services={probes({ smr: 'healthy', harness: 'down' })} />);

    expect(screen.getByText(/pnpm dev:doctor/)).toBeDefined();
    // names the offending service, not the healthy one
    const hint = screen.getByRole('status');
    expect(hint.textContent).toContain('harness');
    expect(hint.textContent).not.toContain('smr');
  });

  it('treats "unhealthy" the same as "down"', () => {
    render(<DevServiceDownHint enabled services={probes({ nlp: 'unhealthy' })} />);

    expect(screen.getByText(/pnpm dev:doctor/)).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('nlp');
  });

  it('renders nothing when every service is healthy or degraded', () => {
    const { container } = render(<DevServiceDownHint enabled services={probes({ smr: 'healthy', harness: 'degraded' })} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/pnpm dev:doctor/)).toBeNull();
  });

  it('renders nothing when disabled (production gate) even with a service down', () => {
    const { container } = render(<DevServiceDownHint enabled={false} services={probes({ harness: 'down' })} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/pnpm dev:doctor/)).toBeNull();
  });
});
