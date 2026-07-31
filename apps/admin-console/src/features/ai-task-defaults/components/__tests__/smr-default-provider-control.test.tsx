/**
 * "Default text-generation provider" control (TASK-592).
 *
 * A convenience writer over the EXISTING per-key `PUT
 * admin/ai-task-defaults/row?taskKey=` endpoint. The load-bearing behavior: one
 * model choice fans out to `smr.live` + `smr.finalize` (primary), an optional
 * fallback fans out to their `.fallback` keys, every write is OCC (If-Match) and
 * CLS-pinned (no `tenantId` on the wire).
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { TaskModelOption } from '../../api/types';
import { SmrDefaultProviderControl } from '../smr-default-provider-control';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** Open a Radix Select trigger and pick an option by its visible label. */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(option);
}

function option(name: string, slug: string): TaskModelOption {
  return {
    id: `opt-${slug}`,
    name,
    slug,
    provider: 'openai',
    architecture: null,
    taskType: 'TEXT_GENERATION',
    format: 'API',
    sourceUri: slug,
    resourceStatus: 'ENABLED',
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubFetch(): RecordedCall[] {
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
      const url = new URL(call.url, 'http://test.local');
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/row') {
        const taskKey = url.searchParams.get('taskKey') as string;
        // No ETag → version 0 → create path (If-Match "0").
        return Response.json({ tenantId: 'tnt-1', taskKey, modelSlug: null, version: 0 });
      }
      if (call.method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/options') {
        return Response.json([option('GPT-4o', 'gpt-4o'), option('Claude', 'claude-3-5')]);
      }
      if (call.method === 'PUT' && url.pathname === '/api/hope/admin/ai-task-defaults/row') {
        const taskKey = url.searchParams.get('taskKey') as string;
        return Response.json({ tenantId: 'tnt-1', taskKey, modelSlug: 'gpt-4o', version: 1 }, { headers: { etag: '"1"' } });
      }
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SmrDefaultProviderControl', () => {
  it('keeps Apply disabled until a primary model is chosen', async () => {
    stubFetch();
    renderWithProviders(<SmrDefaultProviderControl />);

    const apply = await screen.findByRole('button', { name: /apply the default text-generation provider/i });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it('applies one primary model to smr.live + smr.finalize with If-Match, and no fallback writes', async () => {
    const calls = stubFetch();
    renderWithProviders(<SmrDefaultProviderControl />);

    const primary = await screen.findByLabelText(/default provider\/model for text generation/i);
    await selectOption(primary, /GPT-4o/);
    fireEvent.click(screen.getByRole('button', { name: /apply the default text-generation provider/i }));

    await waitFor(() => {
      const puts = calls.filter((c) => c.method === 'PUT');
      expect(puts.length).toBe(2);
    });
    const puts = calls.filter((c) => c.method === 'PUT');
    const keys = puts.map((p) => new URL(p.url, 'http://test.local').searchParams.get('taskKey')).sort();
    expect(keys).toEqual(['smr.finalize', 'smr.live']);
    for (const put of puts) {
      expect(put.headers.get('if-match')).toBe('"0"');
      expect((put.body as Record<string, unknown>).expectedVersion).toBe(0);
      expect((put.body as Record<string, unknown>).modelSlug).toBe('gpt-4o');
    }
  });

  it('also writes the two fallback keys when a fallback model is chosen', async () => {
    const calls = stubFetch();
    renderWithProviders(<SmrDefaultProviderControl />);

    await selectOption(await screen.findByLabelText(/default provider\/model for text generation/i), /GPT-4o/);
    await selectOption(await screen.findByLabelText(/default fallback provider\/model/i), /Claude/);
    fireEvent.click(screen.getByRole('button', { name: /apply the default text-generation provider/i }));

    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').length).toBe(4));
    const keys = calls
      .filter((c) => c.method === 'PUT')
      .map((p) => new URL(p.url, 'http://test.local').searchParams.get('taskKey'))
      .sort();
    expect(keys).toEqual(['smr.finalize', 'smr.finalize.fallback', 'smr.live', 'smr.live.fallback']);
  });

  it('is CLS-pinned — no request carries a tenantId query param', async () => {
    const calls = stubFetch();
    renderWithProviders(<SmrDefaultProviderControl />);

    await selectOption(await screen.findByLabelText(/default provider\/model for text generation/i), /GPT-4o/);
    fireEvent.click(screen.getByRole('button', { name: /apply the default text-generation provider/i }));

    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').length).toBe(2));
    for (const call of calls) {
      expect(new URL(call.url, 'http://test.local').searchParams.has('tenantId')).toBe(false);
    }
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<SmrDefaultProviderControl />);

    await screen.findByRole('button', { name: /apply the default text-generation provider/i });
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
