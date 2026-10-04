/**
 * TASK-1036 §3.5 — the workflow settings dialog: connections, sources and the context schema,
 * with the implications (WF-SET-001..004) applied LIVE — an implied connection is checked and
 * locked with its reason — and saved into `graph.settings` through the store (undoable, dirty).
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { useEffect, type ReactNode } from 'react';
import { renderWithProviders } from '@/test/render';
import { GraphStoreProvider, useGraphStoreApi } from '../../../store';
import type { GraphStoreNode } from '../../../store/types';
import { toast } from 'sonner';
import { SettingsDialog } from '../settings-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../api/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks')>();
  return { ...actual, useAgentOptions: () => ({ data: [{ slug: 'asr', name: 'ASR', task: 'SPEECH_TO_TEXT' }] }) };
});

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}

const holder: { api: ReturnType<typeof useGraphStoreApi> | null } = { api: null };
function Capture({ children }: { children: ReactNode }) {
  const storeApi = useGraphStoreApi();
  useEffect(() => {
    holder.api = storeApi;
  }, [storeApi]);
  return <>{children}</>;
}

function mount(readOnly = false) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <GraphStoreProvider>
      <Capture>
        <SettingsDialog open onOpenChange={onOpenChange} readOnly={readOnly} />
      </Capture>
    </GraphStoreProvider>,
  );
  act(() => holder.api?.getState().hydrate([node('t', 'core.trigger'), node('a', 'core.agent', { agentRef: { slug: 'asr' } }), node('o', 'core.output')], [], { connections: ['api'], sources: [] }));
  return { ...view, onOpenChange };
}

const checkbox = (name: RegExp) => screen.getByRole('checkbox', { name });

describe('SettingsDialog', () => {
  it('locks an implied connection with the reason (an ASR step needs the socket)', () => {
    mount();
    expect(checkbox(/^socket/i).getAttribute('data-state')).toBe('checked');
    expect(checkbox(/^socket/i).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/transcribes speech/)).toBeTruthy();
  });

  it('applies implications live: turning on SSE keeps API locked on', () => {
    mount();
    fireEvent.click(checkbox(/^live stream/i));
    expect(checkbox(/^api/i).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Streaming a run \(SSE\) needs the API connection/)).toBeTruthy();
  });

  it('a consultation source lifts the ASR socket rule (Q6)', () => {
    mount();
    fireEvent.click(checkbox(/^consultation/i));
    expect(checkbox(/^socket/i).hasAttribute('disabled')).toBe(false);
  });

  it('saves the closed settings into graph.settings (undoable, dirty) and closes', () => {
    const { onOpenChange } = mount();
    fireEvent.click(checkbox(/^webhook/i));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(holder.api?.getState().settings).toEqual({ connections: ['api', 'webhook', 'socket'], sources: [] });
    expect(holder.api?.getState().dirty).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('is read-only on a published version', () => {
    mount(true);
    expect(checkbox(/^webhook/i).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
  });

  it('has no axe violations', async () => {
    mount();
    // The dialog itself (Radix's focus-guard spans outside it are a known jsdom-era false positive).
    expect(await axe(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });
});

describe('SettingsDialog — Save feedback (E4b)', () => {
  it('toasts success after saving into the graph', () => {
    vi.mocked(toast.success).mockClear();
    mount();
    fireEvent.click(checkbox(/^webhook/i));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/workflow settings saved/i));
  });

  it('toasts the failure, keeps the dialog open and writes nothing when the store refuses the settings', () => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    const { onOpenChange } = mount();
    vi.spyOn(holder.api!.getState(), 'setSettings').mockImplementation(() => {
      throw new Error('refused');
    });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/could not save the workflow settings/i));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

