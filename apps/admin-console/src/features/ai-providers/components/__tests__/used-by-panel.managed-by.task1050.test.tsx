/**
 * TASK-1050 W3c (OD-39) — `/guardrails/control` is the ONE editor of the `guardrail.*` routing keys. The
 * "Used by" panel lists them read-only, marked "Managed by Guardrail control", with a deep link there.
 */

import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { UsedByPanel } from '../used-by-panel';
import type { ResolvedProviderScope } from '../use-provider-scope';

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function binding(over: Record<string, unknown>) {
  return {
    id: 'cfg-1',
    tenantId: SYSTEM,
    taskKey: 'guardrail.judge.injection',
    taskKind: 'CONTENT_SAFETY',
    displayName: 'granite-guardian-4.1-8b',
    providerConnectionId: null,
    modelId: 'mdl-1',
    modelRef: null,
    isDefault: true,
    enabled: true,
    status: 'ACTIVE',
    priority: 0,
    managedBy: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UsedByPanel — guardrail-control managed rows', () => {
  it('marks a managedBy guardrail-control row read-only with a deep link, and leaves other rows plain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          binding({ id: 'cfg-g', managedBy: 'guardrail-control' }),
          binding({ id: 'cfg-n', taskKey: 'nlp.ner', displayName: 'gliner', managedBy: null }),
        ]),
      ),
    );
    const scope = { tier: 'platform', tenantId: SYSTEM, label: 'Platform', elevated: true, isLoading: false } as unknown as ResolvedProviderScope;
    renderWithProviders(<UsedByPanel scope={scope} />);

    const guardrailRow = (await screen.findByText('guardrail.judge.injection')).closest('tr') as HTMLElement;
    const link = within(guardrailRow).getByRole('link', { name: /Managed by Guardrail control/ });
    expect(link.getAttribute('href')).toBe('/guardrails/control');

    const nlpRow = screen.getByText('nlp.ner').closest('tr') as HTMLElement;
    expect(within(nlpRow).queryByRole('link')).toBeNull();
    // The panel itself offers no write control on any row.
    expect(screen.queryByRole('button')).toBeNull();
  });
});
