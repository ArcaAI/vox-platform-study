/**
 * Platform-managed text-gen read-only summary (TASK-592).
 *
 * One `GET admin/ai-task-defaults` round-trip; every locked (guardrail/nlp/
 * harness) key rendered read-only with a "global admin" badge and a plain-href
 * deep link to the tenant-accessible Effective models view. No pickers, no save.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { READ_ONLY_TASK_KEYS } from '../../api/types';
import type { EffectiveAiTaskDefault } from '../../api/types';
import { PlatformManagedTextGenSummary } from '../platform-managed-textgen-summary';

function effectiveOf(taskKey: string): EffectiveAiTaskDefault {
  return {
    tenantId: 'tnt-1',
    taskKey,
    modelSlug: `${taskKey}-model`,
    source: 'system',
    configJson: null,
    model: {
      id: `m-${taskKey}`,
      slug: `${taskKey}-model`,
      name: `Model for ${taskKey}`,
      provider: 'lm-studio',
      architecture: null,
      taskType: 'TEXT_GENERATION',
      format: 'GGUF',
      sourceUri: `${taskKey}-model`,
    },
  };
}

function stubFetch(fail = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/api/hope/admin/ai-task-defaults') {
        if (fail) return new Response('boom', { status: 500 });
        return Response.json(READ_ONLY_TASK_KEYS.map((key) => effectiveOf(key)));
      }
      throw new Error(`Unhandled fetch: ${method} ${String(input)}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlatformManagedTextGenSummary', () => {
  it('renders every locked key read-only, each controlled by a global admin', async () => {
    stubFetch();
    renderWithProviders(<PlatformManagedTextGenSummary />);

    for (const key of READ_ONLY_TASK_KEYS) {
      expect(await screen.findByText(key)).toBeDefined();
    }
    expect((await screen.findAllByText('global admin')).length).toBe(READ_ONLY_TASK_KEYS.length);
    // Read-only: no pickers, no save controls.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('deep-links to the tenant-accessible Effective models view', async () => {
    stubFetch();
    renderWithProviders(<PlatformManagedTextGenSummary />);

    const link = await screen.findByRole('link', { name: /view all effective models/i });
    expect(link.getAttribute('href')).toBe('/ai-configuration');
  });

  it('surfaces an error state with retry when the read fails', async () => {
    stubFetch(true);
    renderWithProviders(<PlatformManagedTextGenSummary />);

    expect(await screen.findByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<PlatformManagedTextGenSummary />);

    await screen.findByText(READ_ONLY_TASK_KEYS[0]);
    await waitFor(async () => expect(await axe(container)).toHaveNoViolations());
  });
});
