/**
 * UserPicker (TASK-973 L2): the combobox already sent `search` +
 * `searchFields=username` to GET admin/users on every keystroke — a real,
 * working server-side filter (verified against
 * packages/database/src/prisma/db_main/user.prisma:64 `username String
 * @unique`, and users-list-screen.tsx's own USER_SEARCH_FIELDS). The only
 * gap was the missing 300ms debounce required by the house pattern
 * (departments-screen.tsx:60-70) — this locks that fix in place.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { UserPicker } from '../user-picker';

const PICKER_USER = { id: 'user-1', username: 'admin.acme', isServiceAccount: false };

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (!url.includes('/api/hope/admin/users')) throw new Error(`Unhandled fetch: ${url}`);
      return Response.json({ data: [PICKER_USER], count: 1, limit: 10, page: 0 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe('UserPicker', () => {
  it('debounces the search 300ms before hitting GET admin/users', async () => {
    const calls = stubFetch();
    renderWithProviders(<UserPicker value={null} onChange={() => {}} />);

    fireEvent.click(screen.getByRole('combobox'));
    const input = await screen.findByPlaceholderText(/search users by username…/i);
    // Opening the popover fires the initial (empty-search) query.
    await waitFor(() => expect(calls.length).toBe(1));

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: 'admin' } });
    // Still just the initial call — the keystroke has not hit the server yet.
    expect(calls.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(calls.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]?.url).toContain('search=admin');
    expect(calls[1]?.url).toContain('searchFields=username');
  });

  it('does not fire one request per keystroke', async () => {
    const calls = stubFetch();
    renderWithProviders(<UserPicker value={null} onChange={() => {}} />);

    fireEvent.click(screen.getByRole('combobox'));
    const input = await screen.findByPlaceholderText(/search users by username…/i);
    await waitFor(() => expect(calls.length).toBe(1));

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: 'a' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(input, { target: { value: 'ad' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(input, { target: { value: 'adm' } });

    // Each keystroke re-armed the 300ms timer, so 200ms after the last one
    // still nothing new has been sent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(calls.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    vi.useRealTimers();

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]?.url).toContain('search=adm');
  });
});
