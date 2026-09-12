import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { MonitoringScreen } from '../monitoring-screen';

// recharts' ResponsiveContainer relies on layout measurement that happy-dom
// lacks; inject a fixed size so MetricChart actually draws (standard shim).
// recharts is a transitive dep (via @arcaai/ui), so its types are not
// resolvable from this app — keep the module shape untyped.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      React.cloneElement(children, { width: 800, height: 300 }),
  };
});

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = new Date().toISOString();

function heartbeats(upCount: number, downCount: number) {
  return [
    ...Array.from({ length: upCount }, (_, i) => ({ timestamp: NOW, status: 'up' as const, responseTime: 40 + i })),
    ...Array.from({ length: downCount }, () => ({ timestamp: NOW, status: 'down' as const, responseTime: 0 })),
  ];
}

const HEALTH = {
  status: 'degraded',
  timestamp: NOW,
  services: {
    text: { status: 'healthy', service: 'Text', uptime_seconds: 86_400, duration_ms: 210 },
    stt: { status: 'healthy', service: 'Speech to Text', duration_ms: 118 },
    tts: { status: 'healthy', service: 'Text to Speech', duration_ms: 104 },
    nlp: { status: 'healthy', service: 'Medical NLP', duration_ms: 88 },
    guardrail: { status: 'healthy', service: 'Guardrail', duration_ms: 65 },
    harness: { status: 'degraded', service: 'Clinical Documentation Harness', error: 'exports depth 117' },
  },
};

const UPTIME = {
  services: {
    text: { status: 'healthy', uptime: 99.97, responseTime: 210, lastCheck: NOW, heartbeats: heartbeats(20, 0) },
    stt: { status: 'healthy', uptime: 99.4, responseTime: 118, lastCheck: NOW, heartbeats: heartbeats(19, 1) },
    tts: { status: 'healthy', uptime: 99.1, responseTime: 104, lastCheck: NOW, heartbeats: heartbeats(18, 2) },
    harness: { status: 'degraded', uptime: 97.2, responseTime: 2_140, lastCheck: NOW, heartbeats: heartbeats(15, 5) },
  },
  refreshedAt: NOW,
};

const SESSIONS = {
  services: { text: { active: 12 }, stt: { active: 7 }, tts: { active: 5 }, nlp: { active: 3 }, guardrail: { active: 0 }, harness: { active: 1 } },
  totalUsers: 19,
  refreshedAt: NOW,
};

const REDIS = {
  status: 'healthy',
  latencyMs: 3,
  connectedClients: 12,
  usedMemory: '18.4M',
  uptime: 864_000,
  version: '8.0.1',
  queuesRegistered: 5,
};

type RouteOverrides = Partial<Record<'health' | 'uptime' | 'sessions' | 'redis', () => Response>>;

function installFetch(overrides: RouteOverrides = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('admin/health/services')) return (overrides.health ?? (() => Response.json(HEALTH)))();
    if (url.includes('admin/monitoring/uptime')) return (overrides.uptime ?? (() => Response.json(UPTIME)))();
    if (url.includes('admin/monitoring/sessions')) return (overrides.sessions ?? (() => Response.json(SESSIONS)))();
    if (url.includes('admin/queues/health/redis')) return (overrides.redis ?? (() => Response.json(REDIS)))();
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof installFetch>, fragment: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}

