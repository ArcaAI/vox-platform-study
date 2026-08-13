import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { TenantFilter, type TenantOption } from '../tenant-filter';

expect.extend(axeMatchers);

// cmdk's CommandList instantiates a ResizeObserver that happy-dom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const TENANTS: TenantOption[] = [
  { id: 't1', name: 'Radiology Partners', key: 'RAD' },
  { id: 't2', name: 'Cardiology Group', key: 'CARD' },
  { id: 't3', name: 'Neurology Clinic', key: 'NEU' },
];

function trigger() {
  return screen.getByTestId('tenant-filter-trigger');
}
function open() {
  fireEvent.click(trigger());
}
function optionEls() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

describe('TenantFilter', () => {
  it('renders a ≥44px combobox trigger that shows the current tenant name', () => {
    render(<TenantFilter tenants={TENANTS} value="t2" onChange={vi.fn()} />);
    const t = trigger();
    expect(t).toHaveAttribute('role', 'combobox');
    expect(t.className).toContain('min-h-11'); // ≥44px target
    expect(t).toHaveTextContent('Cardiology Group');
  });

  it('shows "All tenants" only when allowAll', () => {
    // The trigger label can also read "All tenants" (value=null), so scope to the listbox option.
    const { unmount } = render(<TenantFilter tenants={TENANTS} value={null} onChange={vi.fn()} allowAll />);
    open();
    expect(screen.getByRole('option', { name: /all tenants/i })).toBeInTheDocument();
    unmount();

    render(<TenantFilter tenants={TENANTS} value="t1" onChange={vi.fn()} />);
    open();
    expect(screen.queryByRole('option', { name: /all tenants/i })).not.toBeInTheDocument();
  });

  it('emits the tenant id on select, and null for "All tenants"', () => {
    const onChange = vi.fn();
    render(<TenantFilter tenants={TENANTS} value={null} onChange={onChange} allowAll />);
    open();
    fireEvent.click(screen.getByText('Neurology Clinic'));
    expect(onChange).toHaveBeenLastCalledWith('t3');

    open();
    fireEvent.click(screen.getByRole('option', { name: /all tenants/i }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('search filters the list (name or key)', async () => {
    render(<TenantFilter tenants={TENANTS} value={null} onChange={vi.fn()} allowAll />);
    open();
    const search = screen.getByPlaceholderText(/search tenants/i);
    fireEvent.change(search, { target: { value: 'Radio' } });
    await waitFor(() => {
      expect(screen.getByText('Radiology Partners')).toBeInTheDocument();
      expect(screen.queryByText('Cardiology Group')).not.toBeInTheDocument();
    });
  });

  it('marks the current selection with a check (✓)', () => {
    render(<TenantFilter tenants={TENANTS} value="t2" onChange={vi.fn()} allowAll />);
    open();
    const active = document.querySelector('[data-tenant-id="t2"]')!;
    expect(active).toHaveAttribute('data-active', 'true');
    expect(active.querySelector('[data-slot="tenant-filter-check"]')).toBeTruthy();
    // a non-selected row is not marked active
    expect(document.querySelector('[data-tenant-id="t1"]')).toHaveAttribute('data-active', 'false');
  });

  it('disabled state locks the selection (no popover, no onChange)', () => {
    const onChange = vi.fn();
    render(<TenantFilter tenants={TENANTS} value="t1" onChange={onChange} disabled />);
    const t = trigger();
    expect(t).toBeDisabled();
    fireEvent.click(t);
    expect(screen.queryByPlaceholderText(/search tenants/i)).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(t).toHaveTextContent('Radiology Partners');
  });

  it('renders a skeleton while loading (no interactive combobox)', () => {
    render(<TenantFilter tenants={[]} value={null} onChange={vi.fn()} isLoading />);
    expect(screen.getByTestId('tenant-filter-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders the tenant key in a monospace font', () => {
    render(<TenantFilter tenants={TENANTS} value={null} onChange={vi.fn()} allowAll />);
    open();
    const key = optionEls()
      .map((el) => el.querySelector('[data-slot="tenant-filter-key"]'))
      .find((k) => k?.textContent === 'RAD');
    expect(key).toBeTruthy();
    expect(key!.className).toContain('font-mono');
  });

  it('has no axe violations (collapsed)', async () => {
    const { container } = render(<TenantFilter tenants={TENANTS} value="t1" onChange={vi.fn()} allowAll />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
