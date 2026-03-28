import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@arcaai/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@arcaai/ui/collapsible';
import { ChevronRight } from 'lucide-react';
import { Link, useLocation, useMatchRoute } from '@tanstack/react-router';

export interface NavItem {
  title: string;
  url: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: string;
  children?: { title: string; url: string }[];
}

interface NavGroupProps {
  label: string;
  items: NavItem[];
}

export function NavGroup({ label, items }: NavGroupProps) {
  const matchRoute = useMatchRoute();
  const { pathname } = useLocation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) =>
            item.children ? (
              <Collapsible key={item.title} asChild defaultOpen>
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton tooltip={item.title}>
                      {item.icon && <item.icon className="size-4" />}
                      <span>{item.title}</span>
                      <ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.children.map((sub) => {
                        const isIndex = sub.url === item.url;
                        const active = isIndex ? pathname === sub.url || pathname === sub.url + '/' : !!matchRoute({ to: sub.url, fuzzy: true });
                        return (
                          <SidebarMenuSubItem key={sub.url}>
                            <SidebarMenuSubButton asChild isActive={active}>
                              <Link to={sub.url}>
                                <span>{sub.title}</span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            ) : (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild tooltip={item.title} isActive={!!matchRoute({ to: item.url, fuzzy: item.url !== '/' })}>
                  <Link to={item.url}>
                    {item.icon && <item.icon className="size-4" />}
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
                {item.badge && <SidebarMenuBadge className="bg-primary/10 text-primary text-[10px] font-semibold">{item.badge}</SidebarMenuBadge>}
              </SidebarMenuItem>
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