describe('MonitoringScreen', () => {
  // TASK-954 — the screen is shared with tenant admins, who hold every read on
  // it except Redis health (`manage:all`). The route passes `platformOps={false}`
  // for them: no Redis tile, no Redis card, and no request that can only 403.
  it('omits the Redis surfaces and never reads admin/queues/health/redis on a tenant-scoped screen', async () => {
    const fetchMock = installFetch();
    renderWithProviders(<MonitoringScreen platformOps={false} />);

    const stats = await screen.findByRole('region', { name: /key metrics/i });
    expect(await within(stats).findByText('5/6')).toBeDefined();
    expect(within(stats).getByText('Active sessions')).toBeDefined();
    expect(within(stats).queryByText('Redis latency')).toBeNull();
    expect(screen.queryByRole('region', { name: /redis health/i })).toBeNull();
    // The sessions card is served to a tenant admin and still renders.
    expect(await screen.findByRole('list', { name: /active sessions by service/i })).toBeDefined();
    await waitFor(() => expect(callsTo(fetchMock, 'admin/monitoring/sessions')).toBeGreaterThan(0));
    expect(callsTo(fetchMock, 'admin/queues/health/redis')).toBe(0);
  });

  it('renders the four monitoring stat tiles from health, uptime, sessions and redis', async () => {
    installFetch();
    renderWithProviders(<MonitoringScreen />);

    const stats = await screen.findByRole('region', { name: /key metrics/i });
    expect(await within(stats).findByText('5/6')).toBeDefined();
    expect(within(stats).getByText('Services healthy')).toBeDefined();
    // Lowest uptime across monitored services — never an invented SLO.
    expect(within(stats).getByText('97.2%')).toBeDefined();
    expect(within(stats).getByText('Lowest uptime')).toBeDefined();
    expect(within(stats).getByText('28')).toBeDefined();
    expect(within(stats).getByText('Active sessions')).toBeDefined();
    expect(within(stats).getByText('3 ms')).toBeDefined();
    expect(within(stats).getByText('Redis latency')).toBeDefined();
  });

  it('renders a service health card per probed service with uptime and heartbeat history', async () => {
    installFetch();
    renderWithProviders(<MonitoringScreen />);

    const grid = await screen.findByRole('list', { name: /service health/i });
    const cards = within(grid).getAllByRole('listitem');
    expect(cards.length).toBe(6);
    expect(within(grid).getByText('Clinical Documentation Harness')).toBeDefined();
    expect(within(grid).getByText('Medical NLP')).toBeDefined();
    expect(within(grid).getByText('Degraded')).toBeDefined();
    expect(within(grid).getByText('exports depth 117')).toBeDefined();
    expect(within(grid).getByText('99.97%')).toBeDefined();
    expect(within(grid).getByText('15 of 20 recent checks up')).toBeDefined();
    expect(within(screen.getByRole('table')).getByText('Text')).toBeDefined();
  });

  it('renders redis health facts and per-service session counts', async () => {
    installFetch();
    renderWithProviders(<MonitoringScreen />);

    const redis = await screen.findByRole('region', { name: /redis health/i });
    expect(await within(redis).findByText('Healthy')).toBeDefined();
    expect(within(redis).getByText('18.4M')).toBeDefined();
    expect(within(redis).getByText('8.0.1')).toBeDefined();

    const sessions = screen.getByRole('list', { name: /active sessions by service/i });
    expect(within(sessions).getByText('12')).toBeDefined();
    expect(within(sessions).getByText('Text')).toBeDefined();
    expect(screen.getByText(/19 unique users/i)).toBeDefined();
  });

  it('shows loading skeletons that mirror the layout while queries are in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<MonitoringScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('Services healthy')).toBeNull();
  });

  it('shows a block error with retry when uptime fails with no cached data', async () => {
    const fetchMock = installFetch({
      uptime: () => Response.json({ statusCode: 503, message: 'Service unavailable' }, { status: 503 }),
    });
    renderWithProviders(<MonitoringScreen />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(callsTo(fetchMock, 'admin/monitoring/uptime')).toBe(1);

    fireEvent.click(within(alerts[0]).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(callsTo(fetchMock, 'admin/monitoring/uptime')).toBe(2));
  });

  it('renders uptime samples in the response chart when service health fails', async () => {
    installFetch({
      health: () => Response.json({ statusCode: 503, message: 'Service unavailable' }, { status: 503 }),
    });
    renderWithProviders(<MonitoringScreen />);

    const chart = await screen.findByRole('table');
    expect(within(chart).getByText('text')).toBeDefined();
    expect(within(chart).getByText('210 ms')).toBeDefined();
  });

  it('surfaces the dev:doctor hint when a service is genuinely down (not-listening)', async () => {
    installFetch({
      health: () =>
        Response.json({
          ...HEALTH,
          status: 'degraded',
          services: {
            ...HEALTH.services,
            harness: { status: 'down', service: 'harness', error: 'connect ECONNREFUSED 127.0.0.1:8866' },
          },
        }),
    });
    renderWithProviders(<MonitoringScreen />);

    const hint = await screen.findByRole('status', { name: /service not responding/i });
    expect(within(hint).getByText(/pnpm dev:doctor/)).toBeDefined();
    expect(hint.textContent).toContain('harness');
  });

  it('does not show the dev:doctor hint when no service is down', async () => {
    installFetch();
    renderWithProviders(<MonitoringScreen />);

    // default fixture: harness is degraded (up, slow), never down
    await screen.findByRole('list', { name: /service health/i });
    expect(screen.queryByText(/pnpm dev:doctor/)).toBeNull();
  });

  it('renders empty states when no services report and no samples exist', async () => {
    installFetch({
      health: () => Response.json({ ...HEALTH, status: 'unknown', services: {} }),
      uptime: () => Response.json({ services: {}, refreshedAt: NOW }),
    });
    renderWithProviders(<MonitoringScreen />);

    expect(await screen.findByText('No services reporting')).toBeDefined();
    expect(screen.getByText('No samples in window')).toBeDefined();
  });
});
