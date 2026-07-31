/**
 * Tenant "SMR models" section (TASK-588).
 *
 * Four `TaskDefaultCard`s (primary smr.live/smr.finalize + optional fallback
 * smr.live.fallback/smr.finalize.fallback), rendered in isolation. The load-
 * bearing behavior: `tenantId` is OMITTED on every card, so every gateway read
 * and OCC write is CLS-pinned to the caller's tenant — NO `tenantId` query
 * param ever appears on the wire.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { SMR_FALLBACK_TASK_KEYS, SMR_PRIMARY_TASK_KEYS } from '../../api/types';
import type { EffectiveAiTaskDefault, TaskModelOption } from '../../api/types';
import { SmrModelsSection } from '../smr-models-section';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

function effectiveOf(taskKey: string): EffectiveAiTaskDefault {
  return { tenantId: 'tnt-1', taskKey, modelSlug: null, source: null, configJson: null, model: null };
}

function option(): TaskModelOption {
  return {
    id: 'opt-gpt4o',
    name: 'GPT-4o',
    slug: 'gpt-4o',
    provider: 'openai',
    architecture: null,
    taskType: 'TEXT_GENERATION',
    format: 'API',
    sourceUri: 'gpt-4o',
    resourceStatus: 'ENABLED',
  };
}

function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = String(input);
      urls.push(raw);
      const url = new URL(raw, 'http://test.local');
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/row') {
        const taskKey = url.searchParams.get('taskKey') as string;
        return Response.json({ tenantId: 'tnt-1', taskKey, modelSlug: null, version: 0 });
      }
      if (method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults/options') {
        return Response.json([option()]);
      }
      if (method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults') {
        return Response.json(effectiveOf(url.searchParams.get('taskKey') as string));
      }
      throw new Error(`Unhandled fetch: ${method} ${raw}`);
    }),
  );
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SmrModelsSection', () => {
  it('renders one editable card per SMR key (primary + fallback), each with a picker and an If-Match save', async () => {
    stubFetch();
    renderWithProviders(<SmrModelsSection />);

    for (const key of [...SMR_PRIMARY_TASK_KEYS, ...SMR_FALLBACK_TASK_KEYS]) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    expect((await screen.findAllByRole('combobox')).length).toBe(4);
    expect((await screen.findAllByRole('button', { name: /save .* if-match/i })).length).toBe(4);
  });

  it('groups the cards Primary / Fallback and marks fallback optional', async () => {
    stubFetch();
    renderWithProviders(<SmrModelsSection />);

    expect(await screen.findByRole('heading', { name: /Primary models/i })).toBeDefined();
    expect(await screen.findByRole('heading', { name: /Fallback models/i })).toBeDefined();
    expect(await screen.findByText(/\(optional\)/i)).toBeDefined();
    expect((await screen.findAllByText(/when the primary .* provider fails/i)).length).toBe(SMR_FALLBACK_TASK_KEYS.length);
    expect(await screen.findByText(/an empty fallback means no fallback provider runs/i)).toBeDefined();
  });

  it('is CLS-pinned — no request carries a tenantId query param (writes target the caller tenant)', async () => {
    const urls = stubFetch();
    renderWithProviders(<SmrModelsSection />);

    await screen.findAllByRole('combobox');
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(4 * 3));
    for (const raw of urls) {
      expect(new URL(raw, 'http://test.local').searchParams.has('tenantId')).toBe(false);
    }
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<SmrModelsSection />);

    await screen.findAllByRole('combobox');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
