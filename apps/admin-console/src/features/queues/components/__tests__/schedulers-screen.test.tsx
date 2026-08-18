import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { SchedulerInfo } from '../../api/types';
import { SchedulersScreen } from '../schedulers-screen';
import { installFetchStub, type FetchHandler, type RecordedCall } from './fetch-stub';

/** Layout persistence reads GET users/me/settings on mount; tests have no saved layout. */
function stubFetch(handle: FetchHandler): RecordedCall[] {
  return installFetchStub((call) => {
    if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? [] : { success: true };
    return handle(call);
  });
}

const SCHEDULERS: SchedulerInfo[] = [
  {
    name: 'audit-retention-prune',
    type: 'cron',
    source: 'static',
    cronExpression: '0 3 * * 0',
    intervalMs: null,
    running: true,
    lastExecution: new Date(Date.now() - 3_600_000).toISOString(),
    nextExecution: new Date(Date.now() + 3_600_000).toISOString(),
    timeZone: 'UTC',
    settingsKey: 'scheduler.audit-retention-prune',
  },
  {
    name: 'usage-rollup-hourly',
    type: 'interval',
    source: 'dynamic',
    cronExpression: null,
    intervalMs: 3_600_000,
    running: false,
    lastExecution: null,
    nextExecution: null,
    timeZone: null,
    settingsKey: null,
  },
];

const LIST_URL = '/api/hope/admin/schedulers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SchedulersScreen', () => {
  it('renders the schedulers table with cron expressions and status', async () => {
    stubFetch(({ url }) => (url === LIST_URL ? SCHEDULERS : undefined));
    renderWithProviders(<SchedulersScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Schedulers' })).toBeDefined();
    expect(await screen.findByText('audit-retention-prune')).toBeDefined();
    expect(screen.getByText('0 3 * * 0')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Paused')).toBeDefined();
    expect(screen.getByRole('grid', { name: 'Schedulers' })).toBeDefined();
  });

  it('shows a neutral empty state when no schedules exist', async () => {
    stubFetch(({ url }) => (url === LIST_URL ? [] : undefined));
    renderWithProviders(<SchedulersScreen />);
    expect(await screen.findByText('No schedules defined')).toBeDefined();
  });

  it('updates a cron expression through the edit dialog', async () => {
    const calls = stubFetch(({ url }) => (url === LIST_URL ? SCHEDULERS : undefined));
    renderWithProviders(<SchedulersScreen />);
    await screen.findByText('audit-retention-prune');
    fireEvent.click(screen.getByRole('button', { name: 'Edit cron for audit-retention-prune' }));
    const input = await screen.findByLabelText('Cron expression');
    fireEvent.change(input, { target: { value: '0 4 * * 0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/schedulers/audit-retention-prune/cron')).toBe(true),
    );
    const patch = calls.find((call) => call.url.endsWith('/cron'));
    expect(patch?.body).toEqual({ cronExpression: '0 4 * * 0' });
  });

  it('disables a running scheduler via the switch after confirmation', async () => {
    const calls = stubFetch(({ url }) => (url === LIST_URL ? SCHEDULERS : undefined));
    renderWithProviders(<SchedulersScreen />);
    await screen.findByText('audit-retention-prune');
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle audit-retention-prune' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable scheduler' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/schedulers/audit-retention-prune/toggle')).toBe(true),
    );
    const toggle = calls.find((call) => call.url.endsWith('/toggle'));
    expect(toggle?.body).toEqual({ enabled: false });
  });

  it('enables a paused scheduler without confirmation', async () => {
    const calls = stubFetch(({ url }) => (url === LIST_URL ? SCHEDULERS : undefined));
    renderWithProviders(<SchedulersScreen />);
    await screen.findByText('usage-rollup-hourly');
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle usage-rollup-hourly' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PATCH' && call.url === '/api/hope/admin/schedulers/usage-rollup-hourly/toggle')).toBe(true),
    );
    const toggle = calls.find((call) => call.url.endsWith('/toggle'));
    expect(toggle?.body).toEqual({ enabled: true });
  });
});
