/**
 * TASK-327 T3 — DraggableNavGroup.
 *
 * The diceui Sortable + the sidebar primitives are stubbed by the global
 * vitest config (`@arcaai/ui/*`), and real drag-and-drop can't run in jsdom,
 * so we mock `@arcaai/ui/sortable` with a harness that lets us fire
 * `onValueChange` with a reordered array. The contract under test: a drop
 * emits exactly one `onReorder` call carrying the NEW id order.
 */
import { fireEvent, render, screen } from '@testing-library/react';

const sidebarState = vi.hoisted(() => ({ state: 'expanded' as 'expanded' | 'collapsed', isMobile: false }));

vi.mock('@arcaai/ui/sidebar', () => ({
  useSidebar: () => sidebarState,
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: any) => <div>{children}</div>,
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: any) => <>{children}</>,
  SidebarMenuBadge: ({ children }: any) => <span>{children}</span>,
  SidebarMenuSub: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuSubButton: ({ children }: any) => <>{children}</>,
  SidebarMenuSubItem: ({ children }: any) => <li>{children}</li>,
}));

vi.mock('@arcaai/ui/sortable', () => ({
  // Render a button that reverses the current value and hands it back through
  // onValueChange — emulating a completed drag/drop reorder.
  Sortable: ({ value, onValueChange, children }: any) => (
    <div data-testid="sortable">
      <button data-testid="do-reorder" onClick={() => onValueChange?.([...value].reverse())}>
        reorder
      </button>
      {children}
    </div>
  ),
  SortableContent: ({ children }: any) => <div>{children}</div>,
  SortableItem: ({ children }: any) => <>{children}</>,
  SortableItemHandle: ({ children }: any) => <>{children}</>,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: any) => <a href={to}>{children}</a>,
  useMatchRoute: () => () => false,
  useLocation: () => ({ pathname: '/' }),
}));

import { DraggableNavGroup, type DraggableNavItem } from '../draggable-nav-group';

const items: DraggableNavItem[] = [
  { id: 'tenants', title: 'Tenants', url: '/admin/tenants' },
  { id: 'users', title: 'Users', url: '/admin/users' },
  { id: 'prompts', title: 'Prompts', url: '/admin/prompts' },
];

describe('DraggableNavGroup (TASK-327 T3)', () => {
  beforeEach(() => {
    sidebarState.state = 'expanded';
    sidebarState.isMobile = false;
  });

  it('renders all items with a reorder handle when expanded', () => {
    render(<DraggableNavGroup label="Administration" items={items} onReorder={vi.fn()} />);
    expect(screen.getByText('Tenants')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByLabelText('Reorder Tenants')).toBeInTheDocument();
  });

  it('fires onReorder exactly once with the new id order on drop', () => {
    const onReorder = vi.fn();
    render(<DraggableNavGroup label="Administration" items={items} onReorder={onReorder} />);

    fireEvent.click(screen.getByTestId('do-reorder'));

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['prompts', 'users', 'tenants']);
  });

  it('renders a plain (non-draggable) group with no handles when collapsed', () => {
    sidebarState.state = 'collapsed';
    render(<DraggableNavGroup label="Administration" items={items} onReorder={vi.fn()} />);
    expect(screen.getByText('Tenants')).toBeInTheDocument();
    expect(screen.queryByTestId('sortable')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reorder Tenants')).not.toBeInTheDocument();
  });
});
