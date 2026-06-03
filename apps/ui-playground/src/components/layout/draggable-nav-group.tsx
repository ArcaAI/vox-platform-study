import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@arcaai/ui/sidebar';
import { Sortable, SortableContent, SortableItem, SortableItemHandle } from '@arcaai/ui/sortable';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { GripVertical } from 'lucide-react';
import { NavGroup, type NavItem } from './nav-group';

/** A nav item that participates in drag-reordering — `id` is required. */
export type DraggableNavItem = NavItem & { id: string };

interface DraggableNavGroupProps {
  label: string;
  items: DraggableNavItem[];
  /** Called with the full ordered id list after a successful drop. */
  onReorder: (orderedIds: string[]) => void;
}

/**
 * DraggableNavGroup — TASK-327 T3.
 *
 * A sidebar group whose items can be reordered by dragging. Built on the
 * shared @arcaai/ui diceui Sortable primitives (D2) — NOT a fresh @dnd-kit
 * dependency. On drop it emits the new id order via `onReorder` (the caller
 * persists it through `useAdminPreferences`, which is optimistic).
 *
 * The sidebar collapses to an icon rail; there is no room for a drag handle
 * there, so when collapsed we render the plain, non-draggable NavGroup.
 */
export function DraggableNavGroup({ label, items, onReorder }: DraggableNavGroupProps) {
  const matchRoute = useMatchRoute();
  const { state, isMobile } = useSidebar();

  const collapsed = state === 'collapsed' && !isMobile;
  if (collapsed) {
    return <NavGroup label={label} items={items} />;
  }

  const handleValueChange = (next: DraggableNavItem[]) => {
    onReorder(next.map((i) => i.id));
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <Sortable value={items} getItemValue={(item) => item.id} onValueChange={handleValueChange} orientation="vertical">
          <SortableContent asChild>
            <SidebarMenu>
              {items.map((item) => {
                const active = !!matchRoute({ to: item.url, fuzzy: item.url !== '/' });
                return (
                  <SortableItem key={item.id} value={item.id} asChild>
                    <SidebarMenuItem>
                      {item.disabled ? (
                        <SidebarMenuButton
                          tooltip={item.disabledReason ?? item.title}
                          aria-disabled
                          title={item.disabledReason}
                          className="cursor-not-allowed opacity-50"
                          onClick={(e) => e.preventDefault()}
                        >
                          {item.icon && <item.icon className="size-4" />}
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton asChild tooltip={item.title} isActive={active}>
                          <Link to={item.url}>
                            {item.icon && <item.icon className="size-4" />}
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      )}
                      {item.badge && !item.disabled && (
                        <SidebarMenuBadge className="bg-primary/10 text-primary text-[10px] font-semibold transition-opacity group-hover/menu-item:opacity-0">
                          {item.badge}
                        </SidebarMenuBadge>
                      )}
                      <SortableItemHandle asChild>
                        <button
                          type="button"
                          aria-label={`Reorder ${item.title}`}
                          className="text-muted-foreground hover:text-foreground absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity group-hover/menu-item:opacity-100 focus-visible:opacity-100"
                        >
                          <GripVertical className="size-3.5" />
                        </button>
                      </SortableItemHandle>
                    </SidebarMenuItem>
                  </SortableItem>
                );
              })}
            </SidebarMenu>
          </SortableContent>
        </Sortable>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
