/**
 * TASK-1036 OD-21 — deprecating an agent version warns that PUBLISHED workflows pinned to it keep
 * running it. No route answers "which workflows pin this version" without reading every graph,
 * so the warning is stated without a count (the report lists it as an open item).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AgentDeprecateDialog } from '../agent-deprecate-dialog';

afterEach(cleanup);

const BASE = {
  open: true,
  onOpenChange: () => undefined,
  itemLabel: 'Clinic summary',
  slug: 'clinic-summary',
  versionNumber: 3,
  isPending: false,
  onConfirm: vi.fn(),
};

describe('AgentDeprecateDialog', () => {
  it('warns that published workflows pinned to the version keep running it', () => {
    render(<AgentDeprecateDialog {...BASE} isActive={false} />);
    const warning = screen.getByText(/keep running v3/i);
    expect(warning.textContent).toMatch(/published workflow/i);
    expect(warning.textContent).toMatch(/Workflow Studio/);
  });

  it('keeps the active-version consequences and its type-to-confirm', () => {
    render(<AgentDeprecateDialog {...BASE} isActive assignment={{ tenantDefault: true, departmentCount: 2, selectorCount: 0 }} />);
    expect(screen.getByText(/will stop resolving/i)).toBeTruthy();
    expect(screen.getByText(/2 department assignments/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Deprecate v3' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'clinic-summary' } });
    expect((screen.getByRole('button', { name: 'Deprecate v3' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('an inactive version needs no typing and confirms', () => {
    const onConfirm = vi.fn();
    render(<AgentDeprecateDialog {...BASE} isActive={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate v3' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    render(<AgentDeprecateDialog {...BASE} isActive />);
    expect(await axe(screen.getByRole('alertdialog'))).toHaveNoViolations();
  });
});
