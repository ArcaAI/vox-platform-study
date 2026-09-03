/**
 * Tenant "Text models" section.
 *
 * Four `TaskDefaultCard`s (primary text.live/text.finalize + optional fallback
 * text.live.fallback/text.finalize.fallback), rendered in isolation. The load-
 * bearing behavior: `tenantId` is OMITTED on every card, so every gateway read
 * and OCC write is CLS-pinned to the caller's tenant — NO `tenantId` query
 * param ever appears on the wire.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { TEXT_FALLBACK_TASK_KEYS, TEXT_PRIMARY_TASK_KEYS, TEXT_TEST_TASK_KEYS } from '../../api/types';
import type { EffectiveAiTaskDefault, TaskModelOption } from '../../api/types';
import { TextModelsSection } from '../text-models-section';

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

describe('TextModelsSection', () => {
  it('renders one editable card per text-generation key (primary + fallback), each with a picker and an If-Match save', async () => {
    stubFetch();
    renderWithProviders(<TextModelsSection />);

    // TEXT_TEST_TASK_KEYS is included: gave `text.test` its own
    // "Prompt test bench" section and card, but this loop still only walked
    // primary+fallback, so the new card was never asserted on.
    for (const key of [...TEXT_PRIMARY_TASK_KEYS, ...TEXT_TEST_TASK_KEYS, ...TEXT_FALLBACK_TASK_KEYS]) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    // 5 per-key card pickers (2 primary + 1 test bench + 2 fallback)
    // + 2 default-control pickers (primary + fallback).
    expect((await screen.findAllByRole('combobox')).length).toBe(7);
    expect((await screen.findAllByRole('button', { name: /save .* if-match/i })).length).toBe(5);
  });

  it('renders the one-action default text-generation provider control above the per-key cards', async () => {
    stubFetch();
    renderWithProviders(<TextModelsSection />);

    expect(await screen.findByRole('heading', { name: /Default text-generation provider/i })).toBeDefined();
    expect(await screen.findByRole('button', { name: /apply the default text-generation provider/i })).toBeDefined();
    // Copy is honest that the tenant-editable text-gen surface is summarization only.
    expect(await screen.findByText(/this default covers summarization/i)).toBeDefined();
  });

  it('groups the cards Primary / Fallback and marks fallback optional', async () => {
    stubFetch();
    renderWithProviders(<TextModelsSection />);

    expect(await screen.findByRole('heading', { name: /Primary models/i })).toBeDefined();
    expect(await screen.findByRole('heading', { name: /Fallback models/i })).toBeDefined();
    expect(await screen.findByText(/\(optional\)/i)).toBeDefined();
    expect((await screen.findAllByText(/when the primary .* provider fails/i)).length).toBe(TEXT_FALLBACK_TASK_KEYS.length);
    expect(await screen.findByText(/an empty fallback means no fallback provider runs/i)).toBeDefined();
  });

  it('is CLS-pinned — no request carries a tenantId query param (writes target the caller tenant)', async () => {
    const urls = stubFetch();
    renderWithProviders(<TextModelsSection />);

    await screen.findAllByRole('combobox');
    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(4 * 3));
    for (const raw of urls) {
      expect(new URL(raw, 'http://test.local').searchParams.has('tenantId')).toBe(false);
    }
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<TextModelsSection />);

    await screen.findAllByRole('combobox');
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
