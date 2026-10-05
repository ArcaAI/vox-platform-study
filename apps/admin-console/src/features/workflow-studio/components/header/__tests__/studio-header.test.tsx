/**
 * `StudioHeader` — TASK-1036 §3.6: the workflow's identity and lifecycle strip.
 *
 * Name (inline rename), slug with a copy control that says "Copied", the lifecycle badge, the
 * version count that opens the history sheet, the Pins rail (what each agent step is pinned to),
 * Settings, Validate and Publish. Publish stays disabled — with the REASON on screen — until the
 * caller says the SERVER-stored report is clean; the header never judges that itself.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { StudioHeader, type StudioHeaderProps } from '../studio-header';
import { collectAgentPins } from '../agent-pins';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

function props(overrides: Partial<StudioHeaderProps> = {}): StudioHeaderProps {
  return {
    name: 'Discharge Summary',
    onNameChange: vi.fn(),
    slug: 'discharge_summary',
    status: 'DRAFT',
    versionNumber: 3,
    versionCount: 5,
    onOpenHistory: vi.fn(),
    pins: [],
    onOpenSettings: vi.fn(),
    onValidate: vi.fn(),
    onPublish: vi.fn(),
    publishDisabledReason: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('StudioHeader — identity', () => {
  it('shows the name as the one h1, the slug in mono, and the lifecycle badge as text', () => {
    render(<StudioHeader {...props()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Discharge Summary' })).toBeTruthy();
    expect(screen.getByText('discharge_summary')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
  });

  it('renames inline: click, type, Enter commits the trimmed name', () => {
    const onNameChange = vi.fn();
    render(<StudioHeader {...props({ onNameChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
    const input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: '  Discharge Summary v2 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNameChange).toHaveBeenCalledWith('Discharge Summary v2');
    expect(screen.queryByRole('textbox', { name: 'Workflow name' })).toBeNull();
  });

  it('commits on blur, and Escape cancels without a change', () => {
    const onNameChange = vi.fn();
    render(<StudioHeader {...props({ onNameChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
    let input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: 'Other' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onNameChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
    input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: 'Blurred' } });
    fireEvent.blur(input);
    expect(onNameChange).toHaveBeenCalledWith('Blurred');
  });

  it('refuses an empty name — the old one stays', () => {
    const onNameChange = vi.fn();
    render(<StudioHeader {...props({ onNameChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Discharge Summary/ }));
    const input = screen.getByRole('textbox', { name: 'Workflow name' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNameChange).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Discharge Summary' })).toBeTruthy();
  });

  it('is not renameable on a read-only version', () => {
    render(<StudioHeader {...props({ readOnly: true, status: 'PUBLISHED' })} />);
    expect(screen.queryByRole('button', { name: /Discharge Summary/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Discharge Summary' })).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
  });

  it('copies the slug and says Copied, then settles back', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<StudioHeader {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy slug' }));
    });
    expect(writeText).toHaveBeenCalledWith('discharge_summary');
    expect(screen.getByRole('status').textContent).toBe('Copied');
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('StudioHeader — versions, pins, settings', () => {
  it('shows the version count and opens the history sheet', () => {
    const onOpenHistory = vi.fn();
    render(<StudioHeader {...props({ onOpenHistory })} />);
    const button = screen.getByRole('button', { name: /version history/i });
    expect(button.textContent).toContain('5 versions');
    fireEvent.click(button);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it('says "1 version" in the singular and still opens history while the count loads', () => {
    const { rerender } = render(<StudioHeader {...props({ versionCount: 1 })} />);
    expect(screen.getByRole('button', { name: /version history/i }).textContent).toContain('1 version');
    expect(screen.getByRole('button', { name: /version history/i }).textContent).not.toContain('versions');
    rerender(<StudioHeader {...props({ versionCount: null })} />);
    expect(screen.getByRole('button', { name: /version history/i })).toBeTruthy();
  });

  it('lists each agent step with its pin, or "active at publish", and that prompts ride with the agent', () => {
    render(
      <StudioHeader
        {...props({
          pins: [
            { nodeId: 'a1', nodeLabel: 'Summarize', agentSlug: 'discharge-agent', versionNumber: 4 },
            { nodeId: 'a2', nodeLabel: 'Extract', agentSlug: 'extract-agent', versionNumber: null },
            { nodeId: 'a3', nodeLabel: 'Unfinished', agentSlug: null, versionNumber: null },
          ],
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: /pins/i });
    expect(trigger.textContent).toContain('3');
    fireEvent.click(trigger);
    const rail = screen.getByRole('dialog');
    expect(within(rail).getByText('discharge-agent')).toBeTruthy();
    expect(within(rail).getByText('v4')).toBeTruthy();
    expect(within(rail).getByText('extract-agent')).toBeTruthy();
    expect(within(rail).getByText('Active at publish')).toBeTruthy();
    expect(within(rail).getByText('No agent chosen')).toBeTruthy();
    expect(within(rail).getAllByText(/pinned with the agent/i).length).toBeGreaterThan(0);
  });

  it('explains an empty Pins rail', () => {
    render(<StudioHeader {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /pins/i }));
    expect(screen.getByText(/no agent steps/i)).toBeTruthy();
  });

  it('opens Settings', () => {
    const onOpenSettings = vi.fn();
    render(<StudioHeader {...props({ onOpenSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('StudioHeader — validate and publish', () => {
  it('disables Publish and shows WHY while the server report is not clean', () => {
    const onPublish = vi.fn();
    render(<StudioHeader {...props({ publishDisabledReason: 'Run Validate before publishing.', onPublish })} />);
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(screen.getByText('Run Validate before publishing.')).toBeTruthy();
    fireEvent.click(publish);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('enables Publish with no reason shown once the caller reports a clean server report', () => {
    const onPublish = vi.fn();
    render(<StudioHeader {...props({ onPublish })} />);
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('Validate calls through and shows its in-flight state', () => {
    const onValidate = vi.fn();
    const { rerender } = render(<StudioHeader {...props({ onValidate })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(onValidate).toHaveBeenCalledTimes(1);
    rerender(<StudioHeader {...props({ onValidate, validating: true })} />);
    expect((screen.getByRole('button', { name: 'Validating…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers neither on a read-only version', () => {
    render(<StudioHeader {...props({ readOnly: true, status: 'PUBLISHED' })} />);
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('renders the caller-supplied actions slot', () => {
    render(<StudioHeader {...props({ actions: <button type="button">Switch workflow</button> })} />);
    expect(screen.getByRole('button', { name: 'Switch workflow' })).toBeTruthy();
  });
});

describe('StudioHeader — a11y', () => {
  it('0 axe violations', async () => {
    const { container } = render(
      <StudioHeader {...props({ publishDisabledReason: 'Resolve every error before publishing.', pins: [{ nodeId: 'a1', nodeLabel: 'S', agentSlug: 'x', versionNumber: 2 }] })} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('collectAgentPins', () => {
  it('reads one pin per core.agent node and ignores every other node type', () => {
    const pins = collectAgentPins([
      { id: 'n1', type: 'core.agent', config: { label: 'Summarize', agentRef: { slug: 'discharge-agent', versionNumber: 4 } } },
      { id: 'n2', type: 'core.agent', config: { agentRef: { slug: 'extract-agent' } } },
      { id: 'n3', type: 'core.agent', config: {} },
      { id: 'n4', type: 'core.note', config: { agentRef: { slug: 'ignored' } } },
    ]);
    expect(pins).toEqual([
      { nodeId: 'n1', nodeLabel: 'Summarize', agentSlug: 'discharge-agent', versionNumber: 4 },
      expect.objectContaining({ nodeId: 'n2', agentSlug: 'extract-agent', versionNumber: null }),
      expect.objectContaining({ nodeId: 'n3', agentSlug: null, versionNumber: null }),
    ]);
  });
});
