import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import { Stethoscope } from 'lucide-react';

import { CardGrid } from '../card-grid';
import { EntityCard } from '../entity-card';

expect.extend(axeMatchers);

interface Dept {
  id: string;
  name: string;
  code: string;
}

const DEPTS: Dept[] = [
  { id: 'card', name: 'Cardiology', code: 'CARD' },
  { id: 'rad', name: 'Radiology', code: 'RAD' },
  { id: 'gen', name: 'General Medicine', code: 'GEN' },
];

function renderGrid(props: Partial<React.ComponentProps<typeof CardGrid<Dept>>> = {}) {
  return render(
    <CardGrid<Dept>
      items={DEPTS}
      getItemId={(d) => d.id}
      aria-label="Departments"
      renderCard={(d, { selected }) => (
        <EntityCard
          title={d.name}
          icon={Stethoscope}
          meta={d.code}
          status={{ label: 'Enabled', colorRole: 'success' }}
          selected={selected}
        />
      )}
      {...props}
    />,
  );
}

describe('EntityCard', () => {
  it('renders title, meta and a status badge (never color-only)', () => {
    render(<EntityCard title="Cardiology" meta="CARD" status={{ label: 'Enabled', colorRole: 'success' }} />);
    expect(screen.getByText('Cardiology')).toBeInTheDocument();
    expect(screen.getByText('CARD')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('reflects selected + density via data attributes', () => {
    const { container } = render(<EntityCard title="Cardiology" selected density="compact" />);
    const card = container.querySelector('[data-slot="entity-card"]')!;
    expect(card).toHaveAttribute('data-state', 'selected');
    expect(card).toHaveAttribute('data-density', 'compact');
  });
});

describe('CardGrid (§4a.1)', () => {
  it('renders one gridcell per item', () => {
    renderGrid();
    expect(screen.getAllByRole('gridcell')).toHaveLength(3);
    expect(screen.getByText('Cardiology')).toBeInTheDocument();
    expect(screen.getByText('General Medicine')).toBeInTheDocument();
  });

  it('selects via click and via keyboard (Enter / Space)', () => {
    const onSelect = vi.fn();
    renderGrid({ onSelect });
    const cells = screen.getAllByRole('gridcell');
    fireEvent.click(cells[0]);
    expect(onSelect).toHaveBeenLastCalledWith('card');
    fireEvent.keyDown(cells[1], { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('rad');
    fireEvent.keyDown(cells[2], { key: ' ' });
    expect(onSelect).toHaveBeenLastCalledWith('gen');
  });

  it('reflects selectedId via aria-selected', () => {
    renderGrid({ onSelect: vi.fn(), selectedId: 'rad' });
    const cells = screen.getAllByRole('gridcell');
    expect(cells[0]).toHaveAttribute('aria-selected', 'false');
    expect(cells[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('moves focus with arrow keys (roving tabindex)', () => {
    renderGrid({ onSelect: vi.fn() });
    const cells = screen.getAllByRole('gridcell');
    cells[0].focus();
    expect(cells[0]).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(cells[0], { key: 'ArrowRight' });
    expect(cells[1]).toHaveFocus();
    expect(cells[1]).toHaveAttribute('tabindex', '0');
    expect(cells[0]).toHaveAttribute('tabindex', '-1');
  });

  it('shows a skeleton grid while loading', () => {
    renderGrid({ items: [], isLoading: true });
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
  });

  it('shows the Empty state when there are no items', () => {
    const { container } = renderGrid({ items: [] });
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
  });

  it('applies the density attribute', () => {
    const { container } = renderGrid({ density: 'compact' });
    expect(container.querySelector('[data-slot="card-grid"]')).toHaveAttribute('data-density', 'compact');
  });

  it('applies the responsive auto-fill column-width style', () => {
    const { container } = renderGrid({ minColumnWidth: 320 });
    const root = container.querySelector('[data-slot="card-grid"]') as HTMLElement;
    expect(root.style.gridTemplateColumns).toContain('320px');
    expect(root.style.gridTemplateColumns).toContain('auto-fill');
  });

  it('has no axe violations', async () => {
    const { container } = renderGrid({ onSelect: vi.fn(), selectedId: 'card' });
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
