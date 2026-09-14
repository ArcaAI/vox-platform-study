/**
 * TASK-974 §4.7 (D-1) — `AgentHiddenBadge` renders "Hidden · platform" (with an explanatory
 * tooltip) only for a platform service agent (`Agent.hidden === true`, e.g. the SYSTEM-tenant
 * `dna-writing-style-analyst`); it renders nothing for an ordinary tenant agent.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentHiddenBadge } from '../agent-status-badge';

afterEach(cleanup);

describe('AgentHiddenBadge', () => {
  it('renders "Hidden · platform" with an explanatory tooltip when the agent is hidden', () => {
    render(<AgentHiddenBadge hidden />);
    const badge = screen.getByText('Hidden · platform');
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('title')).toMatch(/never cloned to tenants|not listed or invokable/i);
  });

  it('renders nothing when the agent is not hidden', () => {
    const { container } = render(<AgentHiddenBadge hidden={false} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when `hidden` is absent (every ordinary tenant agent)', () => {
    const { container } = render(<AgentHiddenBadge />);
    expect(container.textContent).toBe('');
  });
});
